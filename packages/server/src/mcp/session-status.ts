// 会话里每个 MCP 服务此刻的连接状态：传输层建连、握手应答、断开时各记一笔，
// 供右栏与 /mcp 弹窗显示。只在进程内，不落盘；重载时清空重来。
export type McpLiveState = "connecting" | "ready" | "failed";

export interface McpLive {
  state: McpLiveState;
  error?: string;
}

export class McpSessionStatus {
  private readonly items = new Map<string, McpLive>();

  /** 开始（重）连：旧的结果作废。 */
  connecting(name: string): void {
    this.items.set(name, { state: "connecting" });
  }

  ready(name: string): void {
    this.items.set(name, { state: "ready" });
  }

  /** 同一次连接里先记下的原因更具体（启动失败带 stderr），后到的「连接已关闭」不覆盖它。 */
  failed(name: string, error: string): void {
    if (this.items.get(name)?.state === "failed") return;
    this.items.set(name, { state: "failed", error });
  }

  get(name: string): McpLive | undefined {
    return this.items.get(name);
  }

  clear(): void {
    this.items.clear();
  }
}
