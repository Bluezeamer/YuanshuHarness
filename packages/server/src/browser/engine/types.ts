// 引擎层对外的类型：上层（页面模型、工具、接口）只 import 这里，不碰 Playwright。
// 视口固定：界面按比例缩放显示，页面方不关心真实窗口大小。
export const VIEWPORT = { width: 1280, height: 800 } as const;

export type Problem = {
  code: "not_installed" | "download_failed" | "missing_libs" | "launch_failed";
  message: string; // 中文，直接给用户 / agent 看
  fix?: string; // 可直接复制的命令或操作提示
};

export type SandboxState =
  | { enabled: true }
  | { enabled: false; reason: string };

export interface EngineState {
  status: "idle" | "installing" | "starting" | "ready" | "failed";
  executable: string | null;
  sandbox: SandboxState | null; // ready 之后才有
  /** 这台机器上有没有彩色 emoji 字体（页面画面由 Server 本机的 Chromium 渲染，没有就是方块）；ready 之后才有 */
  emojiFont: boolean | null;
  problem: Problem | null; // failed 时有
}

export interface ConsoleEntry {
  id: number; // 组编号：同一缓冲内单调递增、整个生命周期不变（前端据此原地更新 ×n）
  ts: number; // 这一组最近一次出现的时间（Date.now()）
  firstTs: number; // 首次出现的时间
  count: number; // 出现次数，≥ 1
  kind: "console" | "error" | "request-failed";
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string; // 已对 URL 里的令牌类参数打码
  url?: string; // 来源位置或失败请求的地址（已打码）
}

/** 写入缓冲的原料：id / count / firstTs 由缓冲算。 */
export type ConsoleInput = Omit<ConsoleEntry, "id" | "count" | "firstTs">;

export interface NetworkEntry {
  id: number; // 每页独立，单调递增，从 1 起
  ts: number; // 开始时间（Date.now()）
  method: string;
  url: string; // 原样
  type: string; // Playwright 的 resourceType：document / stylesheet / image / media / font / script / xhr / fetch / websocket / other …
  frame: "main" | "sub"; // 发起请求的 frame 是不是主 frame（取不到就当 sub）
  status: number | null; // 还没收到响应是 null
  mime: string; // 响应 content-type 去掉参数部分；没有响应或没有这个头是空串
  size: number | null; // 响应体字节数（requestfinished 之后取 request.sizes().responseBodySize）；未知是 null
  ms: number | null; // 开始到结束 / 失败的毫秒数（用 Date.now() 之差）；还没结束是 null
  failure: string | null; // requestfailed 的 errorText；没失败是 null
}

export interface NetworkDetail {
  entry: NetworkEntry;
  /** 请求头 / 响应头：名字小写，值原样。响应头在没收到响应时是 null */
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string> | null;
  /** 请求体字节数（没有请求体是 0）；WebSocket 的连接没有请求，是 null */
  requestBodyBytes: number | null;
}

/** 一条请求的某一侧内容。reason 是一行中文，直接给模型看。 */
export type NetworkBody =
  | { ok: true; mime: string; bytes: Buffer }
  | { ok: false; reason: string };

/** 页面里跑一段脚本的结果：返回值已在页面里序列化成 JSON 文字，或者脚本抛的异常。 */
export type ExecOutcome =
  | { kind: "value"; json: string }
  | { kind: "threw"; message: string };

