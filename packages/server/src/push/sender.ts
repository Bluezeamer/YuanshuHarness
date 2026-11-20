import { generateRequestDetails } from "web-push";
import { encodePayload, type PushPayload } from "./payload.js";

// 一条载荷发到一个订阅。自己发 HTTP（不用 webpush.sendNotification）：
// 后者只认 https，本地假推送端点测不了。
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type SendResult =
  | { ok: true }
  | { ok: false; gone: boolean; status?: number; error: string };

export type PushSender = (
  target: PushTarget,
  payload: PushPayload,
) => Promise<SendResult>;

// TTL 取小时级：审批会在服务端一直挂着，晚一点送达仍有意义。
const TTL = 4 * 3600;
const TIMEOUT_MS = 10_000;
const BODY_IN_ERROR_MAX = 200;

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function createSender(opts: {
  vapid: { publicKey: string; privateKey: string; subject: string };
  fetch?: typeof fetch;
}): PushSender {
  const doFetch = opts.fetch ?? fetch;

  return async (target, payload) => {
    let req: ReturnType<typeof generateRequestDetails>;
    try {
      req = generateRequestDetails(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        encodePayload(payload),
        {
          vapidDetails: opts.vapid,
          TTL,
          urgency: "high",
          contentEncoding: "aes128gcm",
        },
      );
    } catch (err) {
      // 订阅密钥坏了不属于「端点没了」，别删订阅。
      return { ok: false, gone: false, error: reason(err) };
    }

    // Content-Length 交给 fetch 按请求体自己算：pi 的 SDK 给全局 fetch 装的 undici 会把手写的值当非法头拒掉
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([name]) => name.toLowerCase() !== "content-length",
      ),
    );
    try {
      const res = await doFetch(req.endpoint, {
        method: req.method,
        headers,
        body: req.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 201 || res.status === 202)
        return { ok: true };
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        gone: res.status === 404 || res.status === 410,
        status: res.status,
        error: `${res.status} ${body.slice(0, BODY_IN_ERROR_MAX)}`.trim(),
      };
    } catch (err) {
      return { ok: false, gone: false, error: reason(err) };
    }
  };
}
