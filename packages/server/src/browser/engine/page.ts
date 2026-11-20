// 一个页面句柄：把 Playwright 的 Page 包成上层用的 PageHandle。
// 快照与动作都基于 ariaSnapshot 的元素编号（aria-ref），动作前先探活，避免干等默认的 30 秒。
import type {
  BrowserContext,
  CDPSession,
  Locator,
  Page,
  Response,
} from "playwright-core";
import { fetchAssets, listAssets } from "./assets.js";
import { PageCdp } from "./cdp.js";
import { readCopied } from "./clipboard.js";
import {
  ConsoleBuffer,
  firstFrame,
  locationUrl,
  redactText,
  redactUrl,
} from "./console.js";
import {
  pendingSince,
  SCROLL_SETTLE_MS,
  waitForContent,
  watchAdditions,
} from "./content-wait.js";
import { watchDialogs } from "./dialog.js";
import { readDom } from "./dom.js";
import { wrapDownload } from "./download.js";
import { Emulation } from "./emulate.js";
import { runScript } from "./exec.js";
import { describeSrc, imageRefs, injectImageSources } from "./img-src.js";
import { watchNetwork } from "./net-watch.js";
import { needRef, STALE } from "./ref.js";
import type { RequestJars } from "./request.js";
import { watchRoutes } from "./route.js";
import { type Screencast, startScreencast } from "./screencast.js";
import {
  readCookies,
  readWebStorage,
  removeCookies,
  writeCookie,
} from "./storage.js";
import type {
  ClickOptions,
  ConsoleEntry,
  InputEvent,
  PageDownload,
  PageFileChooser,
  PageHandle,
  PointTarget,
  ScrollPos,
  TypeOptions,
} from "./types.js";
import { VIEWPORT } from "./types.js";

const GOTO_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;
const SETTLE_TIMEOUT_MS = 3_000;
// 打开会触发下载的地址时，等 download 事件派发完再返回：它总在 page.goto 抛错之后才到（实测 1–7ms）。
const GOTO_DOWNLOAD_WAIT_MS = 1000;
const GOTO_DOWNLOAD_POLL_MS = 20;
// 整页截图的高度上限：只防极端页面，超出的部分不截。
const FULLPAGE_MAX_HEIGHT = 30_000;
const BLANK = "about:blank";
const NO_MOUSE = "还没有鼠标位置：先用 browser_move 移动鼠标，或者给 ref、坐标";
const NO_DRAG_POS = "拖动的起点或终点不在视口内，先滚动到位";
// 动作被对话框打断时的兜底滚动静止位置（页面卡死，读不到真位置）。
const ZERO_SCROLL: ScrollPos = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  viewWidth: VIEWPORT.width,
  viewHeight: VIEWPORT.height,
};

// 图片地址分批并行读：每批这么多个，不设总数上限。
const IMG_SRC_BATCH = 50;

/**
 * 在页面里取当前选区的文字（含输入框里选的）。会被序列化进浏览器执行，只能引用 DOM。
 * 选区跟着文档走，且焦点移走后旧文档里的选区还留着：只认焦点所在的那个文档
 * （有焦点，且焦点不在它的 iframe 里；在 iframe 里说明焦点还要往里一层）。
 */
export function selectedText(): string {
  const g = globalThis as unknown as {
    document: {
      hasFocus(): boolean;
      activeElement: { tagName: string } | null;
    };
    getSelection(): { toString(): string } | null;
  };
  if (!g.document.hasFocus() || g.document.activeElement?.tagName === "IFRAME")
    return "";
  return g.getSelection()?.toString() ?? "";
}

// 浏览器里的 DOM 形状（server 的 tsconfig 不含 dom 库）。
interface DomFileInput {
  tagName: string;
  type: string | null;
}

/** ref 指到的元素是不是 `<input type=file>` 本身。同样会被序列化进浏览器执行。 */
export function isFileInput(el: DomFileInput | undefined): boolean {
  return el?.tagName === "INPUT" && el.type === "file";
}

