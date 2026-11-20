import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import { CanvasGit, formatSubject, parseSubject, type Source } from "./git.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-canvas-git-"));
  dirs.push(d);
  mkdirSync(path.join(d, ".canvas"));
  return d;
}

const env = () => new LocalEnv();
const git = (p: string) => new CanvasGit(env(), path.join(p, ".canvas"));

const sh = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("提交信息的来源约定", () => {
  test.each<[Source, string]>([
    [{ kind: "agent", session: "s1" }, "agent:s1 create card a.md"],
    [{ kind: "user" }, "user create card a.md"],
    [{ kind: "restore" }, "restore create card a.md"],
    [{ kind: "undo" }, "undo create card a.md"],
  ])("formatSubject / parseSubject 往返：%j", (source, subject) => {
    const summary = "create card a.md";
    expect(formatSubject(source, summary)).toBe(subject);
    expect(parseSubject(subject)).toEqual({ source, summary });
  });

  test("agent 的摘要与 session 能拆开；没有摘要时 summary 为空", () => {
    expect(parseSubject("agent:s1 create card a.md")).toEqual({
      source: { kind: "agent", session: "s1" },
      summary: "create card a.md",
    });
    expect(
      parseSubject(formatSubject({ kind: "agent", session: "s1" }, "")),
    ).toEqual({ source: { kind: "agent", session: "s1" }, summary: "" });
  });

  test("external 不带摘要；认不出的按 external", () => {
    expect(formatSubject({ kind: "external" }, "ignored")).toBe("external");
    expect(parseSubject("external")).toEqual({
      source: { kind: "external" },
      summary: "",
    });
    expect(parseSubject("随手写的提交信息")).toEqual({
      source: { kind: "external" },
      summary: "随手写的提交信息",
    });
  });

  test("带 session id 的摘要里再有空格也不切坏", () => {
    expect(
      parseSubject(formatSubject({ kind: "agent", session: "s 1" }, "a b")),
    ).toEqual({ source: { kind: "agent", session: "s" }, summary: "1 a b" });
  });
});

