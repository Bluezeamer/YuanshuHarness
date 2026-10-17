import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareDataDir } from "./data-dir.js";

let base: string;

beforeEach(async () => {
  if (process.getuid?.() === 0) {
    // root 会绕过权限位，权限类断言将毫无意义；明确失败而不是悄悄跳过。
    throw new Error("data-dir 的测试不能以 root 运行");
  }
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-datadir-"));
});

afterEach(async () => {
  // 先放开权限，rm 才能清理被测试锁住的目录。
  await chmod(base, 0o755).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe("prepareDataDir（R4）", () => {
  test("不存在时创建，权限为 0700", async () => {
    const dir = path.join(base, "data");
    await prepareDataDir(dir);
    expect(await mode(dir)).toBe(0o700);
  });

  test("缺失的父目录一并创建", async () => {
    const dir = path.join(base, "a", "b", "data");
    await prepareDataDir(dir);
    expect(await mode(dir)).toBe(0o700);
  });

  test("已存在的目录不改权限", async () => {
    const dir = path.join(base, "data");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await prepareDataDir(dir);
    expect(await mode(dir)).toBe(0o755);
  });

  test("成功后目录里不留任何文件", async () => {
    const dir = path.join(base, "data");
    await prepareDataDir(dir);
    expect(await readdir(dir)).toEqual([]);
  });

  test("已有内容原样保留，也不多出文件", async () => {
    const dir = path.join(base, "data");
    await mkdir(dir);
    await writeFile(path.join(dir, "keep"), "x");
    await prepareDataDir(dir);
    expect(await readdir(dir)).toEqual(["keep"]);
  });

  test("路径是文件时失败，并指出路径", async () => {
    const file = path.join(base, "file");
    await writeFile(file, "x");
    await expect(prepareDataDir(file)).rejects.toThrow(file);
  });

  test("目录不可写（0555）时失败，并指出路径", async () => {
    const dir = path.join(base, "ro");
    await mkdir(dir);
    await chmod(dir, 0o555);
    await expect(prepareDataDir(dir)).rejects.toThrow(dir);
  });

  test("父目录不可写、无法创建时失败，并指出路径", async () => {
    await chmod(base, 0o555);
    const dir = path.join(base, "data");
    await expect(prepareDataDir(dir)).rejects.toThrow(dir);
  });
});
