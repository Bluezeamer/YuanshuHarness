import { afterEach, expect, test, vi } from "vitest";
import { captureInstallPrompt, isIos, isStandalone } from "./install";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "standalone");
});

test("已安装的判定：display-mode 是 standalone，或 iOS 的 navigator.standalone", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  expect(isStandalone()).toBe(false);
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("standalone"),
  }));
  expect(isStandalone()).toBe(true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(navigator, "standalone", {
    value: true,
    configurable: true,
  });
  expect(isStandalone()).toBe(true);
});

test("iOS 的判定", () => {
  expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(
    true,
  );
  expect(isIos("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe(false);
});

test("beforeinstallprompt 被捕获（不让浏览器自己弹），appinstalled 之后作废", async () => {
  captureInstallPrompt();
  const prompt = vi.fn(async () => {});
  const ev = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    },
  );
  window.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);

  const { renderHook, act } = await import("@testing-library/react");
  const { useInstall } = await import("./install");
  const { result } = renderHook(() => useInstall());
  expect(result.current.canPrompt).toBe(true);
  let accepted = false;
  await act(async () => {
    accepted = await result.current.prompt();
  });
  expect(accepted).toBe(true);
  expect(prompt).toHaveBeenCalledTimes(1);
  // 只能弹一次
  expect(result.current.canPrompt).toBe(false);
  await act(async () => {
    expect(await result.current.prompt()).toBe(false);
  });
});
