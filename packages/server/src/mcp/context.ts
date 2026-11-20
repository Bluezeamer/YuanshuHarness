import type { McpServerMeta } from "../store/mcp.js";
import type { McpStatus } from "./runtime.js";

// 右栏「已加载能力」里的一条 MCP：会话可见的服务及其当前握手状态。
export interface McpContextItem {
  name: string;
  state: "ready" | "connecting" | "pending" | "failed" | "disabled";
  // 会话里实际可见的工具数（排除 hidden）；pending = 登记了但这个会话还没加载（下一条消息或重载时才会连）
  tools: number;
  error?: string;
  /** 全局：每个会话都带上 */
  global: boolean;
  transport: "stdio" | "http";
  /** 运行位置：http 由 Server 直连，stdio 在逻辑 local 目录所在的主机上起；会话不在内存里时不知道 */
  where?: string;
}

// 状态以运行时最近一次连接结果为准（进程内），没有时看库里记录的最近一次握手；
// 从未列出过工具的服务没有向模型提供任何东西，按 failed 算。
export function mcpContextItem(
  s: McpServerMeta,
  status: McpStatus | undefined,
): McpContextItem {
  const base = {
    name: s.name,
    global: s.global,
    transport: s.config.transport,
  };
  if (!s.enabled) return { ...base, state: "disabled", tools: 0 };
  const tools =
    s.tools?.filter((t) => (s.toolExposure[t.name] ?? s.exposure) !== "hidden")
      .length ?? 0;
  const failed = status
    ? status.state === "error"
    : s.handshake?.ok === false || s.tools === null;
  if (!failed) return { ...base, state: "ready", tools };
  const error = status?.error ?? s.handshake?.error;
  return {
    ...base,
    state: "failed",
    tools,
    ...(error ? { error } : {}),
  };
}
