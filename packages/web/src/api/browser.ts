// 浏览器接口（工作区级）：页面列表与增删唤醒、控制权、控制台与缩略图、引擎重试，
// 以及事件流与页面画面流这两条 WebSocket。类型镜像服务端 packages/server/src/browser/。
import {
  type CallResult,
  enc,
  get,
  openSocket,
  type Result,
  send,
  sendJson,
} from "./http";

/* ---------------- 类型（字段名与服务端一致） ---------------- */

/** 引擎起不来的原因；message 是中文，可直接展示。 */
export interface Problem {
  code: "not_installed" | "download_failed" | "missing_libs" | "launch_failed";
  message: string;
  /** 可直接复制的修法 */
  fix?: string;
}

/** 沙箱没开时会带原因（降级运行），界面要醒目提示。 */
export type SandboxState =
  | { enabled: true }
  | { enabled: false; reason: string };

export interface EngineState {
  status: "idle" | "installing" | "starting" | "ready" | "failed";
  executable: string | null;
  /** ready 之后才有 */
  sandbox: SandboxState | null;
  /** 这台机器上有没有彩色 emoji 字体（没有页面里的表情是方块）；ready 之后才有 */
  emojiFont: boolean | null;
  /** failed 时有 */
  problem: Problem | null;
}

export interface PendingDownload {
  id: string;
  /** 浏览器建议的文件名，未清洗 */
  filename: string;
}

/** 用户页上等你选文件的文件选择器（页面里点了「选择文件」）；multiple 为假时只能给一个文件 */
export interface PendingUpload {
  id: string;
  multiple: boolean;
}

/** 页面里弹出、正等人回答的 JS 对话框；agent 与你都能答，先答先得，Server 里 120 秒无人回答就自动取消 */
export interface PageDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  /** prompt 的默认值；其它类型是空串 */
  defaultValue: string;
}

