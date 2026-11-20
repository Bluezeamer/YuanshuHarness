// 仅测试用的替身：假页面、假上下文，以及带真库与真缩略图目录的注册表。
// 这个文件在 src/ 下，会跟着 tsc 的 build 计划进 dist，所以只能依赖 src 与 node 内置；
// 临时目录记在这里，测试文件在 afterAll 里调 cleanupTmpDirs() 删掉（不让 /tmp 的 inode 被占满）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserPageStore } from "../../store/browser-pages.js";
import { type Db, openDatabase } from "../../store/db.js";
import type {
  AssetResult,
  BrowserCtx,
  ClickOptions,
  ConsoleEntry,
  CookieInput,
  DomCapture,
  DomTarget,
  EmulationPatch,
  EmulationState,
  ExecOutcome,
  FullScreenshot,
  HttpRequestSpec,
  HttpResult,
  InputEvent,
  NetworkBody,
  NetworkDetail,
  NetworkEntry,
  PageAsset,
  PageCookie,
  PageDialog,
  PageDownload,
  PageFileChooser,
  PageHandle,
  PointTarget,
  RouteInfo,
  RouteRule,
  ScrollArgs,
  ScrollPos,
  StorageState,
  TypeOptions,
  WebStorageEntry,
  WebStorageOp,
} from "../engine/types.js";
import { VIEWPORT } from "../engine/types.js";
import { PageRegistry, type RegistryDeps } from "./registry.js";
import { ThumbStore } from "./thumbs.js";
import type { PageView } from "./types.js";

/** 假页面记录目标用的文字：ref 原样，坐标写成 `数字,数字`。 */
function targetKey(target: PointTarget): string {
  return "ref" in target ? target.ref : `${target.x},${target.y}`;
}

/** ref 在假页面里只当一个位置（坐标写 0,0），真实位置由真浏览器测试验。 */
function targetPosition(target: PointTarget): { x: number; y: number } {
  return "ref" in target ? { x: 0, y: 0 } : { x: target.x, y: target.y };
}

function optsSuffix(opts?: ClickOptions): string {
  if (opts?.count === undefined && opts?.button === undefined) return "";
  return ` ${opts.count ?? 1} ${opts.button ?? "left"}`;
}

/** 读 DOM 的目标写成文字记进 calls：selector 原样、ref 原样、不给就是 document。 */
export function describeTarget(target: DomTarget): string {
  return target === null
    ? "document"
    : "selector" in target
      ? `selector ${target.selector}`
      : `ref ${target.ref}`;
}