describe("CanvasGit", () => {
  test("ensure 初始化仓库并把 .canvas/ 写进项目主仓库的 info/exclude，幂等", async () => {
    const p = project();
    sh(p, ["init", "-q"]);
    await git(p).ensure(p);
    expect(() => sh(p, ["rev-parse", "--git-dir"])).not.toThrow();
    const exclude = sh(p, ["rev-parse", "--git-path", "info/exclude"]).trim();
    const file = path.isAbsolute(exclude) ? exclude : path.join(p, exclude);
    const text = readFileSync(file, "utf8");
    expect(
      text.split("\n").filter((l) => l.trim() === ".canvas/"),
    ).toHaveLength(1);
    await git(p).ensure(p);
    expect(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() === ".canvas/"),
    ).toHaveLength(1);
  });

  test("项目本身是仓库时 .canvas/ 仍有自己的仓库：提交落在它里面，项目仓库看不到", async () => {
    const p = project();
    sh(p, ["init", "-q"]);
    await git(p).ensure(p);
    expect(
      sh(path.join(p, ".canvas"), ["rev-parse", "--show-toplevel"]).trim(),
    ).toBe(path.join(realpathSync(p), ".canvas"));
    writeFileSync(path.join(p, ".canvas", "a.md"), "x");
    expect(await git(p).commitAll("user first")).not.toBeNull();
    expect(sh(path.join(p, ".canvas"), ["log", "--format=%s"]).trim()).toBe(
      "user first",
    );
    expect(sh(p, ["status", "--porcelain"]).trim()).toBe("");
  });

  test("项目目录不是仓库时只 init .canvas/，不报错", async () => {
    const p = project();
    await git(p).ensure(p);
    expect(() =>
      sh(p, ["-C", ".canvas", "rev-parse", "--git-dir"]),
    ).not.toThrow();
    expect(() => sh(p, ["rev-parse", "--git-dir"])).toThrow();
  });

  test("commitAll：没有改动返回 null；commit 的身份与路径引号不依赖机器配置", async () => {
    const p = project();
    await git(p).ensure(p);
    const g = git(p);
    expect(await g.commitAll(formatSubject({ kind: "user" }, "first"))).toBe(
      null,
    );
    writeFileSync(path.join(p, ".canvas", "index.md"), "hi");
    expect(await g.dirty()).toBe(true);
    const sha = await g.commitAll(
      formatSubject({ kind: "user" }, "保存 index"),
    );
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(await g.dirty()).toBe(false);
    expect(sh(path.join(p, ".canvas"), ["log", "-1", "--format=%an|%s"])).toBe(
      "Yuanshu Canvas|user 保存 index\n",
    );
    expect(await g.commitAll("nothing")).toBe(null);
  });

  test("log 与 show：按路径过滤、短 sha 与时间、路径不存在返回 null", async () => {
    const p = project();
    await git(p).ensure(p);
    const g = git(p);
    const root = path.join(p, ".canvas");
    mkdirSync(path.join(root, "boards"));
    writeFileSync(
      path.join(root, "boards", "a.canvas"),
      '{"nodes":[],"edges":[]}',
    );
    await g.commitAll(
      formatSubject({ kind: "agent", session: "s1" }, "create a"),
    );
    writeFileSync(path.join(root, "board b.canvas"), "x");
    await g.commitAll(formatSubject({ kind: "external" }, ""));

    const all = await g.log();
    expect(all).toHaveLength(2);
    expect(all[0]?.subject).toBe("external");
    expect(Math.abs((all[0]?.ts ?? 0) - Date.now())).toBeLessThan(60_000);

    const only = await g.log("boards/a.canvas");
    expect(only).toHaveLength(1);
    expect(parseSubject(only[0]?.subject ?? "").source).toEqual({
      kind: "agent",
      session: "s1",
    });
    expect(await g.show(only[0]?.sha ?? "", "boards/a.canvas")).toBe(
      '{"nodes":[],"edges":[]}',
    );
    expect(await g.show(only[0]?.sha ?? "", "boards/none.canvas")).toBe(null);
  });

  test("show 拒绝非法 sha 与逃出 .canvas/ 的路径", async () => {
    const p = project();
    await git(p).ensure(p);
    const g = git(p);
    await expect(g.show("--output=/tmp/x", "a.md")).rejects.toThrow();
    await expect(g.show("HEAD", "a.md")).rejects.toThrow();
    await expect(g.show("abcdef1", "../../etc/passwd")).rejects.toThrow();
    await expect(g.show("abcdef1", "/etc/passwd")).rejects.toThrow();
  });

  test("revert 提交一次带给定信息的新提交；sha 不存在时返回原因", async () => {
    const p = project();
    await git(p).ensure(p);
    const g = git(p);
    const root = path.join(p, ".canvas");
    writeFileSync(path.join(root, "a.md"), "zero\n");
    await g.commitAll(formatSubject({ kind: "user" }, "zero"));
    writeFileSync(path.join(root, "a.md"), "one\n");
    const one = await g.commitAll(
      formatSubject({ kind: "agent", session: "s" }, "one"),
    );
    const back = await g.revert(one ?? "", "undo one");
    expect(back.ok).toBe(true);
    expect(readFileSync(path.join(root, "a.md"), "utf8")).toBe("zero\n");
    expect(sh(root, ["log", "-1", "--format=%s"]).trim()).toBe("undo one");

    const bad = await g.revert("deadbeef", "undo nothing");
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason.length > 0).toBe(true);
  });

  test("rollback 丢掉工作区的改动与未跟踪文件", async () => {
    const p = project();
    await git(p).ensure(p);
    const g = git(p);
    const root = path.join(p, ".canvas");
    writeFileSync(path.join(root, "a.md"), "one\n");
    await g.commitAll("user one");
    writeFileSync(path.join(root, "a.md"), "changed\n");
    writeFileSync(path.join(root, "new.md"), "new\n");
    await g.rollback();
    expect(readFileSync(path.join(root, "a.md"), "utf8")).toBe("one\n");
    expect(await g.dirty()).toBe(false);
  });
});
