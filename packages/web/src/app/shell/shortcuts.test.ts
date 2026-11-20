import { expect, test } from "vitest";
import { isMac, type KeyLike, matchShortcut } from "./shortcuts";

const MAC = "MacIntel";
const LIN = "Linux x86_64";
const ev = (key: string, over: Partial<KeyLike> = {}): KeyLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

test("平台判定：Mac 用 ⌘，其余用 Ctrl", () => {
  expect(isMac(MAC)).toBe(true);
  expect(isMac("iPad")).toBe(true);
  expect(isMac(LIN)).toBe(false);
  expect(matchShortcut(ev("k", { metaKey: true }), MAC, false)).toEqual({
    kind: "palette",
  });
  expect(matchShortcut(ev("k", { ctrlKey: true }), MAC, false)).toBeNull();
  expect(matchShortcut(ev("k", { ctrlKey: true }), LIN, false)).toEqual({
    kind: "palette",
  });
  expect(matchShortcut(ev("k", { metaKey: true }), LIN, false)).toBeNull();
});

test("键位表：⌘K ⌘E ⌘⇧O ⌘N ⌘⇧N ⌘\\ ⌘1…6", () => {
  const m = (key: string, shiftKey = false) =>
    matchShortcut(ev(key, { ctrlKey: true, shiftKey }), LIN, false);
  expect(m("k")).toEqual({ kind: "palette" });
  expect(m("e")).toBeNull(); // 编辑会话的快捷键已取消
  expect(m("O", true)).toEqual({ kind: "overview" });
  expect(m("n")).toEqual({ kind: "newSession" });
  expect(m("N", true)).toEqual({ kind: "newWindow" });
  expect(m("\\")).toEqual({ kind: "toggleRail" });
  expect(m("1")).toEqual({ kind: "window", index: 0 });
  expect(m("6")).toEqual({ kind: "window", index: 5 });
});

test("不在表里的组合都不匹配：无修饰、7/0、Shift+数字、⌘Shift+K、Alt 参与、⌘Shift+\\", () => {
  const c = (key: string, over: Partial<KeyLike> = {}) =>
    matchShortcut(ev(key, { ctrlKey: true, ...over }), LIN, false);
  expect(matchShortcut(ev("k"), LIN, false)).toBeNull();
  expect(c("7")).toBeNull();
  expect(c("0")).toBeNull();
  expect(c("1", { shiftKey: true })).toBeNull();
  expect(c("k", { shiftKey: true })).toBeNull();
  expect(c("e", { shiftKey: true })).toBeNull();
  expect(c("k", { altKey: true })).toBeNull();
  expect(c("\\", { shiftKey: true })).toBeNull();
  expect(c("o")).toBeNull();
});

test("全屏层（创建/编辑面板、设置页）打开时全局键一律不抢", () => {
  for (const key of ["k", "e", "n", "1", "\\"])
    expect(matchShortcut(ev(key, { ctrlKey: true }), LIN, true)).toBeNull();
});

test("⌘, 打开设置：只认主修饰键，不带 Shift / Alt；全屏层打开时让位", () => {
  expect(matchShortcut(ev(",", { ctrlKey: true }), LIN, false)).toEqual({
    kind: "settings",
  });
  expect(matchShortcut(ev(",", { metaKey: true }), MAC, false)).toEqual({
    kind: "settings",
  });
  expect(matchShortcut(ev(",", { ctrlKey: true }), MAC, false)).toBeNull();
  expect(
    matchShortcut(ev(",", { ctrlKey: true, shiftKey: true }), LIN, false),
  ).toBeNull();
  expect(
    matchShortcut(ev(",", { ctrlKey: true, altKey: true }), LIN, false),
  ).toBeNull();
  expect(matchShortcut(ev(","), LIN, false)).toBeNull();
  expect(matchShortcut(ev(",", { ctrlKey: true }), LIN, true)).toBeNull();
});
