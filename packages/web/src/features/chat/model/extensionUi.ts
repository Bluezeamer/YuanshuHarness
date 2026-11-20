// 插件的单向 UI 事件（服务端 plugins/ui-context.ts 的 extension.ui）的纯解析。
// 事件不进会话快照，重连也不会重放：只是瞬时展示，所以这里不存状态，只决定「弹什么」。
//
// 这一批只接 notify（弹 toast）。setStatus / setWidget / setTitle / set_editor_text 没有现成位置，
// 要和聊天页脚、右侧状态一起设计（用户 2026-11-09 定），先丢弃。

export type ToastTone = "info" | "warn" | "danger";

export interface ExtensionToast {
  message: string;
  tone: ToastTone;
}

// pi 的 notify 类型是 info / warning / error，对应到我们 toast 的三种语气
const TONES: Record<string, ToastTone> = {
  info: "info",
  warning: "warn",
  error: "danger",
};

// 一条通知可能很长（比如 MCP 的失败原因带整段 stderr）：toast 只留前面这些，全文在 /mcp 里看
export const TOAST_MAX = 240;

/** extension.ui 帧的 data → 要弹的 toast；不是要弹的（或没有正文）返回 null。 */
export function toastOf(data: Record<string, unknown>): ExtensionToast | null {
  if (data.method !== "notify") return null;
  const raw = typeof data.message === "string" ? data.message.trim() : "";
  if (raw === "") return null;
  const message = raw.length > TOAST_MAX ? `${raw.slice(0, TOAST_MAX)}…` : raw;
  const tone =
    typeof data.notifyType === "string"
      ? (TONES[data.notifyType] ?? "info")
      : "info";
  return { message, tone };
}