export class FakePage implements PageHandle {
  readonly opener: PageHandle | null;
  /** 每次调用记一行，测试据此断言有没有真去动页面。 */
  readonly calls: string[] = [];
  /** 推过来的输入事件，按到达顺序；界面流的测试据此断言拷过来的字段。 */
  readonly inputs: InputEvent[] = [];
  closed = false;
  /** 设置后 goto 抛这个错误。 */
  gotoError: Error | null = null;
  /** 设置后 goto 原样返回它（模拟代理拒绝）；缺省 200 无拒绝码。 */
  gotoResult: { status: number | null; deny: string | null } | null = null;
  /** 设置后 snapshot 抛这个错误（模拟页面已随浏览器崩掉）。 */
  snapshotError: Error | null = null;
  /** 页面里当前选中的文字。 */
  selected = "";
  /** 页面里最近一次主动复制的内容（没复制过就是 null）。 */
  copiedValue: { text: string; ts: number } | null = null;
  /** 累计被挤出控制台缓冲的出现次数。 */
  consoleDropped = 0;
  /** 网络缓冲里的条目与挤出条数；测试可直接置。 */
  networkItems: NetworkEntry[] = [];
  networkDropped = 0;
  /** networkDetail 给的三个字段。 */
  networkHeaders: Record<string, string> = {};
  networkResponseHeaders: Record<string, string> = {};
  networkRequestBodyBytes: number | null = null;
  /** networkBody 的结果，按 `id:which` 给；没设的那个按「没有内容」回。 */
  networkBodies: Record<string, NetworkBody> = {};
  /** 元素截图与页面图片的替身结果。 */
  elementShot: Buffer = Buffer.from("png");
  /** 区域截图的替身结果。 */
  rectShot: Buffer = Buffer.from("png");
  /** scroll 返回的页面位置：缺省没动、文档比视口大（但不在底端 / 右端）。 */
  scrollBefore: ScrollPos = {
    x: 0,
    y: 0,
    width: 3000,
    height: 3000,
    viewWidth: VIEWPORT.width,
    viewHeight: VIEWPORT.height,
  };
  scrollAfter: ScrollPos = {
    x: 0,
    y: 0,
    width: 3000,
    height: 3000,
    viewWidth: VIEWPORT.width,
    viewHeight: VIEWPORT.height,
  };
  /** assets() 的结果（整个页面）；要按 ref 分开给用 ToolPage。 */
  pageAssets: PageAsset[] = [];
  /** fetchAssets() 会交出的结果。 */
  assetResults: AssetResult[] = [];
  /** request() 收到的 spec，按调用顺序。 */
  requests: HttpRequestSpec[] = [];
  /** request() 依次回的结果；用完了就是 200、无头、空体。 */
  requestResults: HttpResult[] = [];
  /** identityCookies() 的结果，按身份名给。 */
  identityJars: Record<string, string[]> = {};
  /** 当前推流的参数（没在推就是 null）。 */
  screencastOpts: {
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    quality: number;
  } | null = null;
  /** 当前鼠标位置；测试可以写它来模拟已经移过鼠标。 */
  mouseAt: { x: number; y: number } | null = null;
  /** exec() 的结果（缺省是 undefined 值的成功）；脚本与编号按调用顺序记在 execScripts 里。 */
  execResult: ExecOutcome = { kind: "value", json: "undefined" };
  execScripts: Array<{ script: string; ref: string | null }> = [];
  /** 拦截规则（routeAdd 登记、routeRemove / routeClear 删），编号每页独立递增。 */
  readonly routes: RouteInfo[] = [];
  /** routeAdd 收到的规则与要抛的错误。 */
  readonly routeAdds: RouteRule[] = [];
  routeAddError: Error | null = null;
  private nextRouteId = 1;
  /** emulate() 收到的 patch，按调用顺序；状态按「逐项覆盖」累出。 */
  readonly emulationPatches: EmulationPatch[] = [];
  /** 当前环境模拟状态；测试可以直接置。 */
  emulationState: EmulationState = {
    offline: false,
    throttle: null,
    cpuSlowdown: null,
    colorScheme: null,
    reducedMotion: null,
    userAgent: null,
    locale: null,
    timezone: null,
    cacheDisabled: false,
  };
  /** 设置后 emulate() 抛这个错误（模拟 CDP 命令失败）。 */
  emulateError: Error | null = null;
  /** cdp() 收到的方法与参数，按调用顺序。 */
  readonly cdpCalls: Array<{
    method: string;
    params?: Record<string, unknown>;
  }> = [];
  /** cdp() 依次回的结果；用完了回 {}。 */
  cdpResults: unknown[] = [];
  /** 设置后 cdp() 抛这个错误。 */
  cdpError: Error | null = null;
  /** cookies() 的结果，按 scope 给。 */
  cookieList: Record<"page" | "all", PageCookie[]> = { page: [], all: [] };
  /** setCookie() 收到的写入与可选的报错。 */
  cookieWrites: CookieInput[] = [];
  setCookieError: Error | null = null;
  /** removeCookies() 收到的东西与返回的计数。 */
  cookieRemovals: Array<{ scope: "page" | "all"; name?: string }> = [];
  removedCookies = 0;
  /** webStorage() 收到的操作与结果；设了 webStorageError 就抛它。 */
  storageOps: Array<{ kind: "local" | "session"; op: WebStorageOp }> = [];
  webStorageResult: { entries: WebStorageEntry[]; changed: number } = {
    entries: [],
    changed: 0,
  };
  webStorageError: Error | null = null;
  private onFrame: ((jpeg: Buffer) => void | Promise<void>) | null = null;
  private currentUrl: string;
  private currentTitle = "";
  private isLoading = false;
  private consoleEntries: ConsoleEntry[] = [];
  private readonly consoleSubs = new Set<(e: ConsoleEntry) => void>();
  private readonly changes = new Set<() => void>();
  private readonly closers = new Set<() => void>();
  private readonly downloadSubs = new Set<(d: PageDownload) => void>();
  private readonly chooserSubs = new Set<(c: PageFileChooser) => void>();
  private readonly dialogSubs = new Set<() => void>();
  /** 测试设定的挂着对话框；null 就是没有。 */
  private dialogValue: PageDialog | null = null;

