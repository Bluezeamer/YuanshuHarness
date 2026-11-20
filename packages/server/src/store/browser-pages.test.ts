// 页面记录与引用集合的落库：重启恢复与「用过它的会话」都靠这两张表。
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { BrowserPageStore, type PageRow } from "./browser-pages.js";
import { type Db, openDatabase } from "./db.js";

const setup = () => {
  const db: Db = openDatabase(makeTmpDir("yuanshu-pages-"));
  return { db, store: new BrowserPageStore(db) };
};

const row = (id: string, at: string, over: Partial<PageRow> = {}): PageRow => ({
  id,
  workspaceKey: "w1",
  url: "https://x.test/",
  title: "",
  userOpened: false,
  controller: "agent",
  state: "active",
  epoch: 0,
  createdAt: at,
  lastUsedAt: at,
  ...over,
});

test("插入与读取：用户页、操作权、状态、引用集合都能读回", () => {
  const { store } = setup();
  store.insert(
    row("p1", "2026-01-01T00:00:00.000Z", {
      title: "登录页",
      userOpened: true,
      controller: "user",
      state: "sleeping",
      epoch: 3,
    }),
    ["s2", "s1"],
  );
  const got = store.get("p1");
  expect(got?.row).toEqual({
    id: "p1",
    workspaceKey: "w1",
    url: "https://x.test/",
    title: "登录页",
    userOpened: true,
    controller: "user",
    state: "sleeping",
    epoch: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(got?.usedBy).toEqual(["s1", "s2"]);
  expect(store.get("nope")).toBeUndefined();
});

test("列表按最后使用时间降序，可按工作区过滤", () => {
  const { store } = setup();
  store.insert(row("a", "2026-01-01T00:00:00.000Z"), []);
  store.insert(row("b", "2026-01-03T00:00:00.000Z"), []);
  store.insert(row("c", "2026-01-02T00:00:00.000Z", { workspaceKey: "w2" }), [
    "s9",
  ]);
  expect(store.list().map((p) => p.row.id)).toEqual(["b", "c", "a"]);
  expect(store.list("w1").map((p) => p.row.id)).toEqual(["b", "a"]);
  expect(store.list("w2")).toEqual([
    expect.objectContaining({ usedBy: ["s9"] }),
  ]);
  expect(store.list("w3")).toEqual([]);
});

test("更新只改给出的字段", () => {
  const { store } = setup();
  store.insert(row("p1", "2026-01-01T00:00:00.000Z"), []);
  store.update("p1", { url: "https://y.test/", controller: "user" });
  const got = store.get("p1")?.row;
  expect(got?.url).toBe("https://y.test/");
  expect(got?.controller).toBe("user");
  expect(got?.title).toBe("");
  store.update("p1", { userOpened: true, state: "sleeping", epoch: 1 });
  expect(store.get("p1")?.row).toMatchObject({
    userOpened: true,
    state: "sleeping",
    epoch: 1,
  });
  // 空 patch 不报错
  store.update("p1", {});
  expect(store.get("p1")?.row.userOpened).toBe(true);
});

test("addRef 已存在不报错", () => {
  const { store } = setup();
  store.insert(row("p1", "2026-01-01T00:00:00.000Z"), ["s1"]);
  store.addRef("p1", "s1");
  store.addRef("p1", "s2");
  expect(store.get("p1")?.usedBy).toEqual(["s1", "s2"]);
});

test("removeSessionRefs 返回受影响的页面并在库里删掉引用", () => {
  const { store } = setup();
  store.insert(row("p1", "2026-01-01T00:00:00.000Z"), ["s1", "s2"]);
  store.insert(row("p2", "2026-01-01T00:00:00.000Z"), ["s1"]);
  store.insert(row("p3", "2026-01-01T00:00:00.000Z"), ["s3"]);
  expect(store.removeSessionRefs("s1")).toEqual(["p1", "p2"]);
  expect(store.get("p1")?.usedBy).toEqual(["s2"]);
  expect(store.get("p2")?.usedBy).toEqual([]);
  expect(store.removeSessionRefs("s1")).toEqual([]);
});

test("delete 删记录并级联删引用", () => {
  const { store } = setup();
  store.insert(row("p1", "2026-01-01T00:00:00.000Z"), ["s1", "s2"]);
  store.delete("p1");
  expect(store.get("p1")).toBeUndefined();
  expect(store.removeSessionRefs("s1")).toEqual([]);
});

test("deleteWorkspace 删该键的页面并级联删引用，别的键不受影响", () => {
  const { store } = setup();
  store.insert(row("p1", "2026-01-01T00:00:00.000Z"), ["s1"]);
  store.insert(row("p2", "2026-01-01T00:00:00.000Z"), ["s1"]);
  store.insert(row("p3", "2026-01-01T00:00:00.000Z", { workspaceKey: "w2" }), [
    "s1",
  ]);
  expect(store.deleteWorkspace("w1").sort()).toEqual(["p1", "p2"]);
  expect(store.list("w1")).toEqual([]);
  expect(store.get("p3")?.usedBy).toEqual(["s1"]);
});

test("外键：不能给不存在的页面加引用", () => {
  const { store } = setup();
  expect(() => store.addRef("nope", "s1")).toThrow(/FOREIGN KEY/i);
});
