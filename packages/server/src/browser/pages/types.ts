// 页面模型的类型与错误码。错误信息直接给模型和用户看，所以是中文。
import type { PageDialog } from "../engine/types.js";

export type PageErrorCode =
  | "not_found"
  | "user_controlling"
  | "busy"
  | "user_page"
  | "limit"
  | "context_failed"
  | "dialog_pending";

export class PageError extends Error {
  constructor(
    readonly code: PageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PageError";
  }
}

/** 用户页上挂起、等用户决定存到哪的下载（前端弹窗据此问）。 */
export interface PendingDownloadView {
  id: string;
  filename: string;
}

/** 用户页上等用户选文件的选择器（前端据此弹文件选择框）。 */
export interface PendingUploadView {
  id: string;
  multiple: boolean;
}

export interface PageView {
  id: string;
  workspaceKey: string;
  url: string;
  title: string;
  state: "active" | "sleeping";
  controller: "agent" | "user";
  userOpened: boolean;
  /** 用过这个页面的根会话（打开它的、认领过它的）。 */
  usedBy: string[];
  /** 当前动手的根会话；仅内存，重启后无人。 */
  inUseBy: string | null;
  loading: boolean;
  hasThumb: boolean;
  epoch: number;
  viewers: number;
  handoffPending: boolean;
  /** agent 请用户接管时给的原因；没有在等为 null。 */
  handoffReason: string | null;
  /** 用户页上挂起的下载；只在内存里，重启即忘。 */
  pendingDownloads: PendingDownloadView[];
  /** 用户页上等用户选文件的选择器；只在内存里，重启即忘。 */
  pendingUpload: PendingUploadView | null;
  /** 页面挂着的 JS 对话框；页面主线程被它卡住，要先回答。休眠页是 null。 */
  dialog: PageDialog | null;
  createdAt: string;
  lastUsedAt: string;
}

/** 用户对「agent 请你接管」的答复：在页面横幅上点，或点「交还 agent」。 */
export type HandoffAnswer =
  | { kind: "done" }
  | { kind: "refused"; reason: string };

export type PageEvent =
  | { type: "added" | "updated"; page: PageView }
  | { type: "removed"; id: string; workspaceKey: string };

export interface Limits {
  perWorkspace: number;
  global: number;
  sleepingPerWorkspace: number;
}

export const DEFAULT_LIMITS: Limits = {
  perWorkspace: 12,
  global: 30,
  sleepingPerWorkspace: 100,
};
