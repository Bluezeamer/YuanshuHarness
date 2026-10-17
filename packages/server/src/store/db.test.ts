import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DB_FILE, MIGRATIONS, type Migration, openDatabase } from "./db.js";

let dir: string;
const open: Array<{ close(): void }> = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-db-"));
});
afterEach(async () => {
  for (const d of open.splice(0)) {
    try {
      d.close();
    } catch {}
  }
  await rm(dir, { recursive: true, force: true });
});
const track = <T extends { close(): void }>(d: T) => (open.push(d), d);
const baks = () => readdirSync(dir).filter((f) => f.includes(".bak-"));
const version = (d: Database.Database) =>
  d.pragma("user_version", { simple: true });

describe("R1 迁移与备份", () => {
  test("全新数据库：直接建到当前版本，无备份", () => {
    const db = track(openDatabase(dir));
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT count(*) n FROM sessions").get()).toEqual({
      n: 0,
    });
    expect(baks()).toEqual([]);
  });

  test("重新打开已是当前版本：不备份、数据保留", () => {
    const a = openDatabase(dir);
    a.prepare("INSERT INTO sessions VALUES ('x', NULL, 'a', 'b')").run();
    a.close();
    const b = track(openDatabase(dir));
    expect(b.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "x" }]);
    expect(baks()).toEqual([]);
  });

  test("旧版本（v0 但已有表）：迁移前备份，数据保留", () => {
    const legacy = new Database(path.join(dir, DB_FILE));
    legacy.exec(
      "CREATE TABLE legacy_marker (v TEXT); INSERT INTO legacy_marker VALUES ('keep')",
    );
    legacy.close();
    const before = readFileSync(path.join(dir, DB_FILE));
    const db = track(openDatabase(dir));
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT v FROM legacy_marker").get()).toEqual({
      v: "keep",
    });
    expect(baks()).toEqual([`${DB_FILE}.bak-v0`]);
    expect(readFileSync(path.join(dir, `${DB_FILE}.bak-v0`))).toEqual(before);
  });

  test("两步迁移从 v1 升到 v2：只备份 v1，且逐步升版本", () => {
    openDatabase(dir).close();
    const two: Migration[] = [
      ...MIGRATIONS,
      (db) => db.exec("ALTER TABLE sessions ADD COLUMN extra TEXT"),
    ];
    const db = track(openDatabase(dir, two));
    expect(version(db)).toBe(2);
    expect(baks()).toEqual([`${DB_FILE}.bak-v1`]);
  });

  test("迁移中途失败：回滚、启动失败、原库不变", () => {
    openDatabase(dir).close();
    const file = path.join(dir, DB_FILE);
    const snapshot = readFileSync(file);
    const bad: Migration[] = [
      ...MIGRATIONS,
      (db) => {
        db.exec("ALTER TABLE sessions ADD COLUMN half TEXT");
        throw new Error("migration boom");
      },
    ];
    expect(() => openDatabase(dir, bad)).toThrow(/migration boom/);
    expect(readFileSync(file)).toEqual(snapshot);
    const check = track(new Database(file));
    expect(version(check)).toBe(MIGRATIONS.length);
    expect(
      (
        check.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
      ).map((c) => c.name),
    ).not.toContain("half");
  });
});

describe("R2 版本高于代码", () => {
  test("拒绝启动，信息含两个版本号，库文件字节不变", () => {
    const file = path.join(dir, DB_FILE);
    const d = new Database(file);
    d.exec("CREATE TABLE future (x)");
    d.pragma("user_version = 999");
    d.close();
    const before = readFileSync(file);
    expect(() => openDatabase(dir)).toThrow(/999.*高于.*1|999[\s\S]*\b1\b/);
    expect(readFileSync(file)).toEqual(before);
    expect(baks()).toEqual([]);
  });
});

describe("R3 独占锁", () => {
  test("同一数据目录的第二个实例启动失败；第一个关闭后可再打开", () => {
    const first = openDatabase(dir);
    expect(() => openDatabase(dir)).toThrow(/另一个 Server/);
    first.close();
    track(openDatabase(dir));
  });
});