export interface PageView {
  id: string;
  workspaceKey: string;
  url: string;
  title: string;
  state: "active" | "sleeping";
  controller: "agent" | "user";
  /** 用户自己开的页面：不参与会话的引用计数，agent 默认碰不到 */
  userOpened: boolean;
  /** 用过这个页面的根会话（打开它的、认领过它的） */
  usedBy: string[];
  /** 当前动手的根会话；Server 重启后为 null */
  inUseBy: string | null;
  loading: boolean;
  hasThumb: boolean;
  epoch: number;
  viewers: number;
  handoffPending: boolean;
  /** agent 请求接管时写的原因；handoffPending 为假时是 null */
  handoffReason: string | null;
  /** 用户操作的页面上挂起、等你决定存到哪的下载（Server 里最多留 10 分钟） */
  pendingDownloads: PendingDownload[];
  /** 用户页上等你选文件的选择器；没有为 null（Server 里最多留 10 分钟） */
  pendingUpload: PendingUpload | null;
  /** 页面挂着的 JS 对话框（页面主线程被它卡住，要先答）；没有为 null */
  dialog: PageDialog | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface Limits {
  perWorkspace: number;
  global: number;
  sleepingPerWorkspace: number;
}

export interface ConsoleEntry {
  /** 组编号：同一个页面的缓冲里不变，同一条消息再出现时按它原地更新 ×n */
  id: number;
  /** 这一组最近一次出现的时间，Date.now() */
  ts: number;
  /** 首次出现的时间 */
  firstTs: number;
  /** 相同的消息（类别、级别、文字、地址都一致）出现的次数，≥ 1 */
  count: number;
  kind: "console" | "error" | "request-failed";
  level: "log" | "info" | "warn" | "error" | "debug";
  /** 已对地址里的令牌类参数打码 */
  text: string;
  url?: string;
}

/** 用户接管时从前端来的输入，坐标是 1280×800 画面内的像素。 */
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
  /** 整段文字一次插入（中文输入法的结果走这里） */
  | { type: "text"; text: string };

export interface BrowserOverview {
  engine: EngineState;
  pages: PageView[];
  limits: Limits;
}

/** 工作区见过、此刻在监听的服务端口；target 是地址栏里能直接输入的写法（server:3000、环境名:8080）。 */
export interface PortView {
  envId: string;
  port: number;
  target: string;
}

/**
 * 转发给用户自己浏览器用的服务：Server 在 localPort 上开了监听，地址是「访问 Server 的主机名:localPort」。
 * target 与 PortView.target 同一种写法，行上的名字共用 portLabel。
 */
export interface ForwardView {
  id: string;
  envId: string;
  port: number;
  target: string;
  localPort: number;
  /** 转发端口此刻是否在监听（Server 重启后端口被别的程序占了就是 false） */
  listening: boolean;
}

export type PageEvent =
  | { type: "added" | "updated"; page: PageView }
  | { type: "removed"; id: string; workspaceKey: string };

/** agent 请用户看一个页面（browser_show）：不阻塞，用户点「查看」才切过去。 */
export interface ShowRequest {
  /** 发起展示的会话 */
  sessionId: string;
  /** 会话名，提示里写「xxx 展示了一个页面」 */
  by: string;
  pageId: string;
  title: string;
  url: string;
  /** agent 写的一句说明，可为空串 */
  note: string;
}

/** 工作区级事件流的消息；连上先来一条 snapshot。show 是一次性的提示，不进状态。 */
export type BrowserEvent =
  | { type: "snapshot"; engine: EngineState; pages: PageView[]; limits: Limits }
  | { type: "page"; event: PageEvent }
  | { type: "engine"; state: EngineState }
  | { type: "show"; show: ShowRequest };

/** 页面级画面流的服务端文本帧。 */
export type StreamEvent =
  | { type: "state"; page: PageView; operator: boolean }
  | { type: "console"; entry: ConsoleEntry }
  | { type: "copied"; text: string } // 对 copy 的回答：页面里此刻选中的文字（可能是空串）
  | { type: "clipboard"; text: string } // 页面自己写了剪贴板（分享 / 复制按钮）；用户操作期间由 Server 推来
  | { type: "error"; message: string }
  | { type: "closed" };

/** 发给页面级画面流的消息（JSON 文本帧）。 */
export type StreamCommand =
  | { type: "input"; event: InputEvent }
  | { type: "nav"; action: "back" | "forward" | "reload" }
  | { type: "nav"; action: "goto"; target: string }
  | { type: "take" }
  // 请 Server 取页面里选中的文字，用 copied 回答（剪贴板只能由本机浏览器写）
  | { type: "copy" }
  // 收到一帧画面的确认：服务端据此限制在路上的画面量
  | { type: "ack" };

/* ---------------- 变更类调用 ---------------- */

/**
 * 变更类调用的结果：失败时 status 与 message 都留着。
 * 400 / 409 的解释（中文）在服务端错误体里，必须原样带给调用方，所以不走会丢掉它的 call。
 */
export type Act<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

const FALLBACK = "操作失败，请重试";
const OFFLINE = "网络不通，请稍后重试";

/** 服务端错误体 {error, message} 里的中文原因；拿不到时给一句通用的。 */
async function reason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown } | null;
    const message = body?.message;
    return typeof message === "string" && message !== "" ? message : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

async function act<T>(
  method: string,
  path: string,
  token: string | null,
  body: unknown,
  pick: (b: never) => T,
): Promise<Act<T>> {
  const res =
    body === undefined
      ? await send(path, { method }, token)
      : await sendJson(method, path, token, body);
  if (!res) return { ok: false, status: 0, message: OFFLINE };
  if (!res.ok)
    return { ok: false, status: res.status, message: await reason(res) };
  if (res.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: pick((await res.json()) as never) };
  } catch {
    return { ok: false, status: res.status, message: FALLBACK };
  }
}

const pagePath = (wid: string, pid: string, tail = "") =>
  `/api/v1/workspaces/${enc(wid)}/browser/pages/${enc(pid)}${tail}`;

