// 设置页「通知」的状态与动作：浏览器订阅（pushClient）与服务端的订阅 / 偏好（api/push）两头对齐。
// 请求权限必须在用户手势里：enable() 只从按钮的点击里调，加载时绝不弹。
import { useCallback, useEffect, useState } from "react";
import { loadToken } from "../../api/http";
import {
  deletePushSubscription,
  getPush,
  type PushInfo,
  type PushPrefs,
  patchPushPrefs,
  putPushSubscription,
  testPush,
} from "../../api/push";
import { toast } from "../../ui";
import { isIos, isStandalone } from "./install";
import {
  currentUnavailable,
  existingSubscription,
  subscribe,
  type Unavailable,
  unsubscribe,
} from "./pushClient";

export type PushState =
  /** global = 用全局令牌登录的（没有设备身份），通知接口只认设备令牌 */
  | { phase: "unavailable"; why: Unavailable | "global" }
  | { phase: "loading" }
  | { phase: "error" }
  /** 还没开：可以点「开启」 */
  | { phase: "off"; denied: boolean }
  | { phase: "on"; prefs: PushPrefs };

export function usePush() {
  const why = currentUnavailable(isIos(navigator.userAgent), isStandalone());
  const [state, setState] = useState<PushState>(
    why ? { phase: "unavailable", why } : { phase: "loading" },
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (why) return;
    const r = await getPush(loadToken());
    if (!r.ok)
      return setState(
        r.kind === "forbidden"
          ? { phase: "unavailable", why: "global" }
          : { phase: "error" },
      );
    const denied = Notification.permission === "denied";
    // 服务端记着订阅，但浏览器这边已经没了（权限被收回、清了站点数据）：当作没开，重新点开启会补上
    const local = denied ? null : await existingSubscription();
    setState(
      r.data.subscribed && r.data.prefs && local
        ? { phase: "on", prefs: r.data.prefs }
        : { phase: "off", denied },
    );
  }, [why]);
  useEffect(() => void load(), [load]);

  const guard = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    guard(async () => {
      const perm = await Notification.requestPermission();
      if (perm !== "granted")
        return setState({ phase: "off", denied: perm === "denied" });
      const info = await getPush(loadToken());
      if (!info.ok) return toast("读取通知设置失败", { tone: "danger" });
      let sub: Awaited<ReturnType<typeof subscribe>>;
      try {
        sub = await subscribe(info.data as PushInfo);
      } catch {
        return toast("订阅失败：这台手机连不上推送服务", { tone: "danger" });
      }
      if (!sub)
        return toast("订阅失败：浏览器没有给出订阅信息", { tone: "danger" });
      const put = await putPushSubscription(loadToken(), sub);
      if (!put.ok) {
        await unsubscribe().catch(() => {});
        return toast("通知没有开启成功，请重试", { tone: "danger" });
      }
      await load();
    });

  const disable = () =>
    guard(async () => {
      await unsubscribe().catch(() => {});
      const r = await deletePushSubscription(loadToken());
      if (!r.ok) toast("通知没有关闭成功，请重试", { tone: "danger" });
      await load();
    });

  // 偏好改动立即生效（动作，不是草稿）；失败时回到服务端的值
  const patch = (change: Partial<PushPrefs>) =>
    guard(async () => {
      const r = await patchPushPrefs(loadToken(), change);
      if (!r.ok) toast("没有保存成功，请重试", { tone: "danger" });
      await load();
    });

  const test = () =>
    guard(async () => {
      const r = await testPush(loadToken());
      toast(r.ok ? "已发送，稍等几秒" : "发送失败：推送服务那边没有接受", {
        tone: r.ok ? "ok" : "danger",
      });
    });

  return { state, busy, enable, disable, patch, test };
}