/** 对命中的请求做什么。 */
export type RouteAction =
  /** 让请求失败（error 是 Playwright 的 errorCode，如 failed / blockedbyclient / connectionrefused，缺省 failed） */
  | { kind: "block"; error?: string }
  /** 不发请求，直接给一个造出来的响应 */
  | {
      kind: "mock";
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  /** 改写请求再发出去：headers 的值为 null 表示删掉这个头；url 改成别的地址（同协议） */
  | {
      kind: "modify";
      method?: string;
      url?: string;
      body?: string;
      headers?: Record<string, string | null>;
    }
  /** 请求照常发出，改写真实的响应：replace 只对文本响应体生效（全部出现处） */
  | {
      kind: "patch";
      status?: number;
      headers?: Record<string, string | null>;
      replace?: { find: string; with: string }[];
    };

export interface RouteRule {
  /** URL 的 glob（Playwright 语法：单个星号不跨 `/`，双星跨路径），如 `/api/**`、`https://x.test/*.png` */
  pattern: string;
  /** 只拦这个方法（大写）；缺省不限 */
  method?: string;
  /** 只拦这种资源类型（Playwright 的 resourceType：document / script / xhr / fetch / image …）；缺省不限 */
  type?: string;
  /** 处理前先等这么多毫秒（0–10000），用来造慢响应 */
  delayMs?: number;
  action: RouteAction;
}

export interface RouteInfo extends RouteRule {
  id: number; // 每页独立，单调递增，从 1 起
  hits: number; // 命中并处理的请求数
}

/** 一个 Cookie：属性都按浏览器里的实际情况给。 */
export interface PageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix 秒；会话 Cookie 是 -1 */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** 要写的 Cookie：没给 domain 就按当前页面地址设置（path 缺省按地址推），给了就按 domain + path。 */
export interface CookieInput {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface WebStorageEntry {
  key: string;
  value: string;
}

/** Web 存储的一次操作：与 browser_storage 的 op 一致。 */
export type WebStorageOp =
  | { op: "get"; key?: string }
  | { op: "set"; key: string; value: string }
  | { op: "delete"; key: string }
  | { op: "clear" };

// 用户接管时从前端来的输入，坐标是 VIEWPORT 内的 CSS 像素。
export type InputEvent =
  | {
      type: "mouse";
      action: "move" | "down" | "up";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      clickCount?: number;
    }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; action: "down" | "up"; key: string }
  | { type: "text"; text: string }; // 整段文字一次插入（中文输入法的结果走这里）

/** 位置目标：元素编号，或视口坐标（CSS 像素，左上角为原点）。 */
export type PointTarget = { ref: string } | { x: number; y: number };

/** 读 DOM 的范围：选择器（所有 frame 里各查一遍）、快照编号（该元素的子树）、null = 整个文档。 */
export type DomTarget = { selector: string } | { ref: string } | null;

/** 属性：value 已截到 4000 字符，length 是原长。 */
export interface DomAttr {
  name: string;
  value: string;
  length: number;
}
/** 文本节点：空白已折叠、已截到 2000 字符，length 是折叠后的原长。 */
export interface DomText {
  text: string;
  length: number;
}

export interface DomElement {
  tag: string; // 小写
  attrs: DomAttr[]; // 文档顺序
  /** 只有被查询直接命中的根元素才有：视口坐标（CSS 像素，取整），iframe 里的是 iframe 内部坐标 */
  box?: { x: number; y: number; width: number; height: number };
  /** 仅 img：自然尺寸（没加载完是 0×0） */
  natural?: { width: number; height: number };
  /** 仅 img / video / audio：currentSrc 非空，且与 src 属性（按文档 baseURI 解析后）不同时才给 */
  currentSrc?: string;
  /** 正文被省略时的一句说明（不渲染孩子）：见「规整」 */
  summary?: string;
  kids: (DomElement | DomText)[];
  /** open shadow root 里的内容（没有就省略） */
  shadow?: (DomElement | DomText)[];
}

export interface DomGroup {
  frame: { url: string; main: boolean };
  /** 选择器在这个 frame 里的命中总数（roots 只含前 200 个） */
  total: number;
  roots: DomElement[];
}

export interface DomCapture {
  groups: DomGroup[];
  /** 为防爆而在页面里设的上限被触发：序列化的节点数超过 20000 后不再往下读 */
  nodeCapHit: boolean;
}

export type ScrollArgs =
  | { to: string } // 滚到这个元素进入视口
  | {
      direction: "up" | "down" | "left" | "right";
      amount?: number; // 像素，缺省一屏
      at?: PointTarget; // 在哪个位置滚，缺省视口中心
    };

/** 页面实际滚到了哪：x / y 是 scrollX / scrollY 取整，width / height 是文档可滚范围，viewWidth / viewHeight 是视口。 */
export type ScrollPos = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewWidth: number;
  viewHeight: number;
};

