// 浏览器这一侧的推送订阅：纯逻辑与对 Push API 的薄封装，界面状态在 usePush.ts。
import type { PushInfo } from "../../api/push";

export type Unavailable = "insecure" | "unsupported" | "ios-install";

/** 这个环境能不能用通知；不能的话说明为什么（界面据此给不同的话） */
export function pushUnavailable(env: {
  secure: boolean;
  hasWorker: boolean;
  hasPush: boolean;
  hasNotification: boolean;
  ios: boolean;
  standalone: boolean;
}): Unavailable | null {
  if (!env.secure) return "insecure";
  if (env.hasWorker && env.hasPush && env.hasNotification) return null;
  // iOS 的 Safari 标签页里没有推送，要先添加到主屏幕、从那里打开
  return env.ios && !env.standalone ? "ios-install" : "unsupported";
}

export const currentUnavailable = (
  ios: boolean,
  standalone: boolean,
): Unavailable | null =>
  pushUnavailable({
    secure: window.isSecureContext,
    hasWorker: "serviceWorker" in navigator,
    hasPush: "PushManager" in window,
    hasNotification: "Notification" in window,
    ios,
    standalone,
  });

/** VAPID 公钥是 base64url，pushManager.subscribe 要字节 */
export function urlBase64ToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface Subscribed {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const toSubscribed = (sub: PushSubscription): Subscribed | null => {
  const j = sub.toJSON();
  const { p256dh, auth } = j.keys ?? {};
  return j.endpoint && p256dh && auth
    ? { endpoint: j.endpoint, keys: { p256dh, auth } }
    : null;
};

/** 本浏览器已有的订阅（没有就是 null） */
export async function existingSubscription(): Promise<Subscribed | null> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? toSubscribed(sub) : null;
}

/** 订阅；换过 VAPID 公钥（比如重建了数据目录）时旧订阅会让 subscribe 抛错，先退订再订 */
export async function subscribe(info: PushInfo): Promise<Subscribed | null> {
  const reg = await navigator.serviceWorker.ready;
  const key = urlBase64ToBytes(info.publicKey);
  const opts = { userVisibleOnly: true, applicationServerKey: key };
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe(opts);
  } catch (e) {
    if ((e as DOMException).name !== "InvalidStateError") throw e;
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    sub = await reg.pushManager.subscribe(opts);
  }
  return toSubscribed(sub);
}

export async function unsubscribe(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
}
