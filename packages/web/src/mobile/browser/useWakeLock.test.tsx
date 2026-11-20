import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useWakeLock } from "./useWakeLock";

const release = vi.fn(() => Promise.resolve());
const request = vi.fn(() => Promise.resolve({ release }));

function Probe({ on }: { on: boolean }) {
  useWakeLock(on);
  return null;
}

beforeEach(() => {
  release.mockClear();
  request.mockClear();
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "wakeLock", {
    value: { request },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "wakeLock");
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test("打开时申请屏幕常亮，卸载时释放", async () => {
  const { unmount } = render(<Probe on />);
  await flush();
  expect(request).toHaveBeenCalledWith("screen");
  unmount();
  expect(release).toHaveBeenCalledTimes(1);
});

test("回到前台重新申请；不启用、明文访问、浏览器没有这个接口时什么都不做", async () => {
  render(<Probe on />);
  await flush();
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(request).toHaveBeenCalledTimes(2);
  cleanup();

  request.mockClear();
  render(<Probe on={false} />);
  Object.defineProperty(window, "isSecureContext", {
    value: false,
    configurable: true,
  });
  render(<Probe on />);
  Reflect.deleteProperty(navigator, "wakeLock");
  Object.defineProperty(window, "isSecureContext", { value: true });
  render(<Probe on />);
  await flush();
  expect(request).not.toHaveBeenCalled();
});

test("申请被拒绝（省电模式、页面不可见）不抛错", async () => {
  request.mockRejectedValueOnce(new Error("NotAllowedError"));
  render(<Probe on />);
  await flush();
  expect(request).toHaveBeenCalledTimes(1);
});