export interface ClickOptions {
  count?: 1 | 2 | 3; // 缺省 1
  button?: "left" | "right"; // 缺省 left
}

export interface TypeOptions {
  submit: boolean; // 输入后回车
  perKey: boolean; // 逐键输入：每个字符发完整的 keydown / keypress / input / keyup，慢，但依赖按键事件的页面才认
}

/** 整页截图：height 是实际截到的高度，fullHeight 是文档真实高度（超过上限时 height 就是上限）。 */
export interface FullScreenshot {
  bytes: Buffer;
  width: number;
  height: number;
  fullHeight: number;
}

/** 一个要发的 HTTP 请求（以页面所在上下文的身份）。 */
export interface HttpRequestSpec {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** 命名身份（隔离的 cookie 罐）；没给就用页面所在上下文 */
  identity?: string;
}

/** 一次 HTTP 请求的结果：拿到了响应，或网络层没给响应。 */
export type HttpResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      /** 响应头，保持顺序与重复（Set-Cookie 会有多条）；名字小写 */
      headers: [string, string][];
      bytes: Buffer;
      ms: number;
    }
  | { ok: false; reason: string };

/** 一次要改的环境模拟项；没给的不动。值为 null 表示撤销这一项。 */
export interface EmulationPatch {
  /** 断网 */
  offline?: boolean;
  /** 弱网：任一项给了就按这组限速（latencyMs 毫秒、两个 Kbps 为 kbit/s；没给的项不限）；null 撤销限速（不影响 offline） */
  throttle?: {
    latencyMs?: number;
    downloadKbps?: number;
    uploadKbps?: number;
  } | null;
  /** CPU 变慢的倍数（≥ 1，1 等于不限）；null 撤销 */
  cpuSlowdown?: number | null;
  colorScheme?: "light" | "dark" | "no-preference" | null;
  reducedMotion?: "reduce" | "no-preference" | null;
  userAgent?: string | null;
  /** BCP 47，如 ja-JP；同时影响 navigator.language 与 Accept-Language */
  locale?: string | null;
  /** IANA 时区，如 Asia/Tokyo */
  timezone?: string | null;
  /** 关掉浏览器 HTTP 缓存 */
  cacheDisabled?: boolean;
}

/** 当前生效的覆盖（没覆盖的项是 null / false）。 */
export interface EmulationState {
  offline: boolean;
  throttle: {
    latencyMs: number;
    downloadKbps: number;
    uploadKbps: number;
  } | null; // 没限的项写 -1
  cpuSlowdown: number | null;
  colorScheme: "light" | "dark" | "no-preference" | null;
  reducedMotion: "reduce" | "no-preference" | null;
  userAgent: string | null;
  locale: string | null;
  timezone: string | null;
  cacheDisabled: boolean;
}

/** 页面里发生的一次下载（浏览器已经开始在下）。订阅者必须 saveTo 或 cancel 它。 */
export interface PageDownload {
  /** 浏览器建议的文件名（未清洗；落盘时由附件区清洗） */
  readonly filename: string;
  /** 文件地址，查询串里的令牌已打码；只用于说明 */
  readonly url: string;
  /**
   * 等下载完成，检查大小，再存到 dest（本机绝对路径，父目录已存在）；返回字节数。
   * 浏览器报下载失败、超时、超过 maxBytes 都抛 Error（message 一行中文，直接给模型看），并取消 / 删除这次下载。
   */
  saveTo(
    dest: string,
    opts: { maxBytes: number; timeoutMs: number },
  ): Promise<number>;
  /** 放弃这次下载；reason 写进该页的控制台缓冲（warn）。重复调用、下载已结束时无副作用。 */
  cancel(reason: string): Promise<void>;
}

