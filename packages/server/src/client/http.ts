import type { ClientOptions } from "./options.js";

// message 是给人看的一行原因，不含令牌。
export class ClientError extends Error {}

export interface SessionSummary {
  id: string;
  name: string | null;
  running: boolean;
}

function reason(res: Response): string {
  switch (res.status) {
    case 401:
      return "认证失败：令牌缺失或不正确（用环境变量 YUANSHU_TOKEN 提供）";
    case 403:
      return "被拒绝：本机地址不在服务端允许的来源网段内";
    case 429:
      return `尝试过于频繁，请 ${res.headers.get("retry-after") ?? "?"} 秒后再试`;
    case 501:
      return "服务端没有会话后端，无法创建会话";
    case 404:
      return "会话不存在";
    default:
      return `服务端返回 ${res.status}`;
  }
}

async function call(
  opts: ClientOptions,
  method: string,
  path: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(opts.url.replace(/\/$/, "") + path, {
      method,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    });
  } catch (err) {
    // 只取底层错误码，不带 fetch 的完整错误对象。
    const code = (err as { cause?: { code?: string } }).cause?.code;
    throw new ClientError(`无法连接 ${opts.url}${code ? `（${code}）` : ""}`);
  }
  if (!res.ok) throw new ClientError(reason(res));
  return res.json();
}

export async function listSessions(
  opts: ClientOptions,
): Promise<SessionSummary[]> {
  const body = (await call(opts, "GET", "/api/v1/sessions")) as {
    sessions: SessionSummary[];
  };
  return body.sessions;
}

export async function createSession(opts: ClientOptions): Promise<string> {
  const body = (await call(opts, "POST", "/api/v1/sessions")) as { id: string };
  return body.id;
}

// attach 前预检：升级被拒时 WebSocket 拿不到状态码，所以先用 HTTP 得到可读原因。
export async function checkSession(
  opts: ClientOptions,
  id: string,
): Promise<void> {
  await call(opts, "GET", `/api/v1/sessions/${encodeURIComponent(id)}`);
}