/** 下拉框的一个选项（label 已由浏览器回退到文本）。 */
export interface SelectOptionInfo {
  value: string;
  label: string;
  disabled: boolean;
}

// 浏览器里的形状（server 的 tsconfig 不含 dom 库）。
interface DomSelect {
  tagName: string;
  multiple: boolean;
  options: ArrayLike<SelectOptionInfo>;
}

/** 在页面里读出下拉框的选项；不是下拉框就是 null。会被序列化进浏览器执行，只能引用参数。 */
export function readSelect(el: DomSelect | undefined): {
  multiple: boolean;
  options: SelectOptionInfo[];
} | null {
  if (el?.tagName !== "SELECT") return null;
  const options: SelectOptionInfo[] = [];
  for (const o of Array.from(el.options))
    options.push({ value: o.value, label: o.label, disabled: o.disabled });
  return { multiple: el.multiple, options };
}

/** 文档的完整尺寸（宽 = scrollWidth，高 = documentElement 与 body 的 scrollHeight 取大）。会被序列化进浏览器执行。 */
export function pageSize(): { width: number; height: number } {
  const doc = (
    globalThis as unknown as {
      document: {
        documentElement: { scrollWidth: number; scrollHeight: number };
        body: { scrollWidth: number; scrollHeight: number } | null;
      };
    }
  ).document;
  const body = doc.body;
  return {
    width: Math.max(doc.documentElement.scrollWidth, body?.scrollWidth ?? 0),
    height: Math.max(doc.documentElement.scrollHeight, body?.scrollHeight ?? 0),
  };
}