/** 用户自己开页面：新页面一开始就是手动操作。 */
export const openPage = (
  token: string | null,
  wid: string,
  target: string,
): Promise<
  Act<{ page: PageView; status: number | null; deny: string | null }>
> =>
  act(
    "POST",
    `/api/v1/workspaces/${enc(wid)}/browser/pages`,
    token,
    { target },
    (b: { page: PageView; status: number | null; deny: string | null }) => b,
  );

export const wakePage = (
  token: string | null,
  wid: string,
  pid: string,
): Promise<Act<PageView>> =>
  act(
    "POST",
    pagePath(wid, pid, "/wake"),
    token,
    undefined,
    (b: PageView) => b,
  );

export const closePage = (
  token: string | null,
  wid: string,
  pid: string,
): Promise<Act<void>> =>
  act("POST", pagePath(wid, pid, "/close"), token, undefined, () => undefined);

export const setControl = (
  token: string | null,
  wid: string,
  pid: string,
  mode: "user" | "agent",
): Promise<Act<PageView>> =>
  act(
    "POST",
    pagePath(wid, pid, "/control"),
    token,
    { mode },
    (b: PageView) => b,
  );

/** 答复 agent 的接管请求：done = 已处理完，refused = 拒绝（reason 是给 agent 的原话）。 */
export type HandoffReply =
  | { outcome: "done" }
  | { outcome: "refused"; reason: string };

export const answerHandoff = (
  token: string | null,
  wid: string,
  pid: string,
  reply: HandoffReply,
): Promise<Act<void>> =>
  act("POST", pagePath(wid, pid, "/handoff"), token, reply, () => undefined);

const downloadPath = (wid: string, pid: string, did: string, tail = "") =>
  pagePath(wid, pid, `/downloads/${enc(did)}${tail}`);

/** 取一个待处理下载的内容（Server 等它下完再回；用户随后自己存到本机）。 */
export async function fetchPendingDownload(
  token: string | null,
  wid: string,
  pid: string,
  did: string,
): Promise<{ ok: true; data: Blob } | { ok: false; message: string }> {
  const res = await send(downloadPath(wid, pid, did), {}, token);
  if (!res) return { ok: false, message: OFFLINE };
  if (!res.ok) return { ok: false, message: await reason(res) };
  try {
    return { ok: true, data: await res.blob() };
  } catch {
    return { ok: false, message: FALLBACK };
  }
}

/** 放进工作区的某个目录（目录根下，重名自动加序号）；name 是最终文件名。 */
export const putPendingDownload = (
  token: string | null,
  wid: string,
  pid: string,
  did: string,
  directoryId: string,
): Promise<Act<{ name: string; path: string; directory: string }>> =>
  act(
    "POST",
    downloadPath(wid, pid, did, "/save"),
    token,
    { directoryId },
    (b: { name: string; path: string; directory: string }) => b,
  );

export const discardPendingDownload = (
  token: string | null,
  wid: string,
  pid: string,
  did: string,
): Promise<Act<void>> =>
  act("DELETE", downloadPath(wid, pid, did), token, undefined, () => undefined);

const uploadPath = (wid: string, pid: string, uid: string) =>
  pagePath(wid, pid, `/uploads/${enc(uid)}`);

/** 把用户选的本机文件交给页面的文件选择器（一次 multipart 请求，字段名 files）。 */
export async function uploadPageFiles(
  token: string | null,
  wid: string,
  pid: string,
  uid: string,
  files: readonly File[],
): Promise<Act<void>> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await send(
    uploadPath(wid, pid, uid),
    { method: "POST", body: form },
    token,
  );
  if (!res) return { ok: false, status: 0, message: OFFLINE };
  if (!res.ok)
    return { ok: false, status: res.status, message: await reason(res) };
  return { ok: true, data: undefined };
}

/** 不选了：页面的文件选择器保持原样，什么都不交。 */
export const cancelPageUpload = (
  token: string | null,
  wid: string,
  pid: string,
  uid: string,
): Promise<Act<void>> =>
  act("DELETE", uploadPath(wid, pid, uid), token, undefined, () => undefined);

