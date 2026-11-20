// 手机通知：只给设备令牌用（桌面的全局令牌调这些接口是 403）。与服务端 packages/server/src/api/push.ts 对应。
import { call, get } from "./http";

export type PushPolicy = "always" | "unwatched" | "delay";

export interface PushPrefs {
  blocked: boolean;
  error: boolean;
  done: boolean;
  policy: PushPolicy;
  delaySec: number;
}

export interface PushInfo {
  /** 浏览器订阅要用的 VAPID 公钥（base64url） */
  publicKey: string;
  subscribed: boolean;
  /** 没订阅时为 null */
  prefs: PushPrefs | null;
}

export const getPush = (token: string | null) =>
  get("/api/v1/push", token, (b: PushInfo) => b);

export const putPushSubscription = (
  token: string | null,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
) => call("PUT", "/api/v1/push/subscription", token, sub, () => undefined);

export const deletePushSubscription = (token: string | null) =>
  call(
    "DELETE",
    "/api/v1/push/subscription",
    token,
    undefined,
    () => undefined,
  );

export const patchPushPrefs = (
  token: string | null,
  patch: Partial<PushPrefs>,
) => call("PATCH", "/api/v1/push/prefs", token, patch, (b: PushPrefs) => b);

/** 发一条测试通知；502 = 推送服务那头失败了 */
export const testPush = (token: string | null) =>
  call("POST", "/api/v1/push/test", token, undefined, () => undefined);
