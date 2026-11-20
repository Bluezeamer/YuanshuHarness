// 两份 AGENTS.md 的读取与全局文件的读写：只看文件系统，不经过会话池。
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import {
  AGENTS_FILE,
  globalAgentsPath,
  NO_AGENTS_FILES,
  readAgentsFiles,
  readGlobalAgentsMd,
  writeGlobalAgentsMd,
} from "./agents-md.js";

let base = "";
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
});

function dir(...parts: string[]): string {
  if (!base) base = mkdtempSync(path.join(tmpdir(), "yuanshu-agents-md-"));
  const p = path.join(base, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

const project = (root: string) => ({ env: new LocalEnv(), root });

test("两份文件都读到：原文去首尾空白", async () => {
  const ysHome = dir("ys");
  const root = dir("proj");
  writeFileSync(path.join(ysHome, AGENTS_FILE), "\n  全局约定  \n");
  writeFileSync(path.join(root, AGENTS_FILE), "\n\n项目约定\n");
  expect(await readAgentsFiles(ysHome, project(root))).toEqual({
    global: "全局约定",
    project: "项目约定",
  });
});

test("没有文件、只有空白都当作没有", async () => {
  const ysHome = dir("ys-empty");
  const root = dir("proj-empty");
  writeFileSync(path.join(ysHome, AGENTS_FILE), "  \n\t\n");
  writeFileSync(path.join(root, AGENTS_FILE), "");
  expect(await readAgentsFiles(ysHome, project(root))).toEqual(NO_AGENTS_FILES);
});

test("只读主目录根这一份：不往上级找，也不认 CLAUDE.md", async () => {
  const ysHome = dir("ys-nested");
  const outer = dir("outer");
  const inner = dir("outer", "inner");
  writeFileSync(path.join(outer, AGENTS_FILE), "上一级的约定");
  writeFileSync(path.join(outer, "CLAUDE.md"), "另一个名字的约定");
  writeFileSync(path.join(inner, "CLAUDE.md"), "另一个名字的约定");
  expect(await readAgentsFiles(ysHome, project(inner))).toEqual(
    NO_AGENTS_FILES,
  );
  // 主目录自己有文件时才读它
  writeFileSync(path.join(inner, AGENTS_FILE), "主目录的约定");
  expect((await readAgentsFiles(ysHome, project(inner))).project).toBe(
    "主目录的约定",
  );
});

test("拿不到主目录环境（null）时项目文件为 null，全局照读", async () => {
  const ysHome = dir("ys-null");
  writeFileSync(path.join(ysHome, AGENTS_FILE), "全局约定");
  expect(await readAgentsFiles(ysHome, null)).toEqual({
    global: "全局约定",
    project: null,
  });
});

test("读全局文件返回原文（不去空白）；不存在返回空串", async () => {
  const ysHome = dir("ys-read");
  expect(await readGlobalAgentsMd(ysHome)).toBe("");
  writeFileSync(path.join(ysHome, AGENTS_FILE), "\n  原文  \n");
  expect(await readGlobalAgentsMd(ysHome)).toBe("\n  原文  \n");
});

test("写全局文件：会建目录，且不留临时文件", async () => {
  const ysHome = path.join(dir("ys-write"), "nested", "deep");
  await writeGlobalAgentsMd(ysHome, "写进去的约定");
  expect(readFileSync(globalAgentsPath(ysHome), "utf8")).toBe("写进去的约定");
  expect(readdirSync(ysHome)).toEqual([AGENTS_FILE]);
  // 再写一次覆盖，仍不留临时文件
  await writeGlobalAgentsMd(ysHome, "第二版");
  expect(await readGlobalAgentsMd(ysHome)).toBe("第二版");
  expect(readdirSync(ysHome).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  expect(existsSync(path.join(ysHome, AGENTS_FILE))).toBe(true);
});

test("写全局文件是替换而不是就地写：符号链接本身被换掉，目标文件不动", async () => {
  const ysHome = dir("ys-atomic");
  const real = path.join(dir("ys-atomic-target"), "real.md");
  writeFileSync(real, "原目标");
  symlinkSync(real, globalAgentsPath(ysHome));
  await writeGlobalAgentsMd(ysHome, "新内容");
  expect(lstatSync(globalAgentsPath(ysHome)).isSymbolicLink()).toBe(false);
  expect(readFileSync(globalAgentsPath(ysHome), "utf8")).toBe("新内容");
  expect(readFileSync(real, "utf8")).toBe("原目标");
});
