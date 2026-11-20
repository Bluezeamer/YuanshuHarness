// 仅测试用的替身：一个能注册工具、再按名字调用的最小 pi，加上可控的压缩层、审批与提问。
// 这个文件在 src/ 下会进构建产物，只能依赖 src 与 node 内置（同 pages/testkit.ts）。
import { statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { PromptResult, PromptSpec } from "../../session/prompts.js";
import {
  createDownloadWindows,
  type DownloadWindows,
} from "../downloads/windows.js";
import type {
  AssetResult,
  ConsoleEntry,
  DomCapture,
  DomTarget,
  FullScreenshot,
  InputEvent,
  PageAsset,
  PageHandle,
  TypeOptions,
} from "../engine/types.js";
import type { TargetOptions } from "../net/target.js";
import type { PageRegistry } from "../pages/registry.js";
import {
  describeTarget,
  FakeCtx,
  FakePage,
  makeRegistry,
} from "../pages/testkit.js";
import type { Verdict } from "./approve.js";
import type { Cleaner, CleanInput, CleanOutput } from "./clean/types.js";
import type { BrowserToolsDeps } from "./deps.js";
import { browserTools } from "./tools.js";

// 注册表与它的临时目录由 pages/testkit 管，测试文件在 afterAll 里调同一个清理。
export { cleanupTmpDirs } from "../pages/testkit.js";

export type ToolContent = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

export interface ToolRunResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}

export interface FakeCleaner extends Cleaner {
  /** 每次清洗的入参，按调用顺序 */
  calls: CleanInput[];
  /** 被 forgetPage 的页面 */
  forgot: string[];
  /** 被 rebase 的入参 */
  rebased: { sessionId: string; pageId: string; raw: string; url: string }[];
  /** 返回文本；缺省带上前缀与原始快照，看得出是哪条路径来的 */
  result: string | null;
}

/** 预设的答复 → 审批结果（true 通过；false 是被拒且没写理由；也可以直接给 Verdict）。 */
export const verdictOf = (allowed: boolean | Verdict | undefined): Verdict =>
  typeof allowed === "object"
    ? allowed
    : allowed === false
      ? { allowed: false, note: "" }
      : { allowed: true };

export interface AuditEntry {
  tool: string;
  pageId?: string;
  summary: string;
}

/** pages/testkit 的假页面不够记的几处：控制台条目、按键与坐标输入的细节。 */
export class ToolPage extends FakePage {
  consoleItems: ConsoleEntry[] = [];
  /** 设置后 goto 原样返回它（模拟代理拒绝） */
  gotoResult: { status: number | null; deny: string | null } | null = null;
  /** 元素截图返回的字节，缺省 PNG 魔数开头。 */
  elementShot: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  /** 区域截图返回的字节，缺省 PNG 魔数开头。 */
  rectShot: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  /** 整页截图返回的东西，缺省同真页面：1280×800、没超高。 */
  fullShot: FullScreenshot = {
    bytes: Buffer.from("jpeg"),
    width: 1280,
    height: 800,
    fullHeight: 800,
  };
  /** 设置后 copied() 抛这个错误。 */
  copiedError: Error | null = null;
  /** assets() 的结果，按 ref 给（缺省整页用空串这个 key）。 */
  assetList: Record<string, PageAsset[]> = {};
  /** fetchAssets() 要交出的结果；null 就按地址各交一份成功的。 */
  assetFetch: AssetResult[] | null = null;
  /** type() 的返回值：模拟 ref 指到了原生下拉框（选上了这些选项）。 */
  selectResult: { selected: string[] } | null = null;
  /** upload() 记录（ref 与交进去的文件）。 */
  uploads: Array<{ ref: string; files: { name: string; buffer: Buffer }[] }> =
    [];
  /** 设置后 upload() 抛这个错误（模拟入口不是上传入口）。 */
  uploadError: Error | null = null;
  /** dom() 的结果（可按目标分别给）；缺省没有 group。 */
  domResult: DomCapture = { groups: [], nodeCapHit: false };

