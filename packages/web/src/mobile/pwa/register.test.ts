import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Nav } from "../nav/nav";
import type { Route } from "../nav/route";
import { registerMobileServiceWorker } from "./register";

const sw = new EventTarget();
const nav = (route: Route) =>
  ({
    route: () => route,
    push: vi.fn(),
    replace: vi.fn(),
  }) as unknown as Nav & {
    push: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
  };
const message = (data: unknown) =>
  sw.dispatchEvent(new MessageEvent("message", { data }));

beforeEach(() => {
  Object.defineProperty(navigator, "serviceWorker", {
    value: Object.assign(sw, { register: vi.fn(async () => ({})) }),
    configurable: true,
  });
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
});
afterEach(() => Reflect.deleteProperty(navigator, "serviceWorker"));

test("点通知：sw 发 open-session，已在别的页面就推到那个会话；已经在这个会话就不动", () => {
  const n = nav({ name: "list" });
  registerMobileServiceWorker(n);
  message({ type: "open-session", sid: "s1" });
  expect(n.push).toHaveBeenCalledWith({ name: "chat", sid: "s1" });
});

test("已经在这个会话里：不重复推", () => {
  const n = nav({ name: "chat", sid: "s1" });
  registerMobileServiceWorker(n);
  message({ type: "open-session", sid: "s1" });
  expect(n.push).not.toHaveBeenCalled();
});

test("没有会话（测试通知）回列表；别的消息、坏消息忽略", () => {
  const n = nav({ name: "settings" });
  registerMobileServiceWorker(n);
  message({ type: "open-session", sid: "" });
  expect(n.replace).toHaveBeenCalledWith({ name: "list" });
  message({ type: "other" });
  message(null);
  message({ type: "open-session", sid: 3 });
  expect(n.push).not.toHaveBeenCalled();
});

test("明文（非安全上下文）下什么都不挂", () => {
  Object.defineProperty(window, "isSecureContext", {
    value: false,
    configurable: true,
  });
  const n = nav({ name: "list" });
  const spy = vi.spyOn(sw, "addEventListener");
  registerMobileServiceWorker(n);
  expect(spy).not.toHaveBeenCalled();
});
