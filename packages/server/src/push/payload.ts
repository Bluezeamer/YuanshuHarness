// 推送载荷：只有事件类型、会话 id 与标题——命令与输出绝不上通知。
// 大小压在 2 KB 内（FCM 桥接给 Firefox 的上限约 2744 字节）。
export type PushKind = "blocked" | "error" | "done" | "resolved" | "test";

export interface PushPayload {
  v: 1;
  kind: PushKind;
  sid: string;
  title: string;
  // 同一会话的通知共用一个 tag：新的替换旧的，不叠加。
  tag: string;
}

const TITLE_MAX = 60;
const PAYLOAD_MAX = 2048;

// 按码点截断，别在代理对中间切开。
const trimTitle = (title: string): string => {
  const cps = Array.from(title);
  return cps.length <= TITLE_MAX
    ? title
    : `${cps.slice(0, TITLE_MAX).join("")}…`;
};

export function buildPayload(
  kind: PushKind,
  sid: string,
  title: string,
): PushPayload {
  return {
    v: 1,
    kind,
    sid,
    title: trimTitle(title),
    tag: kind === "test" ? "test" : `s:${sid}`,
  };
}

export function encodePayload(p: PushPayload): string {
  let title = p.title;
  let json = JSON.stringify({ ...p, title });
  // 标题之外的部分不能缩，超预算就继续削标题。
  while (Buffer.byteLength(json) > PAYLOAD_MAX && title !== "") {
    title = Array.from(title).slice(0, -1).join("");
    json = JSON.stringify({ ...p, title });
  }
  return json;
}
