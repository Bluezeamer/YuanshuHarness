import type { ContextMcp } from "../../../api/flows";

// /mcp 弹窗与右栏共用的 MCP 状态词。连接是后台建的：connecting 是还没有结果，不是失败。
export const MCP_STATE_TEXT: Record<ContextMcp["state"], string> = {
  ready: "就绪",
  connecting: "连接中",
  pending: "待加载",
  failed: "连接失败",
  disabled: "已停用",
};

export const MCP_TONE = {
  ready: "live",
  connecting: "warn",
  pending: "idle",
  failed: "danger",
  disabled: "idle",
} as const;

const ORDER: Record<ContextMcp["state"], number> = {
  failed: 0,
  connecting: 1,
  pending: 2,
  ready: 3,
  disabled: 4,
};

/** 要处理的排前面：失败、连接中、就绪、停用；同类按名字。 */
export const sortMcp = (list: readonly ContextMcp[]): ContextMcp[] =>
  [...list].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name),
  );

export const stillConnecting = (list: readonly ContextMcp[]): boolean =>
  list.some((m) => m.state === "connecting");

/** 运行位置：http 由 Server 直连；stdio 在会话第一个目录所在的主机上起，会话没在内存里时说不准。 */
export const whereText = (m: ContextMcp): string =>
  m.where === undefined
    ? m.transport === "http"
      ? "Server 直连"
      : "会话第一个目录所在的主机"
    : m.where === "Server"
      ? "Server 直连"
      : m.where;

/** 有 stdio 服务才需要提醒「依赖要在运行位置自行装好」。 */
export const needsHostDeps = (list: readonly ContextMcp[]): boolean =>
  list.some((m) => m.transport === "stdio" && m.state === "failed");
