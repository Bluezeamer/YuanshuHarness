import type { RawData, WebSocket } from "ws";

// 三条 WebSocket 流（会话、终端、浏览器旁观）共用的两件事：心跳与慢客户端保护。
// 命令队列、二进制发送与各自的积压策略（会话断开、终端先暂停 pty、浏览器丢帧）留在原处。

/** 心跳：每 intervalMs 发一次 ping，pongTimeoutMs 内没回就掐断。返回的函数在连接关闭时调用。 */
export function startHeartbeat(
  socket: WebSocket,
  intervalMs: number,
  pongTimeoutMs: number,
): () => void {
  let pongTimer: NodeJS.Timeout | undefined;
  const ping = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    socket.ping();
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => socket.terminate(), pongTimeoutMs);
  }, intervalMs);
  socket.on("pong", () => clearTimeout(pongTimer));
  return () => {
    clearInterval(ping);
    clearTimeout(pongTimer);
  };
}

/**
 * 客户端的探活消息 `{"type":"ping"}`：回前台时确认连接还活着（浏览器脚本看不到协议层心跳），回任意一条消息即可。
 * 会话流的命令走自己的分派，画面流已经解析过 JSON，这里给不解析消息的两条流（列表、浏览器事件）用。
 */
export function isPing(raw: RawData, isBinary: boolean): boolean {
  if (isBinary) return false;
  try {
    const msg: unknown = JSON.parse(raw.toString());
    return (msg as { type?: unknown } | null)?.type === "ping";
  } catch {
    return false;
  }
}

/**
 * 待发送积压加上这一帧超过 max 就以 1013 断开并抛错，慢客户端不能让内存无界堆积。
 * allowWhenEmpty：队列为空时放行一整帧（帧本身有界，内存上界是「阈值加一帧」，大载荷不误伤健康连接）。
 */
export function failIfOverloaded(
  socket: WebSocket,
  size: number,
  max: number,
  allowWhenEmpty = false,
): void {
  if (allowWhenEmpty && socket.bufferedAmount === 0) return;
  if (socket.bufferedAmount + size > max) {
    socket.close(1013, "backpressure");
    throw new Error("backpressure");
  }
}