  override async goto(
    url: string,
  ): Promise<{ status: number | null; deny: string | null }> {
    const r = await super.goto(url);
    return this.gotoResult ?? r;
  }

  override async type(
    ref: string | null,
    text: string,
    opts: TypeOptions,
  ): Promise<{ selected: string[] } | null> {
    await super.type(ref, text, opts);
    return this.selectResult;
  }

  override async input(ev: InputEvent): Promise<void> {
    this.calls.push(
      ev.type === "mouse"
        ? `input mouse ${ev.action} ${ev.button} ${ev.clickCount}`
        : ev.type === "text"
          ? `input text ${ev.text}`
          : `input ${ev.type}`,
    );
  }

  override console(): ConsoleEntry[] {
    return this.consoleItems;
  }

  override async screenshotOf(ref: string): Promise<Buffer> {
    this.calls.push(`screenshotOf ${ref}`);
    return this.elementShot;
  }

  override async screenshotRect(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<Buffer> {
    this.calls.push(
      `screenshotRect ${rect.x},${rect.y} ${rect.width}x${rect.height}`,
    );
    return this.rectShot;
  }

  override async screenshotFull(): Promise<FullScreenshot> {
    this.calls.push("screenshotFull");
    return this.fullShot;
  }

  override async copied(): Promise<{ text: string; ts: number } | null> {
    if (this.copiedError) throw this.copiedError;
    return this.copiedValue;
  }

  override async assets(scope?: { ref?: string }): Promise<PageAsset[]> {
    this.calls.push(`assets ${scope?.ref ?? ""}`.trim());
    return this.assetList[scope?.ref ?? ""] ?? [];
  }

  override async fetchAssets(
    urls: string[],
    opts: { referer: string; maxBytes: number },
    onResult: (r: AssetResult) => Promise<void>,
  ): Promise<void> {
    this.calls.push(`fetchAssets ${urls.join(",")} referer=${opts.referer}`);
    if (urls.length === 0) return;
    const results =
      this.assetFetch ??
      urls.map(
        (url): AssetResult => ({
          url,
          ok: true,
          mime: "application/octet-stream",
          bytes: Buffer.from(`bytes-of-${url}`),
          viaRequest: false,
        }),
      );
    for (const r of results) await onResult(r);
  }

  override async upload(
    ref: string,
    files: { name: string; buffer: Buffer }[],
  ): Promise<void> {
    this.calls.push(`upload ${ref} ${files.map((f) => f.name).join(",")}`);
    if (this.uploadError) throw this.uploadError;
    this.uploads.push({ ref, files: files.map((f) => ({ ...f })) });
  }

  override async dom(target: DomTarget): Promise<DomCapture> {
    this.calls.push(`dom ${describeTarget(target)}`);
    return this.domResult;
  }
}

export class ToolCtx extends FakeCtx {
  override async newPage(): Promise<PageHandle> {
    const page = new ToolPage();
    this.pageInit?.(page);
    this.pages.push(page);
    return page;
  }