// 取当前滚动位置的表达式：写成字符串在页面里跑，避开 tsconfig 没有 dom 库的问题。
const SCROLL_POS = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  return {
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    width: doc.scrollWidth,
    height: doc.scrollHeight,
    viewWidth: window.innerWidth,
    viewHeight: window.innerHeight,
  };
})()`;

// 读 aria-ref 指到的元素此刻的图片地址：字符串表达式在页面里跑（tsconfig 没有 dom 库），
// 再转成函数，Playwright 把元素作为参数交进来。非 <img>（svg / div 的 role=img）没有地址。
const IMG_SRC = new Function(
  "el",
  `if (!el || el.tagName !== "IMG") return "";
   return el.currentSrc || el.getAttribute("src") || "";`,
) as (el: unknown) => string;

const noop = () => {};

/** 报「没有匹配的选项」时最多列这么多个。 */
const OPTION_LIST_MAX = 30;

/** 选项列表的一句话：label 空的写「（空）」，超过上限只列前 30 个。 */
function optionText(options: SelectOptionInfo[]): string {
  const shown = options
    .slice(0, OPTION_LIST_MAX)
    .map((o) => (o.label === "" ? "（空）" : o.label));
  const head = shown.join("、");
  return options.length > OPTION_LIST_MAX
    ? `${head}…等共 ${options.length} 个`
    : head;
}

// 导航失败的原因翻成人话。
export function explain(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (m.includes("ERR_NAME_NOT_RESOLVED")) return "无法解析域名";
  if (m.includes("ERR_CONNECTION_REFUSED")) return "连接被拒绝";
  if (m.includes("ERR_CERT")) return "证书不受信任";
  if (m.includes("ERR_UNSAFE_PORT")) return "该端口不允许浏览器访问";
  // 出站代理拒绝 HTTPS（CONNECT）时浏览器只报隧道失败，读不到拒绝原因
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(m))
    return "代理没能连上目标：内网、回环等地址默认不允许访问（本机 DNS 把域名解析成保留网段地址时也会这样），也可能是目标不可达";
  if (/timeout/i.test(m)) return `加载超时（${GOTO_TIMEOUT_MS / 1000} 秒）`;
  return firstLine(m);
}

function firstLine(m: string): string {
  return (
    m
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? m
  );
}

const actionError = (what: string) => (err: unknown) =>
  new Error(
    `${what}失败：${firstLine(err instanceof Error ? err.message : String(err))}`,
  );

/** 下拉框要选的选项：多选按换行拆成多项，每项先按 label 再按 value 精确匹配。 */
async function selectOption(
  locator: Locator,
  select: { multiple: boolean; options: SelectOptionInfo[] },
  ref: string,
  text: string,
): Promise<string[]> {
  const wanted = select.multiple ? text.split("\n") : [text];
  const values: string[] = [];
  const labels: string[] = [];
  for (const want of wanted) {
    const hit =
      select.options.find((o) => o.label === want) ??
      select.options.find((o) => o.value === want);
    // 没匹配上时不能调 selectOption：它会一直等到超时。
    if (hit === undefined)
      throw new Error(
        `下拉框 ${ref} 里没有匹配「${want}」的选项。可选：${optionText(select.options)}`,
      );
    if (hit.disabled) throw new Error(`选项「${want}」被禁用，选不了`);
    values.push(hit.value);
    labels.push(hit.label);
  }
  // selectOption 本身会触发 input / change。
  await locator.selectOption(values, { timeout: ACTION_TIMEOUT_MS });
  return labels;
}

/**
 * 交文件和设文件输入框共用的 Playwright 负载：mimeType 留空串，Playwright 会按扩展名推断，
 * 推不出才是 application/octet-stream。
 */
function filePayloads(files: { name: string; buffer: Buffer }[]) {
  return files.map((f) => ({ name: f.name, mimeType: "", buffer: f.buffer }));
}

/** Playwright 交文件时的报错翻成中文；认不出的走「上传失败：…」。 */
function explainFileError(err: unknown): Error {
  const msg = firstLine(err instanceof Error ? err.message : String(err));
  // Playwright 在两个路径上的报错原文相同：只收一个文件的入口拿到多个文件。
  if (msg.includes("Non-multiple file input can only accept single file"))
    return new Error("这个上传入口只接受一个文件");
  if (msg.includes("larger than 50Mb"))
    return new Error("文件合计超过 50 MB，浏览器一次接收不了");
  if (msg.includes('waiting for event "filechooser"'))
    return new Error("点击后没有出现文件选择框，这个元素可能不是上传入口");
  return actionError("上传")(err);
}

const LEVEL: Record<string, ConsoleEntry["level"]> = {
  log: "log",
  info: "info",
  warning: "warn",
  warn: "warn",
  error: "error",
  debug: "debug",
};

export function wrapPage(
  page: Page,
  ctx: BrowserContext,
  jars: RequestJars,
  opener: PageHandle | null,
): PageHandle {
  const buffer = new ConsoleBuffer(500);
  const net = watchNetwork(page);
  const routes = watchRoutes(page);
  const dialogs = watchDialogs(page);
  // 环境模拟与 browser_cdp 共用一个长存的页面级 CDP 会话：覆盖跟着会话走，会话断了就失效。
  const pageCdp = new PageCdp(page);
  const emu = new Emulation(page, pageCdp);
  const changes = new Set<() => void>();
  const closers = new Set<() => void>();
  const downloadSubs = new Set<(d: PageDownload) => void>();
  const chooserSubs = new Set<(c: PageFileChooser) => void>();
  // goto 正在导航、且刚到的下载已经派发出去（页面关闭时置 null）。
  let navTaken: { taken: boolean } | null = null;
  const fire = () => {
    for (const cb of changes) cb();
  };

  let loading = false;
  let title = "";
  let titleTimer: NodeJS.Timeout | null = null;
  let cast: Screencast | null = null;
  // 鼠标位置是页面级的持续状态：初始未知，主框架整页导航之后清空（页内跳转不清）。
  let mouse: { x: number; y: number } | null = null;
  // 取历史用的 CDP 会话：每个页面惰性建一次并缓存，页面关闭时 detach。
  let cdp: CDPSession | null = null;

  // 标题变化也通知（SPA 换标题不会触发导航事件）；只在有人订阅时轮询，别空转。
  const syncTitle = async () => {
    const t = await page.title().catch(() => "");
    if (t === title) return;
    title = t;
    fire();
  };
  const startTitlePoll = () => {
    if (titleTimer) return;
    titleTimer = setInterval(() => void syncTitle(), 1000);
    titleTimer.unref();
  };
  const stopTitlePoll = () => {
    if (!titleTimer) return;
    clearInterval(titleTimer);
    titleTimer = null;
  };

  page.on("console", (msg) => {
    buffer.push({
      ts: Date.now(),
      kind: "console",
      level: LEVEL[msg.type()] ?? "log",
      text: redactText(msg.text()),
      url: locationUrl(msg.location().url, msg.location().lineNumber + 1),
    });
  });
  page.on("pageerror", (err) => {
    // 补上栈第一帧的位置（行列号只留行；地址由 locationUrl 打码，解析不出就当没有）。
    const at = firstFrame(err.stack);
    buffer.push({
      ts: Date.now(),
      kind: "error",
      level: "error",
      text: redactText(err.message),
      ...(at ? { url: locationUrl(at.url, at.line) } : {}),
    });
  });
  page.on("requestfailed", (req) => {
    buffer.push({
      ts: Date.now(),
      kind: "request-failed",
      level: "error",
      text: req.failure()?.errorText ?? "请求失败",
      url: redactUrl(req.url()),
    });
    // 主框架的导航请求失败也要把加载状态收回来，否则界面一直转圈。
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      loading = false;
      fire();
    }
  });

  // 页面里开始的下载：包成 PageDownload 交给订阅者；没有人接手就直接取消（只在控制台留一条记录）。
  page.on("download", (d) => {
    const note = (text: string) =>
      buffer.push({ ts: Date.now(), kind: "console", level: "warn", text });
    const pd = wrapDownload(d, note);
    if (navTaken) navTaken.taken = true;
    if (downloadSubs.size === 0) {
      void pd.cancel("没有人处理下载");
      return;
    }
    for (const cb of [...downloadSubs]) cb(pd);
  });

  page.on("filechooser", (fc) => {
    // 没有订阅者（或没人交文件）就当成用户取消了这一选择：选择框自己失效，页面保持原样。
    const chooser: PageFileChooser = {
      multiple: fc.isMultiple(),
      async setFiles(files) {
        try {
          await fc.setFiles(filePayloads(files));
        } catch (err) {
          throw explainFileError(err);
        }
      },
    };
    for (const cb of [...chooserSubs]) cb(chooser);
  });

  page.on("request", (req) => {
    if (!req.isNavigationRequest()) return;
    if (req.frame() !== page.mainFrame()) return;
    mouse = null;
    loading = true;
    fire();
  });
  page.on("load", () => {
    loading = false;
    void syncTitle();
    fire();
  });
  page.on("domcontentloaded", () => {
    void syncTitle();
    fire();
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    // 不在这里置 loading：页内跳转（pushState、锚点）也会触发它，却没有 load 事件收尾；
    // 真正的整页导航由 request 事件置位。
    void syncTitle();
    fire();
  });
  page.on("close", () => {
    stopTitlePoll();
    const c = cast;
    cast = null;
    void c?.stop();
    const session = cdp;
    cdp = null;
    void session?.detach().catch(noop);
    for (const cb of closers) cb();
    closers.clear();
    changes.clear();
    downloadSubs.clear();
    chooserSubs.clear();
    navTaken = null;
  });

  // 动作后短等，让快照稳定；超时或页面没在导航都直接放过。
  const settle = () =>
    page.waitForLoadState("load", { timeout: SETTLE_TIMEOUT_MS }).catch(noop);

  const live = async (ref: string) => {
    needRef(ref);
    if ((await page.locator(`aria-ref=${ref}`).count()) === 0)
      throw new Error(STALE);
  };

  // 元素位置现查不缓存：滚到可见处再取包围盒中心；没有可见盒（隐藏）就是没有位置。
  const centerOf = async (ref: string) => {
    await live(ref);
    const locator = page.locator(`aria-ref=${ref}`);
    const box = await locator
      .scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
      .then(() => locator.boundingBox())
      .catch((err) => {
        throw actionError("定位")(err);
      });
    if (!box) throw new Error("该元素不可见，没有位置");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  /** 位置目标 → 视口坐标：ref 走 centerOf，坐标直接用。 */
  const pointOf = async (target: PointTarget) =>
    "ref" in target ? centerOf(target.ref) : target;

  const history = async () => {
    cdp ??= await ctx.newCDPSession(page);
    return (await cdp.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: { url: string }[];
    };
  };

  const clickOpts = (opts?: ClickOptions) => ({
    clickCount: opts?.count ?? 1,
    button: opts?.button ?? "left",
  });

  const stopScreencast = async () => {
    const c = cast;
    cast = null;
    if (c) await c.stop();
  };

  const handle: PageHandle = {
    opener,
    url: () => page.url(),
    title: () => page.title().catch(() => ""),
    loading: () => loading,
    async goto(url) {
      return dialogs.interrupted(
        async () => {
          loading = true;
          // 导航到会变成下载的地址（Content-Disposition: attachment，或 pdf / zip 这类不内嵌显示的类型）时，
          // Playwright 的 page.goto 会抛 `page.goto: Download is starting`（实测；不是 net::ERR_ABORTED）。
          // download 事件总比它晚一步（实测 1–7ms），所以不能当成「打开失败」：等事件派发完再返回。
          const trace = { taken: false };
          navTaken = trace;
          try {
            const res: Response | null = await page.goto(url, {
              waitUntil: "load",
              timeout: GOTO_TIMEOUT_MS,
            });
            const deny = res?.headers()["x-yuanshu-deny"] ?? null;
            return { status: res?.status() ?? null, deny };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("Download is starting"))
              throw new Error(`打开失败：${explain(err)}`);
            // 等 download 事件派发完再返回：实测它总比 page.goto 抛错晚 1–7ms。
            // 没有人订阅时事件处理里当场就取消并置位，这里不会白等。
            const deadline = Date.now() + GOTO_DOWNLOAD_WAIT_MS;
            while (!trace.taken && Date.now() < deadline)
              await new Promise((r) => setTimeout(r, GOTO_DOWNLOAD_POLL_MS));
            return { status: null, deny: null };
          } finally {
            if (navTaken === trace) navTaken = null;
            loading = false;
          }
        },
        { status: null, deny: null },
      );
    },
    async back() {
      return dialogs.interrupted(async () => {
        const h = await history();
        // goto 之前页面停在 about:blank，那一条不算「上一页」。
        if (h.currentIndex <= 0 || h.entries[h.currentIndex - 1]?.url === BLANK)
          return false;
        await page.goBack({ timeout: GOTO_TIMEOUT_MS }).catch((err) => {
          throw new Error(`后退失败：${explain(err)}`);
        });
        await settle();
        return true;
      }, false);
    },
    async forward() {
      return dialogs.interrupted(async () => {
        const h = await history();
        if (h.currentIndex >= h.entries.length - 1) return false;
        await page.goForward({ timeout: GOTO_TIMEOUT_MS }).catch((err) => {
          throw new Error(`前进失败：${explain(err)}`);
        });
        await settle();
        return true;
      }, false);
    },
    async reload() {
      await dialogs.interrupted(async () => {
        await page.reload({ timeout: GOTO_TIMEOUT_MS }).catch((err) => {
          throw new Error(`刷新失败：${explain(err)}`);
        });
        await settle();
      }, undefined);
    },
    async snapshot() {
      const raw = await page.ariaSnapshot({ mode: "ai" });
      // 没有 img 节点时一次额外的往返都不要有。
      const refs = imageRefs(raw);
      if (refs.length === 0) return raw;
      const srcs = new Map<string, string>();
      for (let i = 0; i < refs.length; i += IMG_SRC_BATCH) {
        const batch = refs.slice(i, i + IMG_SRC_BATCH);
        // 单个编号读不到（元素刚被换掉）当作没有地址，不让整个快照失败。
        const read = await Promise.all(
          batch.map((ref) =>
            page
              .locator(`aria-ref=${ref}`)
              .evaluate(IMG_SRC, undefined, { timeout: ACTION_TIMEOUT_MS })
              .catch(() => ""),
          ),
        );
        batch.forEach((ref, at) => {
          const src = read[at] ?? "";
          if (src !== "") srcs.set(ref, describeSrc(src));
        });
      }
      return injectImageSources(raw, srcs);
    },
    dom: (target) => readDom(page, target),
    // 脚本执行与对话框挂起的关系：页面卡死时 evaluate 会一直等，所以包进 interrupted。
    exec: (script, ref) =>
      dialogs.interrupted(() => runScript(page, script, ref), {
        kind: "threw",
        message:
          "页面弹出了对话框，脚本被挂起：先用 browser_dialog 回答，脚本会在回答后继续运行（它的返回值不会再交给你）",
      }),
    cookies: (scope) => readCookies(ctx, page, scope),
    setCookie: (cookie) => writeCookie(ctx, page, cookie),
    removeCookies: (scope, name) => removeCookies(ctx, page, scope, name),
    webStorage: (kind, op) => readWebStorage(page, kind, op),
    mouse: () => (mouse === null ? null : { ...mouse }),
    async move(target) {
      await dialogs.interrupted(async () => {
        const at = await pointOf(target);
        await page.mouse.move(at.x, at.y, { steps: 5 });
        mouse = at;
        await settle();
      }, undefined);
    },
    async scroll(args) {
      return dialogs.interrupted(
        async () => {
          // 时刻从滚动开始前算起：观察器与请求的判定都用它。
          const since = Date.now();
          const watch = await watchAdditions(page);
          try {
            const before = await page.evaluate<ScrollPos>(SCROLL_POS);
            if ("to" in args) {
              await live(args.to);
              await page
                .locator(`aria-ref=${args.to}`)
                .scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
                .catch((err) => {
                  throw actionError("滚动")(err);
                });
            } else {
              const at = args.at
                ? await pointOf(args.at)
                : { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
              await page.mouse.move(at.x, at.y);
              mouse = at;
              const span =
                args.direction === "up" || args.direction === "down"
                  ? VIEWPORT.height
                  : VIEWPORT.width;
              const distance = args.amount ?? span;
              const sign =
                args.direction === "up" || args.direction === "left" ? -1 : 1;
              const vertical =
                args.direction === "up" || args.direction === "down";
              await page.mouse.wheel(
                vertical ? 0 : sign * distance,
                vertical ? sign * distance : 0,
              );
            }
            // 滚动事件与懒加载是异步的：先让滚动跑完，再有限地等新内容出现（见 content-wait.ts）。
            await page.waitForTimeout(SCROLL_SETTLE_MS);
            await waitForContent(since, {
              added: () => watch.read(),
              pending: () => pendingSince(net.list(), since),
            });
            await settle();
            return {
              before,
              after: await page.evaluate<ScrollPos>(SCROLL_POS),
            };
          } finally {
            await watch.stop();
          }
        },
        { before: ZERO_SCROLL, after: ZERO_SCROLL },
      );
    },
    async drag(from, to) {
      await dialogs.interrupted(async () => {
        // 先解析 from，再解析 to，然后重新取一次 from（解析 to 时可能又滚动了页面）。
        await pointOf(from);
        const end = await pointOf(to);
        const at = await pointOf(from);
        const inView = ({ x, y }: { x: number; y: number }) =>
          x >= 0 && y >= 0 && x < VIEWPORT.width && y < VIEWPORT.height;
        if (!inView(at) || !inView(end)) throw new Error(NO_DRAG_POS);
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        // 先动一下再到终点，触发 dragstart。
        await page.mouse.move((at.x + end.x) / 2, (at.y + end.y) / 2 + 2, {
          steps: 6,
        });
        await page.mouse.move(end.x, end.y, { steps: 12 });
        await page.mouse.up();
        mouse = end;
        await settle();
      }, undefined);
    },
    async click(ref, opts) {
      await dialogs.interrupted(async () => {
        const at = await centerOf(ref);
        await page
          .locator(`aria-ref=${ref}`)
          .click({ timeout: ACTION_TIMEOUT_MS, ...clickOpts(opts) })
          .catch((err) => {
            throw actionError("点击")(err);
          });
        mouse = at;
        await settle();
      }, undefined);
    },
    async clickAt(pos, opts) {
      await dialogs.interrupted(async () => {
        const at = pos ?? mouse;
        if (at === null) throw new Error(NO_MOUSE);
        await page.mouse.click(at.x, at.y, clickOpts(opts)).catch((err) => {
          throw actionError("点击")(err);
        });
        mouse = at;
        await settle();
      }, undefined);
    },
    async type(ref, text, opts: TypeOptions) {
      return dialogs.interrupted(async () => {
        let selected: string[] | null = null;
        if (ref === null) {
          if (opts.perKey) await page.keyboard.type(text);
          else await page.keyboard.insertText(text);
        } else {
          await live(ref);
          const locator = page.locator(`aria-ref=${ref}`);
          // 原生下拉框：text 是要选的选项（perKey 对它没意义，忽略）。
          const select = await locator.evaluate(readSelect).catch(() => null);
          if (select !== null) {
            selected = await selectOption(locator, select, ref, text);
          } else {
            try {
              if (opts.perKey) {
                // 逐键也保持「带 ref 就是替换」：点进去、全选，第一个字符就替掉选区。
                await locator.click({ timeout: ACTION_TIMEOUT_MS });
                await page.keyboard.press("ControlOrMeta+a");
                if (text === "") await page.keyboard.press("Delete");
                else await page.keyboard.type(text);
              } else {
                await locator.fill(text, { timeout: ACTION_TIMEOUT_MS });
              }
            } catch (err) {
              throw actionError("输入")(err);
            }
          }
        }
        if (opts.submit) await page.keyboard.press("Enter");
        await settle();
        return selected === null ? null : { selected };
      }, null);
    },
    async press(key) {
      await dialogs.interrupted(async () => {
        await page.keyboard.press(key).catch((err) => {
          throw actionError("按键")(err);
        });
        await settle();
      }, undefined);
    },
    async screenshot() {
      return Buffer.from(await page.screenshot({ type: "jpeg", quality: 70 }));
    },
    async screenshotFull() {
      const size = await page.evaluate(pageSize);
      const height = Math.min(size.height, FULLPAGE_MAX_HEIGHT);
      // clip 配合 fullPage：不用先滚动就能只截前一段。
      const jpeg = await page.screenshot({
        type: "jpeg",
        quality: 70,
        fullPage: true,
        clip: { x: 0, y: 0, width: size.width, height },
      });
      return {
        bytes: Buffer.from(jpeg),
        width: size.width,
        height,
        fullHeight: size.height,
      };
    },
    async screenshotOf(ref) {
      await live(ref);
      try {
        const png = await page.locator(`aria-ref=${ref}`).screenshot({
          type: "png",
          timeout: ACTION_TIMEOUT_MS,
        });
        return Buffer.from(png);
      } catch (err) {
        throw actionError("元素截图")(err);
      }
    },
    async screenshotRect(rect) {
      // 实测（Chromium + playwright-core 1.65）：非 fullPage 的 clip 已经是视口坐标，
      // 滚到 y=700 后 clip.y=0 截到的是当前视口顶部，不用再减 scrollY。
      const png = await page.screenshot({ type: "png", clip: rect });
      return Buffer.from(png);
    },
    async assets(scope) {
      if (scope?.ref !== undefined) await live(scope.ref);
      return listAssets(ctx, page, scope);
    },
    fetchAssets: (urls, opts, onResult) =>
      fetchAssets(ctx, page, urls, opts, onResult),
    request: (spec) => jars.fetch(spec),
    identityCookies: (identity) => jars.identityCookies(identity),
    async upload(ref, files) {
      await dialogs.interrupted(async () => {
        await live(ref);
        const payload = filePayloads(files);
        const locator = page.locator(`aria-ref=${ref}`);
        // 判断在浏览器里做（与 collectImages 一样是自包含函数），不在 Node 侧看标签。
        const input = await locator.evaluate(isFileInput).catch((err) => {
          throw actionError("上传")(err);
        });
        try {
          if (input) {
            await locator.setInputFiles(payload, {
              timeout: ACTION_TIMEOUT_MS,
            });
          } else {
            // 自绘的按钮：点它并接住弹出的选择框。等不到就是这元素不是上传入口。
            // 点击先失败时 Promise.all 会提前拒绝，另一个 promise 的拒绝要自己吞掉。
            const waiting = page.waitForEvent("filechooser", {
              timeout: ACTION_TIMEOUT_MS,
            });
            waiting.catch(noop);
            const [chooser] = await Promise.all([
              waiting,
              locator.click({ timeout: ACTION_TIMEOUT_MS }),
            ]);
            await chooser.setFiles(payload);
          }
        } catch (err) {
          throw explainFileError(err);
        }
        await settle();
      }, undefined);
    },
    console: () => buffer.list(),
    consoleEvicted: () => buffer.evicted(),
    network: () => net.list(),
    networkEvicted: () => net.evicted(),
    networkDetail: (id) => net.detail(id),
    networkBody: (id, which) => net.body(id, which),
    routeAdd: (rule) => routes.add(rule),
    routeRemove: (id) => routes.remove(id),
    routeList: () => routes.list(),
    routeClear: () => routes.clear(),
    emulate: (patch) => emu.apply(patch),
    emulation: () => emu.state(),
    cdp: (method, params) => pageCdp.send(method, params),
    onConsole: (cb) => buffer.subscribe(cb),
    copied: () => readCopied(page),
    async startScreencast(opts, onFrame) {
      if (cast) return;
      cast = await startScreencast(ctx, page, opts, onFrame);
    },
    stopScreencast,
    async input(ev: InputEvent) {
      if (ev.type === "mouse") {
        // 位置没变就不再移动：前端点击前已经把移动送过来了，这里再来一次往返只是白等
        const moved =
          ev.action === "move" ||
          mouse === null ||
          ev.x !== mouse.x ||
          ev.y !== mouse.y;
        mouse = { x: ev.x, y: ev.y };
        if (moved) await page.mouse.move(ev.x, ev.y);
        if (ev.action === "move") return;
        const opts = {
          button: ev.button ?? "left",
          clickCount: ev.clickCount ?? 1,
        };
        if (ev.action === "down") await page.mouse.down(opts);
        else await page.mouse.up(opts);
        return;
      }
      if (ev.type === "wheel") {
        if (mouse === null || ev.x !== mouse.x || ev.y !== mouse.y) {
          mouse = { x: ev.x, y: ev.y };
          await page.mouse.move(ev.x, ev.y);
        }
        await page.mouse.wheel(ev.deltaX, ev.deltaY);
        return;
      }
      if (ev.type === "key") {
        if (ev.action === "down") await page.keyboard.down(ev.key);
        else await page.keyboard.up(ev.key);
        return;
      }
      // 整段文字一次插入：中文输入法在前端本地输入框里拼好再送过来。
      await page.keyboard.insertText(ev.text);
    },
    async selection() {
      // 选区属于各自的文档，跨源 iframe 要在它自己的 frame 里取；selectedText 只有焦点所在的那个会给出文字
      for (const frame of page.frames()) {
        const text = await frame.evaluate(selectedText).catch(() => "");
        if (text !== "") return text;
      }
      return "";
    },
    dialog: () => dialogs.current(),
    answerDialog: (accept, text) => dialogs.answer(accept, text),
    onDialog: (cb) => dialogs.onChange(cb),
    onChange(cb) {
      changes.add(cb);
      startTitlePoll();
      return () => {
        changes.delete(cb);
        if (changes.size === 0) stopTitlePoll();
      };
    },
    onClose(cb) {
      closers.add(cb);
      return () => closers.delete(cb);
    },
    onDownload(cb) {
      downloadSubs.add(cb);
      return () => {
        downloadSubs.delete(cb);
      };
    },
    onFileChooser(cb) {
      chooserSubs.add(cb);
      return () => {
        chooserSubs.delete(cb);
      };
    },
    async close() {
      await stopScreencast();
      stopTitlePoll();
      await page.close({ runBeforeUnload: false }).catch(noop);
    },
  };
  return handle;
}
