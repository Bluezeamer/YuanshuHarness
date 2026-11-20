// 服务转发记录的落库：重启后靠它拿回同一个出口端口。
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { type Db, openDatabase } from "./db.js";
import { type ForwardRow, ForwardStore } from "./forwards.js";

const setup = () => {
  const db: Db = openDatabase(makeTmpDir("yuanshu-forwards-"));
  return { db, store: new ForwardStore(db) };
};

const row = (id: string, over: Partial<ForwardRow> = {}): ForwardRow => ({
  id,
  workspaceKey: "w1",
  envId: "local",
  port: 3000,
  localPort: 7500,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

test("插入与读取：按工作区列出、按三元组查找、按 id 取", () => {
  const { store } = setup();
  store.insert(row("f1"));
  store.insert(row("f2", { workspaceKey: "w2", port: 3001, localPort: 7501 }));

  expect(store.get("f1")).toEqual(row("f1"));
  expect(store.get("nope")).toBeNull();
  expect(store.find("w1", "local", 3000)?.id).toBe("f1");
  expect(store.find("w1", "local", 3001)).toBeNull();
  expect(store.find("w2", "local", 3000)).toBeNull();

  expect(store.list("w1").map((r) => r.id)).toEqual(["f1"]);
  expect(store.list("nope")).toEqual([]);
  expect(store.all().map((r) => r.id)).toEqual(["f1", "f2"]);
});

test("删除：返回是否真的删掉了", () => {
  const { store } = setup();
  store.insert(row("f1"));
  expect(store.delete("f1")).toBe(true);
  expect(store.delete("f1")).toBe(false);
  expect(store.get("f1")).toBeNull();
});

test("唯一约束：一个出口端口只能用一次，同工作区同环境同端口也只有一条", () => {
  const { store } = setup();
  store.insert(row("f1"));
  expect(() =>
    store.insert(row("f2", { workspaceKey: "w2", port: 3001 })),
  ).toThrow();
  expect(() => store.insert(row("f3", { localPort: 7501 }))).toThrow();
});