  /** 这个上下文里的假页面，按打开顺序；负数从后往前。 */
  pageAt(index = -1): ToolPage {
    const pages = this.pages.filter(
      (p): p is ToolPage => p instanceof ToolPage,
    );
    const page = pages[index < 0 ? pages.length + index : index];
    if (!page) throw new Error(`没有第 ${index} 个页面`);
    return page;
  }
}

export interface ToolHarness {
  /** 调一个工具，返回它的 `{content, details}`；工具抛错就原样抛。给 signal 就按第三参传进去。 */
  run(
    tool: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<ToolRunResult>;
  /** registerTool 注册到的工具名，按注册顺序。 */
  names: string[];
  registry: PageRegistry;
  /** 压缩层替身：记录调用、可预设返回文本 */
  cleaner: FakeCleaner;
  /** 每次提问的 PromptSpec */
  asks: PromptSpec[];
  /** 每次 approveOpen 的入参 */
  approvals: Array<{ origin: string; reason: string; service?: boolean }>;
  /** 预设的提问答复：按顺序取，取完用「done」 */
  replies: PromptResult[];
  /** 预设的审批结果：按顺序取，取完用通过 */
  approve: Array<boolean | Verdict>;
  /** 预设的下载审批结果：按顺序取，取完用通过 */
  approveDownloadReplies: Array<boolean | Verdict>;
  /** 预设的上传审批结果：按顺序取，取完用通过 */
  approveUploadReplies: Array<boolean | Verdict>;
  audit: AuditEntry[];
  /** 每次 saveAsset 的入参（名字与字节） */
  saved: Array<{ name: string; bytes: Buffer }>;
  /** 每次 mask 的入参（落文件前的变量遮罩） */
  masks: string[];
  /** 每次 modelImage 的入参（mime 与原始字节） */
  modelImages: Array<{ mime: string; bytes: Buffer }>;
  /** 假的 modelImage 返回的尺寸；null 表示不给尺寸（等于原图） */
  modelImageSize: { width: number; height: number } | null;
  /** 每次下载审批的入参 */
  downloadApprovals: Array<{
    filename: string;
    pageUrl: string;
    fileUrl: string;
    executable: boolean;
  }>;
  /** 每次 saveFile 存下来的下载（名字与大小） */
  savedDownloads: Array<{ name: string; size: number }>;
  /** 每次开下载窗口（collect）的入参：没开窗口的动作在这里看不到 */
  collects: Array<{ pageId: string | null }>;
  /** 每次 show 的入参（pageId、标题、地址、说明） */
  shows: Array<{ pageId: string; title: string; url: string; note: string }>;
  /** 假广播送达的界面个数；0 模拟没有在线的界面 */
  showDelivered: number;
  /** 每次上传审批的入参 */
  uploadApprovals: Array<{
    origin: string;
    pageUrl: string;
    files: { name: string; sizeText: string; display: string }[];
  }>;
  deps: BrowserToolsDeps;
  /** 页面模型的测试台（假上下文、忙碌集合、时钟都在这里）。 */
  pages: ReturnType<typeof makeRegistry>;
  /** 某个工作区的假上下文；页面开出来之后才有。 */
  ctx(workspaceKey?: string): ToolCtx;
  sessionId: string;
}
export const TARGET_OPTIONS: TargetOptions = {
  findEnv: (name) =>
    name === "web1"
      ? "e2"
      : name === "server" || name === "local"
        ? "local"
        : null,
  defaultEnvId: "local",
};

export function makeToolHarness(
  overrides: Partial<BrowserToolsDeps> = {},
  options: { sessionId?: string; onCtx?: (c: ToolCtx) => void } = {},
): ToolHarness {
  const contexts = new Map<string, ToolCtx>();
  const sessionId = options.sessionId ?? "s1";

  const cleaner: FakeCleaner = {
    calls: [],
    forgot: [],
    rebased: [],
    result: null,
    async clean(input: CleanInput): Promise<CleanOutput> {
      cleaner.calls.push(input);
      return {
        text: cleaner.result ?? "清洗后的页面",
        stage: "direct",
      };
    },
    rebase(sessionId: string, pageId: string, raw: string, url: string) {
      cleaner.rebased.push({ sessionId, pageId, raw, url });
    },
    forgetPage(pageId: string) {
      cleaner.forgot.push(pageId);
    },
  };

  const preset = {
    asks: [] as PromptSpec[],
    approvals: [] as Array<{
      origin: string;
      reason: string;
      service?: boolean;
    }>,
    replies: [] as PromptResult[],
    approve: [] as Array<boolean | Verdict>,
    audit: [] as AuditEntry[],
    saved: [] as Array<{ name: string; bytes: Buffer }>,
    masks: [] as string[],
    modelImages: [] as Array<{ mime: string; bytes: Buffer }>,
    modelImageSize: null as { width: number; height: number } | null,
    downloadApprovals: [] as Array<{
      filename: string;
      pageUrl: string;
      fileUrl: string;
      executable: boolean;
    }>,
    savedDownloads: [] as Array<{ name: string; size: number }>,
    collects: [] as Array<{ pageId: string | null }>,
    shows: [] as Array<{
      pageId: string;
      title: string;
      url: string;
      note: string;
    }>,
    showDelivered: 1,
    approveDownloadReplies: [] as Array<boolean | Verdict>,
    uploadApprovals: [] as Array<{
      origin: string;
      pageUrl: string;
      files: { name: string; sizeText: string; display: string }[];
    }>,
    approveUploadReplies: [] as Array<boolean | Verdict>,
  };

  // 下载窗口用真的：动作期间收、窗口外取消的行为就是被测的东西本身。
  // 注册表要先把下载交给窗口，而窗口的 rootOf 又取自注册表的依赖，所以用 let 接一下。
  let pagesRef: ReturnType<typeof makeRegistry> | null = null;
  const windows = createDownloadWindows({
    rootOf: (s) => pagesRef?.deps.rootOf(s) ?? s,
    // 工具层的用例只跑 agent 动作；用户页上的下载这里没有待处理清单可挂，照旧取消。
    userDownload: (_page, d) => void d.cancel("用户操作的页面上的下载暂不支持"),
  });
  const downloads = {
    collect: ((sid, pageId, fn, graceMs) => {
      preset.collects.push({ pageId });
      return windows.collect(sid, pageId, fn, graceMs);
    }) satisfies DownloadWindows["collect"],
    dispatch: windows.dispatch,
  };
  const pages = makeRegistry({
    context: async (workspaceKey) => {
      const c = new ToolCtx();
      contexts.set(workspaceKey, c);
      options.onCtx?.(c);
      return c;
    },
    onDownload: (page, d) => windows.dispatch(page, d),
    // 工具层的用例只跑 agent 动作：页面上的文件选择没人接（同用户页下载）。
    onFileChooser: () => {},
  });
  pagesRef = pages;

  const deps: BrowserToolsDeps = {
    registry: pages.registry,
    cleaner,
    targetOptions: () => TARGET_OPTIONS,
    workspaceKey: () => "w1",
    async approveOpen(args) {
      preset.approvals.push(args);
      return verdictOf(preset.approve.shift());
    },
    access: { approved: () => false, known: () => false },
    ask: async (spec) => {
      preset.asks.push(spec);
      return (
        preset.replies.shift() ?? { outcome: "answered", optionId: "done" }
      );
    },
    audit: (entry) => preset.audit.push(entry),
    // 假广播：记下每次展示，送达个数由用例预设（缺省当作有一个在线界面）。
    show(args) {
      preset.shows.push(args);
      return preset.showDelivered;
    },
    downloads,
    async approveDownload(args) {
      preset.downloadApprovals.push(args);
      return verdictOf(preset.approveDownloadReplies.shift());
    },
    // 假的附件区：把下载的字节写到注册表临时目录里再读回来（大小是真的），回一行 marker。
    async saveFile({ name, write }) {
      const abs = path.join(
        pages.dataDir,
        `download-${preset.savedDownloads.length}`,
      );
      await write(abs);
      const size = statSync(abs).size;
      preset.savedDownloads.push({ name, size });
      return {
        marker: `[attach_file] attachment:/2026-01-01/00000000-${name} (application/octet-stream, ${size} B)`,
        size,
        sizeText: `${size} B`,
      };
    },
    fileMaxBytes: () => 500 * 1024 * 1024,
    // 默认回一个假的 ResolvedUpload（只用到名字与大小）：真实现要真文件系统，放到 upload.test 里测。
    async resolveUpload(host, file) {
      return {
        name: path.posix.basename(file),
        size: 3,
        display: host === undefined ? `local:${file}` : `${host}:${file}`,
        open: async () => Readable.from([Buffer.from("abc")]),
      };
    },
    async approveUpload(args) {
      preset.uploadApprovals.push(args);
      return verdictOf(preset.approveUploadReplies.shift());
    },
    // 截图与页面图片的假附件区：只回一行 marker；modelImage 与真实现一起把字节改写，测试据此分辨图片块来自哪里。
    async saveAsset({ name, bytes }) {
      preset.saved.push({ name, bytes });
      return {
        marker: `[attach_file] attachment:/2026-01-01/00000000-${name} (image, 1 KB)`,
      };
    },
    async modelImage(bytes, mime) {
      preset.modelImages.push({ mime, bytes });
      return {
        mimeType: "image/png",
        data: Buffer.concat([Buffer.from("model:"), bytes]).toString("base64"),
        ...(preset.modelImageSize ?? {}),
      };
    },
    // 假的遮罩：记下入参并改一个字，测试据此断言落文件前确实遮过。
    mask(text) {
      preset.masks.push(text);
      return text.replace(/secret/g, "{{@secret}}");
    },
    ...overrides,
  };

  const tools = new Map<
    string,
    {
      execute(
        id: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<ToolRunResult>;
    }
  >();
  const names: string[] = [];
  browserTools(
    deps,
    sessionId,
  )({
    registerTool: (t: { name: string; execute: typeof run }) => {
      names.push(t.name);
      tools.set(t.name, t);
    },
  } as never);
  const run = async (tool: string, params?: unknown, signal?: AbortSignal) => {
    const t = tools.get(tool);
    if (!t) throw new Error(`没有注册工具 ${tool}`);
    return t.execute("call-1", params ?? {}, signal);
  };

  // 预设用 getter 暴露：测试里 `h.approve = [false]` / `h.replies.push(...)` 才作用到替身上。
  return {
    run,
    names,
    registry: pages.registry,
    cleaner,
    deps,
    pages,
    ctx: (workspaceKey = "w1") => {
      const c = contexts.get(workspaceKey);
      if (!c) throw new Error(`工作区 ${workspaceKey} 还没有上下文`);
      return c;
    },
    sessionId,
    get asks() {
      return preset.asks;
    },
    set asks(v) {
      preset.asks = v;
    },
    get approvals() {
      return preset.approvals;
    },
    set approvals(v) {
      preset.approvals = v;
    },
    get replies() {
      return preset.replies;
    },
    set replies(v) {
      preset.replies = v;
    },
    get approve() {
      return preset.approve;
    },
    set approve(v) {
      preset.approve = v;
    },
    get audit() {
      return preset.audit;
    },
    set audit(v) {
      preset.audit = v;
    },
    get saved() {
      return preset.saved;
    },
    set saved(v) {
      preset.saved = v;
    },
    get modelImages() {
      return preset.modelImages;
    },
    set modelImages(v) {
      preset.modelImages = v;
    },
    get modelImageSize() {
      return preset.modelImageSize;
    },
    set modelImageSize(v) {
      preset.modelImageSize = v;
    },
    get masks() {
      return preset.masks;
    },
    set masks(v) {
      preset.masks = v;
    },
    get downloadApprovals() {
      return preset.downloadApprovals;
    },
    set downloadApprovals(v) {
      preset.downloadApprovals = v;
    },
    get savedDownloads() {
      return preset.savedDownloads;
    },
    set savedDownloads(v) {
      preset.savedDownloads = v;
    },
    get collects() {
      return preset.collects;
    },
    set collects(v) {
      preset.collects = v;
    },
    get approveDownloadReplies() {
      return preset.approveDownloadReplies;
    },
    set approveDownloadReplies(v) {
      preset.approveDownloadReplies = v;
    },
    get approveUploadReplies() {
      return preset.approveUploadReplies;
    },
    set approveUploadReplies(v) {
      preset.approveUploadReplies = v;
    },
    get shows() {
      return preset.shows;
    },
    set shows(v) {
      preset.shows = v;
    },
    get showDelivered() {
      return preset.showDelivered;
    },
    set showDelivered(v) {
      preset.showDelivered = v;
    },
    get uploadApprovals() {
      return preset.uploadApprovals;
    },
    set uploadApprovals(v) {
      preset.uploadApprovals = v;
    },
  };
}
