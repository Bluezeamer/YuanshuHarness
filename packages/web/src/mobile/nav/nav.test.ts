import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createNav, type Nav } from "./nav";

// jsdom 的 history 是真的：每个用例从一条干净的 /m/ 起步。
const reset = (url: string) => {
  history.replaceState(null, "", url);
};
let navs: Nav[] = [];
const make = (url: string): Nav => {
  reset(url);
  const nav = createNav();
  navs.push(nav);
  return nav;
};
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  navs = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("从列表进对话：压一条历史，返回回到列表；两个入口走同一个 back()", async () => {
  const nav = make("/m/");
  const seen = vi.fn();
  nav.subscribe(seen);
  nav.push({ name: "chat", sid: "s1" });
  expect(location.pathname).toBe("/m/s/s1");
  expect(nav.route()).toEqual({ name: "chat", sid: "s1" });
  expect(seen).toHaveBeenCalledTimes(1);

  nav.back();
  await settle();
  expect(location.pathname).toBe("/m/");
  expect(nav.route()).toEqual({ name: "list" });
  expect(seen).toHaveBeenCalledTimes(2);
});

test("直接打开深链接：栈底先换成列表，返回键落在列表而不是退出", async () => {
  const nav = make("/m/s/s9");
  expect(nav.route()).toEqual({ name: "chat", sid: "s9" });
  nav.back();
  await settle();
  expect(nav.route()).toEqual({ name: "list" });
});

test("弹层占一条历史，关闭就是返回；重复点同一处不叠历史", async () => {
  const nav = make("/m/");
  nav.push({ name: "list", layer: "new" });
  nav.push({ name: "list", layer: "new" });
  expect(history.state).toEqual({ d: 1 });
  nav.back();
  await settle();
  expect(nav.route()).toEqual({ name: "list" });
});

test("栈底按返回：深度为 0 又不在列表时换成列表，在列表上什么也不做", () => {
  const nav = make("/m/");
  const spy = vi.spyOn(history, "back");
  nav.back();
  expect(spy).not.toHaveBeenCalled();
  expect(nav.route()).toEqual({ name: "list" });

  history.replaceState({ d: 0 }, "", "/m/settings");
  expect(nav.route()).toEqual({ name: "settings" });
  nav.back();
  expect(spy).not.toHaveBeenCalled();
  expect(nav.route()).toEqual({ name: "list" });
});

test("route() 在 URL 没变时返回同一个对象", () => {
  const nav = make("/m/");
  expect(nav.route()).toBe(nav.route());
});

test("replace 不增加历史深度", () => {
  const nav = make("/m/");
  nav.push({ name: "chat", sid: "a" });
  nav.replace({ name: "chat", sid: "b" });
  expect(history.state).toEqual({ d: 1 });
  expect(nav.route()).toEqual({ name: "chat", sid: "b" });
});
