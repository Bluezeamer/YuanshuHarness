import { expect, test } from "vitest";
import {
  CREATABLE_TABS,
  hasHost,
  isHostType,
  isTabType,
  TAB_KINDS,
} from "./tabKinds";

test("「+」菜单的类型按事实表顺序，不含只能从别处点进去的对话、预览、执行体、后台任务", () => {
  expect(CREATABLE_TABS).toEqual(["term", "files", "web", "canvas"]);
});

test("主机三档：只有终端、文件、预览按主机隔离窗格；画布带主机但不隔离；对话、执行体、后台任务、浏览器没有主机", () => {
  const types = Object.keys(TAB_KINDS) as (keyof typeof TAB_KINDS)[];
  expect(types.filter(isHostType)).toEqual(["term", "files", "preview"]);
  expect(types.filter((t) => hasHost(t) && !isHostType(t))).toEqual(["canvas"]);
  expect(types.filter((t) => !hasHost(t))).toEqual([
    "chat",
    "sub",
    "job",
    "web",
  ]);
});

test("isTabType 只认事实表里的类型，不被原型上的属性名骗过", () => {
  expect(isTabType("files")).toBe(true);
  expect(isTabType("nope")).toBe(false);
  expect(isTabType("toString")).toBe(false);
  expect(isTabType(undefined)).toBe(false);
});