/** 页面里弹出的一次文件选择（用户点了「选择文件」）。订阅者交文件；不管它就是取消。 */
export interface PageFileChooser {
  readonly multiple: boolean;
  /** 交文件：内容形式，理由同 PageHandle.upload。失败抛 Error（message 一行中文）。 */
  setFiles(files: { name: string; buffer: Buffer }[]): Promise<void>;
}

/** 页面里弹出、正等人回答的 JS 对话框。 */
export interface PageDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  /** prompt 的默认值；其它类型是空串 */
  defaultValue: string;
}

export interface PageHandle {
  readonly opener: PageHandle | null; // 由页面内 window.open / target=_blank 打开的新页面，指向它的来源
  url(): string;
  title(): Promise<string>;
  loading(): boolean;
  goto(url: string): Promise<{ status: number | null; deny: string | null }>; // deny = 代理响应头 X-Yuanshu-Deny 的值（没有则 null）
  /** 后退；没有上一页时不动作并返回 false。 */
  back(): Promise<boolean>;
  /** 前进；没有下一页时不动作并返回 false。 */
  forward(): Promise<boolean>;
  reload(): Promise<void>;
  /** 带编号的页面快照（ariaSnapshot ai 模式原文）。 */
  snapshot(): Promise<string>;
  /** 按选择器 / 快照编号 / 整个文档读页面的原始 DOM（规整后的纯数据，不动清洗层）。 */
  dom(target: DomTarget): Promise<DomCapture>;
  /**
   * 在页面自己的 JS 环境里跑一段脚本：script 是 async 函数的函数体（可 await、用 return 给结果）。
   * ref 给了就多一个变量 el（那个快照元素）。返回值在页面里序列化成 JSON 文字。
   */
  exec(script: string, ref: string | null): Promise<ExecOutcome>;
  /** scope "page"：当前页面地址会带上的 Cookie；"all"：这个工作区浏览器里的全部 Cookie。 */
  cookies(scope: "page" | "all"): Promise<PageCookie[]>;
  /** 写一个 Cookie；没给 domain 就按当前页面地址设置（path 缺省 /）。 */
  setCookie(cookie: CookieInput): Promise<void>;
  /** 删除 Cookie：给 name 只删这一个（在 scope 范围内），不给就删 scope 范围内的全部；返回删了几个。 */
  removeCookies(scope: "page" | "all", name?: string): Promise<number>;
  /** 主 frame 当前源的 localStorage / sessionStorage；op 与工具一致。 */
  webStorage(
    kind: "local" | "session",
    op: WebStorageOp,
  ): Promise<{ entries: WebStorageEntry[]; changed: number }>;
  /** 当前鼠标位置；还没动过鼠标、或主框架整页导航之后是 null。 */
  mouse(): { x: number; y: number } | null;
  /** 把鼠标移到目标（ref 现查元素中心，视口外先滚到可见处）。 */
  move(target: PointTarget): Promise<void>;
  scroll(args: ScrollArgs): Promise<{ before: ScrollPos; after: ScrollPos }>;
  /** 按住鼠标从 from 拖到 to（真实鼠标事件，能触发网页原生拖放）。 */
  drag(from: PointTarget, to: PointTarget): Promise<void>;
  /** 点元素（Playwright 的点击，带可见 / 遮挡 / 稳定性检查）；点完鼠标位置记为该元素中心。 */
  click(ref: string, opts?: ClickOptions): Promise<void>;
  /** 点坐标；pos 为 null 表示点当前鼠标位置（还没有位置就报错）。 */
  clickAt(
    pos: { x: number; y: number } | null,
    opts?: ClickOptions,
  ): Promise<void>;
  /**
   * 输入文字：带 ref 是替换内容（text 为空串表示清空），不带 ref 输入到当前聚焦的元素。
   * ref 指到原生下拉框（<select>）时 text 是要选的选项；选上了返回所选选项的文字，其余是 null。
   */
  type(
    ref: string | null,
    text: string,
    opts: TypeOptions,
  ): Promise<{ selected: string[] } | null>;
  press(key: string): Promise<void>;
  screenshot(): Promise<Buffer>; // 视口 JPEG
  /** 整页 JPEG（quality 70）；高度超过上限时只截前 30000 像素。 */
  screenshotFull(): Promise<FullScreenshot>;
  /** 元素截图（PNG）；ref 是快照编号。 */
  screenshotOf(ref: string): Promise<Buffer>;
  /** 视口内一块矩形（PNG）；rect 的坐标原点是当前视口左上角，宽高含两端像素。 */
  screenshotRect(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<Buffer>;
  /** 页面已加载的资源清单；scope.ref 只算这个元素子树引用的（img / video / audio 的地址与 poster）。 */
  assets(scope?: { ref?: string }): Promise<PageAsset[]>;
  /** 逐个取这些地址的字节：先浏览器缓存，取不到再用本上下文发新请求；每个结果经 onResult 交出，不攒着。 */
  fetchAssets(
    urls: string[],
    opts: { referer: string; maxBytes: number },
    onResult: (r: AssetResult) => Promise<void>,
  ): Promise<void>;
  /**
   * 往页面里的上传入口交文件。ref 指到 <input type=file> 本身：直接设文件（隐藏的 input 也行）；
   * 指到别的元素（自绘的「上传」按钮）：点它并接住弹出的文件选择框。
   * 文件以内容形式交出（不交路径）：浏览器是等页面真正读文件时才读的，交路径再删源文件会让
   * 页面读到 NotFoundError、表单提交上去是空字节；交出内容就没有这个时序问题。
   * Playwright 对内容形式的负载合计上限 50 MB（`>= 50 * 1024 * 1024` 就拒）。
   * 失败抛 Error（message 一行中文，直接给模型看）。
   */
  upload(ref: string, files: { name: string; buffer: Buffer }[]): Promise<void>;
  /** 以这个上下文（或它下面一个命名身份）的身份发一次 HTTP 请求，不跟随重定向。 */
  request(spec: HttpRequestSpec): Promise<HttpResult>;
  /** 命名身份罐里现在有哪些 cookie 的名字（没有这个身份返回 null）。 */
  identityCookies(identity: string): Promise<string[] | null>;
  /** 控制台与失败请求的折叠缓冲（每页 500 组），按首次出现升序。 */
  console(): ConsoleEntry[];
  /** 累计被挤出缓冲的出现次数（不是组数）；总次数 = 现存各组 count 之和 + 它。 */
  consoleEvicted(): number;
  /** 网络请求缓冲（每页环形保留最近 500 条），按开始时间升序。 */
  network(): NetworkEntry[];
  /** 累计被挤出网络缓冲的条数。 */
  networkEvicted(): number;
  /** 单条请求的详情（请求头、响应头与请求体大小）；编号不在缓冲里返回 null。 */
  networkDetail(id: number): Promise<NetworkDetail | null>;
  /** 一条请求的请求体或响应体；编号不在缓冲里返回 null。 */
  networkBody(
    id: number,
    which: "request" | "response",
  ): Promise<NetworkBody | null>;
  /** 加一条拦截规则；每页最多 20 条。 */
  routeAdd(rule: RouteRule): Promise<RouteInfo>;
  /** 删一条；没有这个编号返回 false。 */
  routeRemove(id: number): Promise<boolean>;
  /** 全部规则（按编号升序）。 */
  routeList(): RouteInfo[];
  /** 清掉全部，返回清了几条。 */
  routeClear(): Promise<number>;
  /** 改环境模拟（只改 patch 里给的项）；返回改完后的状态。 */
  emulate(patch: EmulationPatch): Promise<EmulationState>;
  /** 当前环境模拟状态。 */
  emulation(): EmulationState;
  /** 发一条 CDP 命令（页面级会话），返回结果对象；失败抛 Error（message 取 CDP 报错的第一行）。 */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** 新的组，或已有组的次数增加时回调（payload 是该组当前的拷贝）。 */
  onConsole(cb: (e: ConsoleEntry) => void): () => void;
  /** 页面里最近一次主动复制的内容（所有 frame 里取时间最新的）；没有复制过是 null。 */
  copied(): Promise<{ text: string; ts: number } | null>;
  /** 开始推画面；同一页同时只有一路。onFrame 返回的 Promise 结束后才确认下一帧（背压）。 */
  startScreencast(
    opts: {
      maxWidth: number;
      maxHeight: number;
      maxFps: number;
      quality: number;
    },
    onFrame: (jpeg: Buffer) => void | Promise<void>,
  ): Promise<void>;
  stopScreencast(): Promise<void>;
  input(ev: InputEvent): Promise<void>;
  /** 页面里选中的文字（含输入框里选的、跨源 iframe 里选的）；没有选中返回空串。 */
  selection(): Promise<string>;
  /** 此刻挂着的对话框；没有是 null。同一时刻最多一个。 */
  dialog(): PageDialog | null;
  /** 回答挂着的对话框：accept 为 true 是确定（prompt 的 text 是输入，缺省用 defaultValue），false 是取消；没有挂着的返回 false。 */
  answerDialog(accept: boolean, text?: string): Promise<boolean>;
  /** 对话框出现、被回答 / 超时 / 页面关闭而消失时回调（不带参数，调用方自己读 dialog()）。 */
  onDialog(cb: () => void): () => void;
  /** 导航、标题、加载状态变化。 */
  onChange(cb: () => void): () => void;
  /** 页面里开始的下载；没有订阅者时引擎直接取消这次下载。 */
  onDownload(cb: (d: PageDownload) => void): () => void;
  /** 页面里弹出的文件选择；没有订阅者时选择框直接失效（点了什么都不发生）。 */
  onFileChooser(cb: (c: PageFileChooser) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): Promise<void>;
}

/** 页面此刻已加载的一个资源（来自浏览器的资源树）。 */
export interface PageAsset {
  url: string;
  type: string; // 资源树的 type 小写：image / media / script / stylesheet / font / document / other …
  mime: string;
  size: number | null; // contentSize；没有或 0 是 null
  frame: "main" | "sub";
  /** 仅 image：页面里对应 <img> 的 alt 与自然尺寸（对不上就没有） */
  alt?: string;
  width?: number;
  height?: number;
}

export type AssetResult =
  | { url: string; ok: true; mime: string; bytes: Buffer; viaRequest: boolean }
  | { url: string; ok: false; reason: string };

export type StorageState = Awaited<
  ReturnType<import("playwright-core").BrowserContext["storageState"]>
>;

export interface ContextOptions {
  proxy: { server: string; username: string; password: string }; // 出站代理（另一片实现）；浏览器流量只走它
  storageState?: StorageState; // 登录态注入
}

export interface BrowserCtx {
  newPage(): Promise<PageHandle>;
  /** 页面内自己打开的新页面（弹窗、target=_blank）；不含 newPage() 创建的。 */
  onPopup(cb: (page: PageHandle) => void): () => void;
  storageState(): Promise<StorageState>; // 含 indexedDB，不含 sessionStorage
  /**
   * 把一份登录态补进这个已存在的上下文：cookie 直接加；localStorage 要先在该源下有文档才写得进，
   * 所以每个有 localStorage 的源开一个临时页（请求在路由里就回掉、不出网，不走代理），写完关掉。
   * IndexedDB 补不进已存在的上下文，跳过。临时页不是任何人的页面：登记进 ours、不 track、不触发 popup 回调。
   */
  seed(state: StorageState): Promise<void>;
  close(): Promise<void>;
}
