import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createProbe, onForeground, PROBE_MS } from "./foreground";

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  // 信号合并按时间窗口算，模块级状态跨用例保留：每个用例从一个新的时刻开始。
  vi.advanceTimersByTime(60_000);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("可见、从缓存恢复、网络恢复各触发一次；变为隐藏不触发", () => {
  const cb = vi.fn();
  const off = onForeground(cb);
  setVisibility("hidden");
  expect(cb).not.toHaveBeenCalled();
  setVisibility("visible");
  expect(cb).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  window.dispatchEvent(new Event("pageshow"));
  expect(cb).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1000);
  window.dispatchEvent(new Event("online"));
  expect(cb).toHaveBeenCalledTimes(3);
  off();
});

test("同一次回前台连发的几个信号只算一次，窗口过后再来算新的", () => {
  const cb = vi.fn();
  const off = onForeground(cb);
  setVisibility("visible");
  window.dispatchEvent(new Event("pageshow"));
  window.dispatchEvent(new Event("online"));
  expect(cb).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  window.dispatchEvent(new Event("online"));
  expect(cb).toHaveBeenCalledTimes(2);
  off();
});

test("取消订阅后不再触发；多个订阅者各收到一次", () => {
  const a = vi.fn();
  const b = vi.fn();
  const offA = onForeground(a);
  const offB = onForeground(b);
  window.dispatchEvent(new Event("online"));
  expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
  offA();
  vi.advanceTimersByTime(1000);
  window.dispatchEvent(new Event("online"));
  expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 2]);
  offB();
});

test("探针：期限内有回音就不判死；没有回音只判死一次", () => {
  const ping = vi.fn(() => true);
  const dead = vi.fn();
  const probe = createProbe(ping, dead);

  probe.start();
  vi.advanceTimersByTime(PROBE_MS - 1);
  probe.settle();
  vi.advanceTimersByTime(PROBE_MS * 2);
  expect(dead).not.toHaveBeenCalled();

  probe.start();
  vi.advanceTimersByTime(PROBE_MS);
  expect(dead).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(PROBE_MS * 2);
  expect(dead).toHaveBeenCalledTimes(1);
});

test("探针单飞：在途时再 start 不重复发；回音之后可以再发", () => {
  const ping = vi.fn(() => true);
  const probe = createProbe(ping, vi.fn());
  probe.start();
  probe.start();
  expect(ping).toHaveBeenCalledTimes(1);
  probe.settle();
  probe.start();
  expect(ping).toHaveBeenCalledTimes(2);
  probe.cancel();
});

test("探针：发不出去直接判死不等期限；cancel 后不再判死", () => {
  const dead = vi.fn();
  createProbe(() => false, dead).start();
  expect(dead).toHaveBeenCalledTimes(1);

  const later = vi.fn();
  const probe = createProbe(() => true, later);
  probe.start();
  probe.cancel();
  vi.advanceTimersByTime(PROBE_MS * 2);
  expect(later).not.toHaveBeenCalled();
});
