// 当前工作区的存取：本页签 sessionStorage、上次用的 localStorage。

import { beforeEach, expect, test } from "vitest";
import type { Workspace } from "../../../api/workspaces";
import {
  CURRENT_KEY,
  loadCurrent,
  resolveCurrent,
  saveCurrent,
} from "./currentWorkspace";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const ws = (id: string, archived = false): Workspace =>
  ({
    id,
    archived,
    order: 0,
    name: id,
  }) as unknown as Workspace;

test("resolveCurrent：保存的还在就用它，归档的也算", () => {
  const list = [ws("a"), ws("b", true)];
  expect(resolveCurrent("b", list)).toBe("b");
});

test("resolveCurrent：保存的不在就落到第一个未归档", () => {
  const list = [ws("a", true), ws("b"), ws("c")];
  expect(resolveCurrent("gone", list)).toBe("b");
  expect(resolveCurrent(null, list)).toBe("b");
});

test("resolveCurrent：全都归档时落到第一个；没有工作区返回 null", () => {
  expect(resolveCurrent("gone", [ws("a", true), ws("b", true)])).toBe("a");
  expect(resolveCurrent("gone", [])).toBeNull();
});

test("保存只写了 localStorage 时，新页签能继承", () => {
  localStorage.setItem(CURRENT_KEY, "w9");
  expect(loadCurrent()).toBe("w9");
});

test("sessionStorage 有值时优先于 localStorage", () => {
  localStorage.setItem(CURRENT_KEY, "old");
  sessionStorage.setItem(CURRENT_KEY, "mine");
  expect(loadCurrent()).toBe("mine");
});

test("saveCurrent 两处都写；null 两处都删", () => {
  saveCurrent("w1");
  expect(sessionStorage.getItem(CURRENT_KEY)).toBe("w1");
  expect(localStorage.getItem(CURRENT_KEY)).toBe("w1");

  saveCurrent(null);
  expect(sessionStorage.getItem(CURRENT_KEY)).toBeNull();
  expect(localStorage.getItem(CURRENT_KEY)).toBeNull();
  expect(loadCurrent()).toBeNull();
});
