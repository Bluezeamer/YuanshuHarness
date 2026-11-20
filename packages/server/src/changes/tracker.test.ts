// 轮次改动追踪：git 双轨与非 git 的文件捕获都要算得准。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import { ChangeTracker, lineStat, relOf, unified } from "./tracker.js";

let root: string;
let dir: string;
const tracker = () => new ChangeTracker({ dir, git: "git", timeoutMs: 20_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" });

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "yuanshu-chg-"));
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-chg-store-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("非 git 目录：写类工具改过的文件才有改动条目，未变的记不进去", async () => {
  writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
  writeFileSync(path.join(root, "keep.txt"), "same\n");
  const env = new LocalEnv();
  const t = tracker();
  const key = "s:1";

  await t.begin(key, env, root);
  await t.noteWrite(key, env, root, path.join(root, "a.txt"));
  await t.noteWrite(key, env, root, path.join(root, "keep.txt"));
  await t.noteWrite(key, env, root, path.join(root, "new.txt"));
  writeFileSync(path.join(root, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(path.join(root, "new.txt"), "hello\n");

  const set = await t.finish(key, env);
  expect(set.mode).toBe("files");
  expect(set.files).toEqual([
    { path: "a.txt", status: "modified", added: 2, removed: 1 },
    { path: "new.txt", status: "added", added: 1, removed: 0 },
  ]);
  // diff 能按副本重建
  const d = await t.diff(key, env, "a.txt");
  expect(d).toContain("-two");
  expect(d).toContain("+TWO");
});

test("非 git：文件被删除时记 deleted", async () => {
  writeFileSync(path.join(root, "gone.txt"), "x\ny\n");
  const env = new LocalEnv();
  const t = tracker();
  await t.begin("s:1", env, root);
  await t.noteWrite("s:1", env, root, path.join(root, "gone.txt"));
  rmSync(path.join(root, "gone.txt"));
  const set = await t.finish("s:1", env);
  expect(set.files).toEqual([
    { path: "gone.txt", status: "deleted", added: 0, removed: 2 },
  ]);
  expect(await t.diff("s:1", env, "gone.txt")).toContain("-x");
});

test.skipIf(!hasGit)("git 仓库：连 bash 直接改的文件也能覆盖", async () => {
  git(root, "init");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.txt"), "one\n");
  writeFileSync(path.join(root, "untouched.txt"), "same\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");

  const env = new LocalEnv();
  const t = tracker();
  await t.begin("s:1", env, root);
  // 模拟 bash：不走工具事件，直接改文件 + 新建文件
  writeFileSync(path.join(root, "src", "a.txt"), "one\ntwo\n");
  writeFileSync(path.join(root, "fresh.txt"), "new\n");

  const set = await t.finish("s:1", env);
  expect(set.mode).toBe("git");
  const byPath = Object.fromEntries(set.files.map((f) => [f.path, f]));
  expect(byPath["src/a.txt"]).toMatchObject({ status: "modified", added: 1 });
  expect(byPath["fresh.txt"]).toMatchObject({ status: "added", added: 1 });
  // 没动过的文件不出现
  expect(byPath["untouched.txt"]).toBeUndefined();
  // 用户自己的 index 不能被我们改坏：工作树仍是干净的已提交状态 + 改动
  expect(git(root, "status", "--porcelain").toString()).toContain("src/a.txt");

  const d = await t.diff("s:1", env, "src/a.txt");
  expect(d).toContain("+two");
});

test.skipIf(!hasGit)(
  "git 仓库：中文文件名按原名给出，diff 也取得到",
  async () => {
    git(root, "init");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(path.join(root, "报告 (终稿).md"), "一\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "init");

    const env = new LocalEnv();
    const t = tracker();
    await t.begin("s:1", env, root);
    writeFileSync(path.join(root, "报告 (终稿).md"), "一\n二\n");
    writeFileSync(path.join(root, "新增.md"), "新\n");

    const set = await t.finish("s:1", env);
    expect(set.files.map((f) => f.path).sort()).toEqual([
      "报告 (终稿).md",
      "新增.md",
    ]);
    expect(set.files.find((f) => f.path === "报告 (终稿).md")).toMatchObject({
      status: "modified",
      added: 1,
    });
    const d = await t.diff("s:1", env, "报告 (终稿).md");
    expect(d).toContain("+二");
    expect(d).toContain("报告 (终稿).md");
  },
);

test("工具函数：relOf 只认 root 内路径，lineStat 数增删行", () => {
  expect(relOf("/w", "/w/a/b.txt")).toBe("a/b.txt");
  expect(relOf("/w", "/other/a.txt")).toBeNull();
  expect(relOf("/w/", "/w/a.txt")).toBe("a.txt");
  expect(lineStat("a\nb\n", "a\nc\n")).toEqual({ added: 1, removed: 1 });
  expect(lineStat("", "x\n")).toEqual({ added: 1, removed: 0 });
  expect(unified("f.txt", "a\n", "b\n")).toContain("--- a/f.txt");
});

test("同一个键的写入记录并发调用不会互相覆盖；forget 清掉全部记录", async () => {
  const env = new LocalEnv();
  const t = tracker();
  const key = "s:concurrent";
  await t.begin(key, env, root);
  const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
  await Promise.all(
    names.map((n) => t.noteWrite(key, env, root, path.join(root, n))),
  );
  for (const n of names) writeFileSync(path.join(root, n), "x\n");
  const set = await t.finish(key, env);
  expect(set.files.map((f) => f.path)).toEqual([...names].sort());

  t.forget(key);
  expect((await t.finish(key, env)).files).toEqual([]);
});
