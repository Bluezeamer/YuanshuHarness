import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SKILL_FILE } from "../skills/spec.js";
import { type Db, openDatabase } from "./db.js";
import { SkillStore } from "./skills.js";

const mkSkill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}\n`;

let dir: string;
let db: Db;
let store: SkillStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-skills-"));
  db = openDatabase(dir);
  store = new SkillStore(db, path.join(dir, "skills"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("skill 库基础", () => {
  test("create 与 list 与 get", () => {
    const r = store.create("test-skill", "global", "local", [
      {
        path: SKILL_FILE,
        content: Buffer.from(mkSkill("test-skill", "A test skill")),
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.name).toBe("test-skill");
    expect(r.value.description).toBe("A test skill");
    expect(store.list().map((s) => s.name)).toEqual(["test-skill"]);
    expect(store.get("test-skill")?.description).toBe("A test skill");
  });

  test("name 不符规范拒绝 create", () => {
    expect(
      store.create("bad--name", "global", "local", [
        { path: SKILL_FILE, content: Buffer.from(mkSkill("bad--name", "x")) },
      ]).ok,
    ).toBe(false);
    expect(
      store.create("Bad", "global", "local", [
        { path: SKILL_FILE, content: Buffer.from(mkSkill("Bad", "x")) },
      ]).ok,
    ).toBe(false);
  });

  test("SKILL.md 缺 description 拒绝 create", () => {
    const r = store.create("no-desc", "global", "local", [
      { path: SKILL_FILE, content: Buffer.from("---\nname: no-desc\n---\n") },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("description");
  });

  test("writeFile 更新 SKILL.md，refresh 哈希与描述", () => {
    store.create("refresh-test", "project", "local", [
      { path: SKILL_FILE, content: Buffer.from(mkSkill("refresh-test", "v1")) },
    ]);
    const hash1 = store.get("refresh-test")?.hash;
    store.writeFile(
      "refresh-test",
      SKILL_FILE,
      Buffer.from(mkSkill("refresh-test", "v2")),
    );
    const meta = store.get("refresh-test");
    expect(meta?.description).toBe("v2");
    expect(meta?.hash).not.toBe(hash1);
  });

  test("writeFile 校验 SKILL.md，不合规不落盘", () => {
    store.create("write-check", "global", "local", [
      { path: SKILL_FILE, content: Buffer.from(mkSkill("write-check", "ok")) },
    ]);
    const r = store.writeFile(
      "write-check",
      SKILL_FILE,
      Buffer.from("---\nname: write-check\n---\n"), // 缺 description
    );
    expect(r.ok).toBe(false);
    expect(
      readFileSync(path.join(dir, "skills", "write-check", SKILL_FILE), "utf8"),
    ).toContain("ok");
  });

  test("readFile 与 writeFile 支持子目录", () => {
    store.create("subdir", "global", "local", [
      { path: SKILL_FILE, content: Buffer.from(mkSkill("subdir", "test")) },
    ]);
    store.writeFile(
      "subdir",
      "scripts/run.sh",
      Buffer.from("#!/bin/sh\necho ok\n"),
    );
    expect(
      store.readFile("subdir", "scripts/run.sh")?.toString("utf8"),
    ).toContain("echo ok");
  });

  test("files 跳过点开头的目录项", () => {
    store.create("dotfiles", "global", "local", [
      { path: SKILL_FILE, content: Buffer.from(mkSkill("dotfiles", "test")) },
      { path: ".hidden", content: Buffer.from("secret") },
      { path: ".git/config", content: Buffer.from("repo") },
    ]);
    const names = store.files("dotfiles").map((f) => f.path);
    expect(names).toContain(SKILL_FILE);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain(".git/config");
  });

  test("remove 删除库与文件", () => {
    store.create("remove-me", "global", "local", [
      { path: SKILL_FILE, content: Buffer.from(mkSkill("remove-me", "bye")) },
    ]);
    expect(store.remove("remove-me")).toBe(true);
    expect(store.get("remove-me")).toBeUndefined();
    expect(store.remove("remove-me")).toBe(false);
  });
});

describe("多文件与体量上限", () => {
  test("多文件一起 create，哈希不同于单 SKILL.md", () => {
    const base = [
      { path: SKILL_FILE, content: Buffer.from(mkSkill("multi", "multi")) },
    ];
    store.create("single", "global", "local", base);
    const hash1 = store.get("single")?.hash;
    store.create("multi", "global", "local", [
      ...base,
      { path: "assets/data.json", content: Buffer.from('{"k":"v"}') },
    ]);
    expect(store.get("multi")?.hash).not.toBe(hash1);
  });

  test("文件数或总大小超限拒绝 create", () => {
    const files = [
      { path: SKILL_FILE, content: Buffer.from(mkSkill("big", "big")) },
    ];
    for (let i = 0; i < 210; i++)
      files.push({ path: `f${i}.txt`, content: Buffer.from("x") });
    expect(store.create("big", "global", "local", files).ok).toBe(false);
  });
});
