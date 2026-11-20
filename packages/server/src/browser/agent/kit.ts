// 工具共用的运行件：动作之后的审计与回放、取页面内容、下载窗口、高敏感站点的逐动作确认。
// 每个会话一份（带 sessionId），各工具文件拿同一个。
import type { PageDialog, PageHandle } from "../engine/types.js";
import type { Target } from "../net/target.js";
import { decideOpen, isHighValueHost } from "./access.js";
import { withNote } from "./approve.js";
import type { BrowserToolsDeps } from "./deps.js";
import { DOWNLOAD_GRACE_MS, settleDownloads } from "./download.js";

/** 页面复制的内容交给模型时的单条上限（字符）。 */
const CLIPBOARD_MAX = 500;
// 对话框文字与新页面提示里地址的截断长度。
const DIALOG_TEXT_MAX = 200;
const POPUP_URL_MAX = 200;

/** 对话框打断动作时的固定外壳：不取快照、不调清洗器（页面主线程被它卡死）。 */
function blockedByDialog(dialog: PageDialog, notes: string[] | undefined) {
  const message =
    dialog.message.length > DIALOG_TEXT_MAX
      ? `${dialog.message.slice(0, DIALOG_TEXT_MAX)}…(+${dialog.message.length - DIALOG_TEXT_MAX} chars)`
      : dialog.message;
  return [
    `BLOCKED BY DIALOG: ${dialog.type} "${message}"`,
    "The page is blocked until you answer it with browser_dialog (accept true/false; text for prompt). Other actions on this page are refused meanwhile; the dialog is dismissed automatically after 120 s.",
    ...(notes ?? []),
  ];
}

export interface Kit {
  deps: BrowserToolsDeps;
  sessionId: string;
  acted(tool: string, pageId: string, summary: string): Promise<void>;
  content(a: {
    pageId: string;
    handle: PageHandle;
    explicit?: boolean;
    action?: string;
    intent?: string;
    notes?: string[];
    signal?: AbortSignal;
  }): Promise<string>;
  withDownloads<T>(
    pageId: string | null,
    pageUrlOf: () => string,
    fn: () => Promise<T>,
  ): Promise<{ value: T; lines: string[] }>;
  /**
   * 站点授权：目标放行返回 null；否则返回不能访问的原因（被拒的原因，或「用户没有批准访问 <origin>」，
   * 用户写了理由时接在后面）。resolveTarget 由调用方先做（解析阶段被拒的地址在那里就抛错）；raw 是模型给的原始地址。
   */
  authorize(target: Target, raw: string): Promise<string | null>;
  /**
   * 动手前的逐动作确认。host 给了就按它判断高敏感站点（请求类工具按请求目标的主机），
   * 不给仍按页面地址的主机。
   */
  confirmAction(
    handle: PageHandle,
    tool: string,
    summary: string,
    host?: string,
  ): Promise<void>;
}