/** 回答页面挂着的对话框：accept 为真是确定（prompt 的 text 是输入），假是取消；已被别处回答会失败（409）。 */
export const answerPageDialog = (
  token: string | null,
  wid: string,
  pid: string,
  answer: { accept: boolean; text?: string },
): Promise<Act<void>> =>
  act("POST", pagePath(wid, pid, "/dialog"), token, answer, () => undefined);

/** 引擎没装好或崩过时的「重试」：后台装 / 启动，进度走事件流。 */
export const ensureEngine = (token: string | null): Promise<Act<EngineState>> =>
  act(
    "POST",
    "/api/v1/browser/engine/ensure",
    token,
    undefined,
    (b: { engine: EngineState }) => b.engine,
  );

/**
 * 把环境里的服务转发出来（幂等：已有就返回它）。target 与地址栏同一种写法：
 * `3000`（工作区默认环境）、`server:3000`、`box:8080`；不要求此刻有服务在监听。
 */
export const openForward = (
  token: string | null,
  wid: string,
  target: string,
): Promise<Act<ForwardView>> =>
  act(
    "POST",
    `/api/v1/workspaces/${enc(wid)}/forwards`,
    token,
    { target },
    (b: ForwardView) => b,
  );

export const closeForward = (
  token: string | null,
  wid: string,
  id: string,
): Promise<Act<void>> =>
  act(
    "DELETE",
    `/api/v1/workspaces/${enc(wid)}/forwards/${enc(id)}`,
    token,
    undefined,
    () => undefined,
  );

/* ---------------- 读取 ---------------- */

export const getBrowser = (
  token: string | null,
  wid: string,
): Promise<CallResult<BrowserOverview>> =>
  get(`/api/v1/workspaces/${enc(wid)}/browser`, token, (b: BrowserOverview) => {
    if (!Array.isArray(b.pages)) throw new Error("shape");
    return b;
  });

export const getForwards = (
  token: string | null,
  wid: string,
): Promise<CallResult<ForwardView[]>> =>
  get(
    `/api/v1/workspaces/${enc(wid)}/forwards`,
    token,
    (b: { forwards: ForwardView[] }) => {
      if (!Array.isArray(b.forwards)) throw new Error("shape");
      return b.forwards;
    },
  );

export const getPorts = (
  token: string | null,
  wid: string,
): Promise<CallResult<PortView[]>> =>
  get(
    `/api/v1/workspaces/${enc(wid)}/browser/ports`,
    token,
    (b: { ports: PortView[] }) => {
      if (!Array.isArray(b.ports)) throw new Error("shape");
      return b.ports;
    },
  );

/** 休眠的页面没有控制台：服务端给空列表。 */
export const getConsole = (
  token: string | null,
  wid: string,
  pid: string,
): Promise<CallResult<ConsoleEntry[]>> =>
  get(
    pagePath(wid, pid, "/console"),
    token,
    (b: { entries: ConsoleEntry[] }) => {
      if (!Array.isArray(b.entries)) throw new Error("shape");
      return b.entries;
    },
  );

/** 休眠页的缩略图要带令牌，所以取成 Blob；没有缩略图或取失败时给 null。 */
export async function getThumb(
  token: string | null,
  wid: string,
  pid: string,
): Promise<Blob | null> {
  const res = await send(pagePath(wid, pid, "/thumb"), {}, token);
  if (!res?.ok) return null;
  try {
    return await res.blob();
  } catch {
    return null;
  }
}

/** 回放：一个会话在本工作区里的概况。 */
export interface ReplaySession {
  sessionId: string;
  steps: number;
  firstTs: string;
  lastTs: string;
}

/** 回放的一步：agent 一个改变页面的动作做完后的画面（画面单独取）与说明。 */
export interface ReplayStep {
  id: number;
  pageId: string;
  ts: string;
  tool: string;
  summary: string;
  url: string;
  title: string;
}

const replayPath = (wid: string, tail = "") =>
  `/api/v1/workspaces/${enc(wid)}/browser/replay${tail}`;

