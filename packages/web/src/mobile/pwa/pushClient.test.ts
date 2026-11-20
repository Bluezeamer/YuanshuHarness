import { afterEach, expect, test, vi } from "vitest";
import {
  pushUnavailable,
  subscribe,
  unsubscribe,
  urlBase64ToBytes,
} from "./pushClient";

const ok = {
  secure: true,
  hasWorker: true,
  hasPush: true,
  hasNotification: true,
  ios: false,
  standalone: false,
};

test("明文访问不可用，且优先说明这一条（别的条件再满足也没用）", () => {
  expect(pushUnavailable({ ...ok, secure: false })).toBe("insecure");
  expect(pushUnavailable({ ...ok, secure: false, hasPush: false })).toBe(
    "insecure",
  );
});

test("缺任何一个接口都是不支持；iOS 的标签页里要先添加到主屏幕，装好后再缺才是真不支持", () => {
  expect(pushUnavailable(ok)).toBeNull();
  expect(pushUnavailable({ ...ok, hasPush: false })).toBe("unsupported");
  expect(pushUnavailable({ ...ok, hasNotification: false })).toBe(
    "unsupported",
  );
  expect(pushUnavailable({ ...ok, hasWorker: false })).toBe("unsupported");
  expect(pushUnavailable({ ...ok, hasPush: false, ios: true })).toBe(
    "ios-install",
  );
  expect(
    pushUnavailable({ ...ok, hasPush: false, ios: true, standalone: true }),
  ).toBe("unsupported");
  expect(pushUnavailable({ ...ok, ios: true })).toBeNull();
});

test("VAPID 公钥 base64url → 字节：补齐、-_ 换回 +/", () => {
  // 0xfb 0xff 0xfe → base64 "+//+" → base64url "-__-"
  expect([...urlBase64ToBytes("-__-")]).toEqual([0xfb, 0xff, 0xfe]);
  expect([...urlBase64ToBytes("AQI")]).toEqual([1, 2]);
  expect(urlBase64ToBytes("").length).toBe(0);
});

const sub = (endpoint: string) => ({
  toJSON: () => ({ endpoint, keys: { p256dh: "P", auth: "A" } }),
  unsubscribe: vi.fn(async () => true),
});
function fakeWorker(pushManager: unknown) {
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve({ pushManager }) },
    configurable: true,
  });
}
afterEach(() => Reflect.deleteProperty(navigator, "serviceWorker"));

test("订阅：带公钥与 userVisibleOnly，结果整理成 endpoint + keys", async () => {
  const subscribeFn = vi.fn(async () => sub("https://push/x"));
  fakeWorker({ subscribe: subscribeFn, getSubscription: async () => null });
  const out = await subscribe({
    publicKey: "AQI",
    subscribed: false,
    prefs: null,
  });
  expect(out).toEqual({
    endpoint: "https://push/x",
    keys: { p256dh: "P", auth: "A" },
  });
  expect(subscribeFn).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([1, 2]),
  });
});

test("换过公钥（重建数据目录）：旧订阅让 subscribe 抛 InvalidStateError，先退订再重订；别的错误照抛", async () => {
  const old = sub("https://push/old");
  const fresh = sub("https://push/new");
  const subscribeFn = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("key changed", "InvalidStateError"))
    .mockResolvedValueOnce(fresh);
  fakeWorker({ subscribe: subscribeFn, getSubscription: async () => old });
  const out = await subscribe({
    publicKey: "AQI",
    subscribed: false,
    prefs: null,
  });
  expect(old.unsubscribe).toHaveBeenCalledTimes(1);
  expect(out?.endpoint).toBe("https://push/new");

  fakeWorker({
    subscribe: vi
      .fn()
      .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
    getSubscription: async () => null,
  });
  await expect(
    subscribe({ publicKey: "AQI", subscribed: false, prefs: null }),
  ).rejects.toThrow("denied");
});

test("订阅信息不全（没有 keys）当作没订阅上；退订会真的调浏览器的 unsubscribe", async () => {
  fakeWorker({
    subscribe: async () => ({ toJSON: () => ({ endpoint: "https://push/x" }) }),
    getSubscription: async () => null,
  });
  expect(
    await subscribe({ publicKey: "AQI", subscribed: false, prefs: null }),
  ).toBeNull();

  const cur = sub("https://push/c");
  fakeWorker({ getSubscription: async () => cur });
  await unsubscribe();
  expect(cur.unsubscribe).toHaveBeenCalledTimes(1);
});