  constructor(opener: PageHandle | null = null, url = "about:blank") {
    this.opener = opener;
    this.currentUrl = url;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  loading(): boolean {
    return this.isLoading;
  }

  async goto(
    url: string,
  ): Promise<{ status: number | null; deny: string | null }> {
    this.calls.push(`goto ${url}`);
    if (this.gotoError) throw this.gotoError;
    this.currentUrl = url;
    // 真页面的导航会触发 onChange，替身也照做，否则 loading 一直不回落。
    for (const cb of [...this.changes]) cb();
    return this.gotoResult ?? { status: 200, deny: null };
  }

  async back(): Promise<boolean> {
    this.calls.push("back");
    return true;
  }

  async forward(): Promise<boolean> {
    this.calls.push("forward");
    return true;
  }

  async reload(): Promise<void> {
    this.calls.push("reload");
  }

  async snapshot(): Promise<string> {
    this.calls.push("snapshot");
    if (this.snapshotError) throw this.snapshotError;
    return "- button e1";
  }

  async dom(target: DomTarget): Promise<DomCapture> {
    this.calls.push(`dom ${describeTarget(target)}`);
    return { groups: [], nodeCapHit: false };
  }

  async exec(script: string, ref: string | null): Promise<ExecOutcome> {
    this.calls.push(`exec ${ref ?? "-"} ${script.length}`);
    this.execScripts.push({ script, ref });
    return this.execResult;
  }

  async cookies(scope: "page" | "all"): Promise<PageCookie[]> {
    this.calls.push(`cookies ${scope}`);
    return this.cookieList[scope] ?? [];
  }

  async setCookie(cookie: CookieInput): Promise<void> {
    this.calls.push(`setCookie ${cookie.name}`);
    this.cookieWrites.push(cookie);
    if (this.setCookieError) throw this.setCookieError;
  }

  async removeCookies(scope: "page" | "all", name?: string): Promise<number> {
    this.calls.push(`removeCookies ${scope} ${name ?? ""}`.trim());
    this.cookieRemovals.push({
      scope,
      ...(name === undefined ? {} : { name }),
    });
    return this.removedCookies;
  }

  async webStorage(
    kind: "local" | "session",
    op: WebStorageOp,
  ): Promise<{ entries: WebStorageEntry[]; changed: number }> {
    this.calls.push(`webStorage ${kind} ${op.op}`);
    this.storageOps.push({ kind, op });
    if (this.webStorageError) throw this.webStorageError;
    return this.webStorageResult;
  }

  async routeAdd(rule: RouteRule): Promise<RouteInfo> {
    this.calls.push(`routeAdd ${rule.action.kind} ${rule.pattern}`);
    if (this.routeAddError) throw this.routeAddError;
    const info: RouteInfo = { ...rule, id: this.nextRouteId++, hits: 0 };
    this.routeAdds.push(rule);
    this.routes.push(info);
    return { ...info };
  }

  async routeRemove(id: number): Promise<boolean> {
    this.calls.push(`routeRemove ${id}`);
    const at = this.routes.findIndex((r) => r.id === id);
    if (at < 0) return false;
    this.routes.splice(at, 1);
    return true;
  }

  routeList(): RouteInfo[] {
    return this.routes.map((r) => ({ ...r }));
  }

  async routeClear(): Promise<number> {
    this.calls.push("routeClear");
    return this.routes.splice(0, this.routes.length).length;
  }

  async emulate(patch: EmulationPatch): Promise<EmulationState> {
    this.calls.push(`emulate ${Object.keys(patch).join(",")}`);
    this.emulationPatches.push(patch);
    if (this.emulateError) throw this.emulateError;
    // 限速为整组覆盖：没给的项写 -1（不限），与引擎一致。
    const throttle =
      patch.throttle === undefined
        ? this.emulationState.throttle
        : patch.throttle === null
          ? null
          : {
              latencyMs: -1,
              downloadKbps: -1,
              uploadKbps: -1,
              ...patch.throttle,
            };
    this.emulationState = { ...this.emulationState, ...patch, throttle };
    return { ...this.emulationState };
  }

  emulation(): EmulationState {
    return { ...this.emulationState };
  }

  async cdp(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push(`cdp ${method}`);
    this.cdpCalls.push({
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (this.cdpError) throw this.cdpError;
    // 脚本里放 undefined 就是「命令没有返回结果」：不能被缺省值顶掉。
    return this.cdpResults.length > 0 ? this.cdpResults.shift() : {};
  }

  mouse(): { x: number; y: number } | null {
    return this.mouseAt;
  }

  async move(target: PointTarget): Promise<void> {
    this.calls.push(`move ${targetKey(target)}`);
    this.mouseAt = targetPosition(target);
  }

  async scroll(
    args: ScrollArgs,
  ): Promise<{ before: ScrollPos; after: ScrollPos }> {
    if ("to" in args) {
      this.calls.push(`scroll to ${args.to}`);
      return { before: this.scrollBefore, after: this.scrollAfter };
    }
    const amount = args.amount === undefined ? "" : ` ${args.amount}`;
    const at = args.at === undefined ? "" : ` @${targetKey(args.at)}`;
    this.calls.push(`scroll ${args.direction}${amount}${at}`);
    return { before: this.scrollBefore, after: this.scrollAfter };
  }

  async drag(from: PointTarget, to: PointTarget): Promise<void> {
    this.calls.push(`drag ${targetKey(from)} ${targetKey(to)}`);
    this.mouseAt = targetPosition(to);
  }

  async click(ref: string, opts?: ClickOptions): Promise<void> {
    this.calls.push(`click ${ref}${optsSuffix(opts)}`);
  }

  async clickAt(
    pos: { x: number; y: number } | null,
    opts?: ClickOptions,
  ): Promise<void> {
    const at = pos ?? this.mouseAt;
    this.calls.push(
      `clickAt ${at === null ? "null" : `${at.x},${at.y}`}${optsSuffix(opts)}`,
    );
    this.mouseAt = at;
  }

  async type(
    ref: string | null,
    text: string,
    opts: TypeOptions,
  ): Promise<{ selected: string[] } | null> {
    // 记法与旧的两条路径一致：带 ref 是替换，不带 ref 是整段插入。
    if (ref !== null) {
      this.calls.push(
        `type ${ref} ${text} ${opts.submit}${opts.perKey ? " perKey" : ""}`,
      );
      return null;
    }
    this.calls.push(`input text ${text}${opts.perKey ? " perKey" : ""}`);
    if (opts.submit) this.calls.push("press Enter");
    return null;
  }

  async press(key: string): Promise<void> {
    this.calls.push(`press ${key}`);
  }

  async screenshot(): Promise<Buffer> {
    this.calls.push("screenshot");
    return Buffer.from("jpeg");
  }

  async screenshotFull(): Promise<FullScreenshot> {
    this.calls.push("screenshotFull");
    return {
      bytes: Buffer.from("jpeg"),
      width: 1280,
      height: 800,
      fullHeight: 800,
    };
  }

  async screenshotOf(ref: string): Promise<Buffer> {
    this.calls.push(`screenshotOf ${ref}`);
    return this.elementShot;
  }

  async screenshotRect(rect: {
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

  async assets(scope?: { ref?: string }): Promise<PageAsset[]> {
    this.calls.push(`assets ${scope?.ref ?? ""}`.trim());
    return this.pageAssets;
  }

  async fetchAssets(
    urls: string[],
    opts: { referer: string; maxBytes: number },
    onResult: (r: AssetResult) => Promise<void>,
  ): Promise<void> {
    this.calls.push(`fetchAssets ${urls.join(",")} referer=${opts.referer}`);
    for (const r of this.assetResults) await onResult(r);
  }

  async request(spec: HttpRequestSpec): Promise<HttpResult> {
    this.calls.push(`request ${spec.method} ${spec.url}`);
    this.requests.push({ ...spec, headers: { ...spec.headers } });
    return (
      this.requestResults.shift() ?? {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: [],
        bytes: Buffer.alloc(0),
        ms: 1,
      }
    );
  }

  async identityCookies(identity: string): Promise<string[] | null> {
    this.calls.push(`identityCookies ${identity}`);
    return this.identityJars[identity] ?? null;
  }

  async upload(
    ref: string,
    files: { name: string; buffer: Buffer }[],
  ): Promise<void> {
    this.calls.push(`upload ${ref} ${files.map((f) => f.name).join(",")}`);
  }

  console(): ConsoleEntry[] {
    return [...this.consoleEntries];
  }

  consoleEvicted(): number {
    return this.consoleDropped;
  }

  network(): NetworkEntry[] {
    return this.networkItems.map((e) => ({ ...e }));
  }

  networkEvicted(): number {
    return this.networkDropped;
  }

  async networkDetail(id: number): Promise<NetworkDetail | null> {
    const entry = this.networkItems.find((e) => e.id === id);
    if (!entry) return null;
    return {
      entry: { ...entry },
      requestHeaders: { ...this.networkHeaders },
      responseHeaders:
        entry.status === null ? null : { ...this.networkResponseHeaders },
      requestBodyBytes: this.networkRequestBodyBytes,
    };
  }

  async networkBody(
    id: number,
    which: "request" | "response",
  ): Promise<NetworkBody | null> {
    const entry = this.networkItems.find((e) => e.id === id);
    if (!entry) return null;
    return (
      this.networkBodies[`${id}:${which}`] ??
      (which === "request"
        ? { ok: false, reason: "这个请求没有请求体" }
        : { ok: false, reason: "请求还没有响应（pending）" })
    );
  }

  onConsole(cb: (e: ConsoleEntry) => void): () => void {
    this.consoleSubs.add(cb);
    return () => this.consoleSubs.delete(cb);
  }

  async copied(): Promise<{ text: string; ts: number } | null> {
    return this.copiedValue;
  }

  async startScreencast(
    opts: {
      maxWidth: number;
      maxHeight: number;
      maxFps: number;
      quality: number;
    },
    onFrame: (jpeg: Buffer) => void | Promise<void>,
  ): Promise<void> {
    this.calls.push("startScreencast");
    this.screencastOpts = { ...opts };
    this.onFrame = onFrame;
  }

  async stopScreencast(): Promise<void> {
    this.calls.push("stopScreencast");
    this.screencastOpts = null;
    this.onFrame = null;
  }

  async input(ev: InputEvent): Promise<void> {
    this.calls.push(`input ${ev.type}`);
    this.inputs.push(ev);
  }

  async selection(): Promise<string> {
    this.calls.push("selection");
    return this.selected;
  }

  onChange(cb: () => void): () => void {
    this.changes.add(cb);
    return () => this.changes.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closers.add(cb);
    return () => this.closers.delete(cb);
  }

  onDownload(cb: (d: PageDownload) => void): () => void {
    this.downloadSubs.add(cb);
    return () => this.downloadSubs.delete(cb);
  }

  onFileChooser(cb: (c: PageFileChooser) => void): () => void {
    this.chooserSubs.add(cb);
    return () => this.chooserSubs.delete(cb);
  }

  dialog(): PageDialog | null {
    return this.dialogValue;
  }

  async answerDialog(accept: boolean, text?: string): Promise<boolean> {
    const at = this.dialogValue;
    if (!at) return false;
    this.calls.push(
      accept
        ? `answerDialog accept ${at.type === "prompt" ? (text ?? at.defaultValue) : ""}`.trim()
        : "answerDialog dismiss",
    );
    this.dialogValue = null;
    this.fireDialog();
    return true;
  }

  onDialog(cb: () => void): () => void {
    this.dialogSubs.add(cb);
    return () => this.dialogSubs.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.calls.push("close");
    this.fireClose();
  }

  // —— 测试钩子 ——

  /** 模拟地址 / 标题 / 加载状态变化。 */
  setUrl(url: string, title = this.currentTitle, loading = false): void {
    this.currentUrl = url;
    this.currentTitle = title;
    this.isLoading = loading;
    for (const cb of [...this.changes]) cb();
  }

  setTitle(title: string): void {
    this.currentTitle = title;
    for (const cb of [...this.changes]) cb();
  }

  /** 页面自己关了（用户点了关闭按钮、页面 window.close 之类），不是我们关的。 */
  fireClose(): void {
    for (const cb of [...this.closers]) cb();
    this.closers.clear();
    this.changes.clear();
    this.downloadSubs.clear();
    this.chooserSubs.clear();
    this.dialogSubs.clear();
    this.dialogValue = null;
  }

  /** 页面上弹出一个对话框（挂上，不自动回答）。 */
  emitDialog(dialog: PageDialog): void {
    this.dialogValue = dialog;
    this.fireDialog();
  }

  /** 对话框没了（被别处回答、超时、页面关闭）。 */
  closeDialog(): void {
    if (!this.dialogValue) return;
    this.dialogValue = null;
    this.fireDialog();
  }

  private fireDialog(): void {
    for (const cb of [...this.dialogSubs]) cb();
  }

  /** 页面上开始了一次下载：派发给订阅者（同 onDownload）。 */
  emitDownload(d: PageDownload): void {
    for (const cb of [...this.downloadSubs]) cb(d);
  }

  /** 页面里弹出了一次文件选择：派发给订阅者（同 onFileChooser）。 */
  emitFileChooser(c: PageFileChooser): void {
    for (const cb of [...this.chooserSubs]) cb(c);
  }

  /** 推一帧给当前的推流回调；没在推就什么也不做。 */
  async pushFrame(jpeg: Buffer): Promise<void> {
    await this.onFrame?.(jpeg);
  }

  /** 页面上打了一条控制台消息：进缓冲并发给订阅者。 */
  emitConsole(entry: ConsoleEntry): void {
    this.consoleEntries = [...this.consoleEntries, entry];
    for (const cb of [...this.consoleSubs]) cb(entry);
  }
}

export class FakeCtx implements BrowserCtx {
  readonly pages: FakePage[] = [];
  closed = false;
  /** newPage 抛这个错误。 */
  newPageError: Error | null = null;
  /** 新建的假页面会先过这个钩子（测试在此塞 goto 失败等）。 */
  pageInit: ((p: FakePage) => void) | null = null;
  /** seed 收到的状态，按到达顺序。 */
  readonly seeds: StorageState[] = [];
  /** 设置后 seed 抛这个错误。 */
  seedError: Error | null = null;
  private readonly popups = new Set<(p: PageHandle) => void>();

  async newPage(): Promise<PageHandle> {
    if (this.newPageError) throw this.newPageError;
    const page = new FakePage();
    this.pageInit?.(page);
    this.pages.push(page);
    return page;
  }

  onPopup(cb: (p: PageHandle) => void): () => void {
    this.popups.add(cb);
    return () => this.popups.delete(cb);
  }

  async storageState(): Promise<StorageState> {
    return { cookies: [], origins: [] };
  }

  async seed(state: StorageState): Promise<void> {
    if (this.seedError) throw this.seedError;
    this.seeds.push(state);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.pages) await p.close();
  }

  // —— 测试钩子 ——

  /** 页面自己开的新页面。 */
  popup(opener: PageHandle | null, url = "about:blank"): FakePage {
    const page = new FakePage(opener, url);
    this.pages.push(page);
    for (const cb of this.popups) cb(page);
    return page;
  }
}

export interface Harness {
  registry: PageRegistry;
  store: BrowserPageStore;
  thumbs: ThumbStore;
  db: Db;
  /** 库所在目录：重建注册表（模拟重启）时用。 */
  dataDir: string;
  /** 每个键的假上下文（惰性创建）。 */
  ctx(workspaceKey: string): FakeCtx;
  /** 根会话解析：默认自己就是根。 */
  parents: Map<string, string>;
  /** 正在跑一轮的根会话。 */
  busy: Set<string>;
  clock: { now: number };
  /** 会话显示名。 */
  labels: Map<string, string>;
  /** 到达 onDownload 的下载，按顺序（页面事件里的 PageView 同时记下）。 */
  downloads: Array<{ page: PageView; download: PageDownload }>;
  /** 到达 onFileChooser 的文件选择，按顺序（同上）。 */
  choosers: Array<{ page: PageView; chooser: PageFileChooser }>;
  /** 每个新建的假上下文都会先过这个钩子（测试可在这里让 newPage 失败等）。 */
  onCtx: ((c: FakeCtx) => void) | null;
  deps: RegistryDeps;
}

const made: string[] = [];
const registries: PageRegistry[] = [];

/** 建一个临时目录并登记，测试文件结束时由 cleanupTmpDirs() 删。 */
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** 删掉本文件建过的临时目录，并先把建过的注册表停掉（在测试文件的 afterAll 里调）。 */
export async function cleanupTmpDirs(): Promise<void> {
  for (const registry of registries.splice(0)) await registry.dispose();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

export function makeRegistry(overrides: Partial<RegistryDeps> = {}): Harness {
  const dataDir = tmpDir("yuanshu-pages-");
  const db = openDatabase(dataDir);
  const store = new BrowserPageStore(db);
  const thumbs = new ThumbStore(`${tmpDir("yuanshu-thumbs-")}/thumbs`); // latest 记注册表当前用的那个假上下文：onEngineCrash 之后它会换一个新的。
  const latest = new Map<string, FakeCtx>();
  const parents = new Map<string, string>();
  const busy = new Set<string>();
  const labels = new Map<string, string>();
  const downloads: Array<{ page: PageView; download: PageDownload }> = [];
  const choosers: Array<{ page: PageView; chooser: PageFileChooser }> = [];
  const clock = { now: Date.parse("2026-01-01T00:00:00.000Z") };

  const h: Harness = {
    registry: null as unknown as PageRegistry,
    store,
    thumbs,
    db,
    dataDir,
    parents,
    busy,
    clock,
    labels,
    downloads,
    choosers,
    ctx: (key) => {
      let c = latest.get(key);
      if (!c) {
        c = new FakeCtx();
        latest.set(key, c);
      }
      return c;
    },
    onCtx: null,
    deps: {
      store,
      thumbs,
      context: async (key) => {
        const c = new FakeCtx();
        latest.set(key, c);
        h.onCtx?.(c);
        return c;
      },
      rootOf: (s) => parents.get(s) ?? s,
      isBusy: (root) => busy.has(root),
      label: (s) => labels.get(s) ?? s.slice(0, 8),
      onDownload: (page, download) => void downloads.push({ page, download }),
      onFileChooser: (page, chooser) => void choosers.push({ page, chooser }),
      now: () => clock.now,
      ...overrides,
    },
  };

  // 时钟默认每次取用都往前走 1 秒：让「最久没用」有确定的先后；overrides 里给了 now 就用它。
  if (!overrides.now)
    h.deps.now = () => {
      clock.now += 1000;
      return clock.now;
    };

  h.registry = new PageRegistry(h.deps);
  registries.push(h.registry);
  return h;
}