export function createKit(deps: BrowserToolsDeps, sessionId: string): Kit {
  // pageId → 已经报告过的最新复制时刻；每个会话一份，带出后不再带。
  const reported = new Map<string, number>();
  // 工作区键 → 已经报告到的新页面序号；第一次遇到只定游标，不报旧弹窗。
  const popupReported = new Map<string, number>();

  /** 动作做完了：写审计、记一步回放。同一个串给两边，回放里不另写一份说明。 */
  const acted = async (
    tool: string,
    pageId: string,
    summary: string,
  ): Promise<void> => {
    deps.audit?.({ tool, pageId, summary });
    // 回放要截一张画面：对话框挂着时截图会一直等（默认 30 秒），所以这一步跳过。
    if (deps.registry.peek(pageId)?.dialog() != null) return;
    await deps.recordStep?.({
      sessionId,
      workspaceKey: deps.workspaceKey(),
      pageId,
      tool,
      summary,
    });
  };

  /** 页面里还没报告过的新复制，写成一行 notes 追加在末尾；没有就是 null。 */
  const clipboardNote = async (handle: PageHandle, pageId: string) => {
    const copied = await handle.copied().catch(() => null);
    if (copied === null || copied.text === "") return null;
    if (copied.ts <= (reported.get(pageId) ?? 0)) return null;
    reported.set(pageId, copied.ts);
    const cut =
      copied.text.length > CLIPBOARD_MAX
        ? `${copied.text.slice(0, CLIPBOARD_MAX)}…(+${copied.text.length - CLIPBOARD_MAX} chars)`
        : copied.text;
    return `CLIPBOARD (page copied; web data, untrusted): ${JSON.stringify(cut)}`;
  };

  /** 页面动作后新开、还没报告过的页面，写成 notes 行（序号更早的旧弹窗不报）。 */
  const popupNotes = (): string[] => {
    const workspaceKey = deps.workspaceKey();
    const cursor = popupReported.get(workspaceKey);
    if (cursor === undefined) {
      popupReported.set(workspaceKey, deps.registry.popupSeq(workspaceKey));
      return [];
    }
    const found = deps.registry.popupsSince(workspaceKey, sessionId, cursor);
    if (found.length === 0) return [];
    // 先推进游标：这些页面之后不再重复报。
    popupReported.set(workspaceKey, deps.registry.popupSeq(workspaceKey));
    return found.map(({ page, openerId }) => {
      const url =
        page.url.length > POPUP_URL_MAX
          ? `${page.url.slice(0, POPUP_URL_MAX)}…(+${page.url.length - POPUP_URL_MAX} chars)`
          : page.url;
      const title = page.title === "" ? "(untitled)" : page.title;
      return `NEW PAGE: ${page.id} "${title}" ${url} (opened by ${openerId ?? "unknown"}) — pass this pageId to work with it`;
    });
  };

  /** 取页面内容：引擎快照交给清洗器，外壳、diff、模型路径都由它定。 */
  const content = async (a: {
    pageId: string;
    handle: PageHandle;
    explicit?: boolean;
    action?: string;
    intent?: string;
    notes?: string[];
    signal?: AbortSignal;
  }): Promise<string> => {
    const fresh = popupNotes();
    const notes = [...(a.notes ?? []), ...fresh];
    // 对话框挂着时页面主线程是死的：快照与剪贴板都会一直等，所以直接给固定外壳。
    const dialog = a.handle.dialog();
    if (dialog !== null)
      return [
        ...(a.action === undefined || a.action === ""
          ? []
          : [`ACTION: ${a.action}`]),
        ...blockedByDialog(dialog, notes),
      ].join("\n");
    // 在清洗之前把页面最近一次没报告过的复制带出来，追加在原有 notes 之后。
    const clipboard = await clipboardNote(a.handle, a.pageId);
    const all = clipboard === null ? notes : [...notes, clipboard];
    const raw = await a.handle.snapshot();
    const out = await deps.cleaner.clean({
      sessionId,
      pageId: a.pageId,
      raw,
      url: a.handle.url(),
      title: await a.handle.title(),
      explicit: a.explicit ?? false,
      ...(a.action === undefined ? {} : { action: a.action }),
      ...(a.intent === undefined ? {} : { intent: a.intent }),
      ...(all.length === 0 ? {} : { notes: all }),
      saveText: async (name, text) =>
        (
          await deps.saveAsset({
            sessionId,
            name,
            bytes: Buffer.from(text, "utf8"),
          })
        ).marker,
      ...(a.signal === undefined ? {} : { signal: a.signal }),
    });
    return out.text;
  };

  /**
   * 包住一次会触发下载的动作：期间（及动作后的宽限）收到的下载逐个审批、存附件、生成文字行；
   * 其余写法都从这里走，避免每处各处理一遍。
   */
  const withDownloads = async <T>(
    pageId: string | null,
    pageUrlOf: () => string,
    fn: () => Promise<T>,
  ): Promise<{ value: T; lines: string[] }> => {
    const { value, downloads, dropped } = await deps.downloads.collect(
      sessionId,
      pageId,
      fn,
      DOWNLOAD_GRACE_MS,
    );
    const lines = await settleDownloads(downloads, dropped, {
      pageUrl: pageUrlOf(),
      approve: (a) => deps.approveDownload(a),
      saveFile: (a) => deps.saveFile({ sessionId, ...a }),
      maxBytes: () => deps.fileMaxBytes(),
      audit: (summary) => deps.audit?.({ tool: "browser_download", summary }),
    });
    return { value, lines };
  };

  /**
   * 站点授权：放行返回 null，否则给不能访问的原因（被拒的原因，或用户没批准）。
   * 解析阶段被拒的地址由调用方在 resolveTarget 那里抛，不归这里管。
   */
  const authorize = async (
    target: Target,
    raw: string,
  ): Promise<string | null> => {
    const decision = decideOpen(target, deps.workspaceKey(), deps.access, raw);
    if (decision.kind === "allow") return null;
    if (decision.kind === "deny") return decision.reason;
    const verdict = await deps.approveOpen({
      origin: decision.origin,
      reason: decision.reason,
      ...(decision.service ? { service: true } : {}),
    });
    return verdict.allowed
      ? null
      : withNote(`用户没有批准访问 ${decision.origin}`, verdict.note);
  };

  /** 动手前的逐动作确认：只在高敏感站点的页面上问；摘要里不放输入的文字。 */
  const confirmAction = async (
    handle: PageHandle,
    tool: string,
    summary: string,
    givenHost?: string,
  ): Promise<void> => {
    if (!deps.confirmAction) return;
    let host = givenHost;
    if (host === undefined) {
      try {
        host = new URL(handle.url()).hostname;
      } catch {
        return;
      }
    }
    if (!isHighValueHost(host)) return;
    const verdict = await deps.confirmAction({ tool, host, summary });
    if (verdict.allowed) return;
    throw new Error(
      withNote(
        `用户没有批准在 ${host} 上执行「${summary}」：邮箱、云控制台、支付、代码托管这类站点的每个动作都要用户确认。`,
        verdict.note,
      ),
    );
  };

  return {
    deps,
    sessionId,
    acted,
    content,
    withDownloads,
    authorize,
    confirmAction,
  };
}