export const getReplaySessions = (
  token: string | null,
  wid: string,
): Promise<CallResult<ReplaySession[]>> =>
  get(replayPath(wid), token, (b: { sessions: ReplaySession[] }) => {
    if (!Array.isArray(b.sessions)) throw new Error("shape");
    return b.sessions;
  });

/** 这个会话在本工作区里没有任何步时服务端回 404。 */
export const getReplaySteps = (
  token: string | null,
  wid: string,
  sid: string,
): Promise<CallResult<ReplayStep[]>> =>
  get(replayPath(wid, `/${enc(sid)}`), token, (b: { steps: ReplayStep[] }) => {
    if (!Array.isArray(b.steps)) throw new Error("shape");
    return b.steps;
  });

/** 画面要带令牌，所以取成 Blob；取不到给 null。 */
export async function getReplayFrame(
  token: string | null,
  wid: string,
  sid: string,
  stepId: number,
): Promise<Blob | null> {
  const res = await send(
    replayPath(wid, `/${enc(sid)}/frames/${stepId}`),
    {},
    token,
  );
  if (!res?.ok) return null;
  try {
    return await res.blob();
  } catch {
    return null;
  }
}

/* ---------------- 登录状态 ---------------- */

/** 页面所属站点的登录状态：要不要提示用户保存。site 为 null = 这类页面（本机地址、IP）没有登录状态可言。 */
export interface LoginOffer {
  site: string | null;
  saved: boolean;
  offer: boolean;
}

/** 已保存的一个站点；不含任何 cookie / 存储内容。 */
export interface LoginMeta {
  site: string;
  /** 关了就不会注入新建的浏览器上下文 */
  enabled: boolean;
  savedAt: string;
  cookies: number;
  origins: number;
}

export const getLoginOffer = (
  token: string | null,
  wid: string,
  pid: string,
): Promise<Result<LoginOffer>> =>
  get(pagePath(wid, pid, "/login"), token, (b: LoginOffer) => b);

/** 把页面所属站点的当前登录状态存下来（覆盖旧的）；失败原因是中文，可直接展示。 */
export const saveLogin = (
  token: string | null,
  wid: string,
  pid: string,
): Promise<Act<LoginMeta>> =>
  act(
    "POST",
    pagePath(wid, pid, "/login"),
    token,
    undefined,
    (b: LoginMeta) => b,
  );

const LOGINS = "/api/v1/browser/logins";

export const listLogins = (
  token: string | null,
): Promise<Result<LoginMeta[]>> =>
  get(LOGINS, token, (b: { logins: LoginMeta[] }) => {
    if (!Array.isArray(b.logins)) throw new Error("shape");
    return b.logins;
  });

export const setLoginEnabled = (
  token: string | null,
  site: string,
  enabled: boolean,
): Promise<Act<{ site: string; enabled: boolean }>> =>
  act(
    "PATCH",
    `${LOGINS}/${enc(site)}`,
    token,
    { enabled },
    (b: { site: string; enabled: boolean }) => b,
  );

export const removeLogin = (
  token: string | null,
  site: string,
): Promise<Act<void>> =>
  act("DELETE", `${LOGINS}/${enc(site)}`, token, undefined, () => undefined);

/** 清空全部站点，返回删了几个。 */
export const clearLogins = (token: string | null): Promise<Act<number>> =>
  act(
    "DELETE",
    LOGINS,
    token,
    undefined,
    (b: { removed: number }) => b.removed,
  );

/* ---------------- WebSocket ---------------- */

/** 工作区级事件流：页面增删改与引擎状态（只读）。 */
export const openBrowserEvents = (
  wid: string,
  token: string | null,
): WebSocket =>
  openSocket(`/api/v1/workspaces/${enc(wid)}/browser/events`, token);

/** 页面级画面流：文本帧是状态，二进制帧是 JPEG。 */
export const openPageStream = (
  wid: string,
  pid: string,
  token: string | null,
): WebSocket => openSocket(pagePath(wid, pid, "/stream"), token);
