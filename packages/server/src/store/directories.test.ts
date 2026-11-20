// directories 表的结构约束：同一主机上名字唯一（host:name 是 agent 的标识符），附件区的行例外
// （每个工作区一块、都叫 attachment）。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { type Db, openDatabase } from "./db.js";
import { DirectoryStore } from "./directories.js";
import { ATTACHMENT_ENV_ID, LOCAL_ENV_ID } from "./environments.js";

let dir: string;
let db: Db;
let store: DirectoryStore;
beforeEach(() => {
  dir = makeTmpDir("yuanshu-directories-");
  db = openDatabase(dir);
  store = new DirectoryStore(db);
});

const mk = (name: string) => {
  const p = path.join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
};

test("同一主机上名字唯一：第二次同名被索引拒绝，换一台主机或换名字都可以", () => {
  expect(store.create("app", mk("a"))).not.toBeNull();
  expect(() => store.create("app", mk("b"))).toThrow(/UNIQUE/);
  expect(store.create("app", mk("c"), new Date(), "dev1")).not.toBeNull();
  expect(store.create("app-2", mk("d"))).not.toBeNull();
});

test("附件区的行可以重名（每个工作区一块，都叫 attachment）", () => {
  for (const name of ["w1", "w2", "w3"]) {
    const held = store.create(
      "attachment",
      mk(`att-${name}`),
      new Date(),
      ATTACHMENT_ENV_ID,
    );
    expect(held).not.toBeNull();
  }
  // 附件区的行也不挤占普通目录的名字
  expect(store.create("attachment", mk("real"))).not.toBeNull();
});

test("nameTaken 排除自己（改名时用），也不看别的环境", () => {
  const a = store.create("app", mk("a"));
  store.create("app", mk("b"), new Date(), "dev1");
  expect(store.nameTaken(LOCAL_ENV_ID, "app")).toBe(true);
  expect(store.nameTaken(LOCAL_ENV_ID, "app", a?.id)).toBe(false);
  expect(store.nameTaken("dev1", "app")).toBe(true);
  expect(store.nameTaken("dev2", "app")).toBe(false);
});

test("uniqueName：app、app-2、app-3…，超长基名截断后仍不超过 NAME_MAX", () => {
  expect(store.uniqueName(LOCAL_ENV_ID, "app")).toBe("app");
  store.create("app", mk("a"));
  expect(store.uniqueName(LOCAL_ENV_ID, "app")).toBe("app-2");
  store.create("app-2", mk("b"));
  expect(store.uniqueName(LOCAL_ENV_ID, "app")).toBe("app-3");
  const long = "x".repeat(100);
  store.create(long, mk("c"));
  const next = store.uniqueName(LOCAL_ENV_ID, long);
  expect(next.length).toBeLessThanOrEqual(100);
  expect(next.endsWith("-2")).toBe(true);
});
