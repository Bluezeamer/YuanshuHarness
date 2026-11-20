// 交付到目录：取名与清洗、重名换名、不覆盖、失败不留半截、始终落在目录根下。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { LocalEnv } from "../../env/local.js";
import type { Directory } from "../../store/directories.js";
import { putIntoDirectory } from "./deliver.js";

const env = new LocalEnv();

function setup() {
  const root = makeTmpDir("yuanshu-browser-deliver-");
  const staged = path.join(root, "stage");
  const target = path.join(root, "dir");
  const dir: Directory = {
    id: "d1",
    name: "项目",
    path: target,
    environmentId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const prepare = async (name: string, bytes = Buffer.from([0, 255, 10])) => {
    await mkdir(staged, { recursive: true });
    await mkdir(target, { recursive: true });
    const file = path.join(
      staged,
      `${Math.random().toString(36).slice(2)}.bin`,
    );
    await writeFile(file, bytes);
    return { staged: { filename: name, path: file }, bytes };
  };
  return {
    root,
    target,
    dir,
    prepare,
    put: (s: { filename: string; path: string }) =>
      putIntoDirectory(env, dir, s),
  };
}

test("正常写入：字节一致，落在目录根下", async () => {
  const s = setup();
  const { staged, bytes } = await s.prepare("报告.zip");
  const placed = await s.put(staged);
  expect(placed).toEqual({
    name: "报告.zip",
    path: path.join(s.target, "报告.zip"),
  });
  expect([...((await readFile(placed.path)) as Buffer)]).toEqual([...bytes]);
});

test("重名加 (1)(2)，扩展名保留在最后", async () => {
  const s = setup();
  const names: string[] = [];
  for (let i = 0; i < 3; i++)
    names.push((await s.put((await s.prepare("a.tar.gz")).staged)).name);
  expect(names).toEqual(["a.tar.gz", "a.tar (1).gz", "a.tar (2).gz"]);
  // 已有的文件内容不动
  expect((await readdir(s.target)).sort()).toEqual([
    "a.tar (1).gz",
    "a.tar (2).gz",
    "a.tar.gz",
  ]);
});

test("无扩展名：序号接在名字后面", async () => {
  const s = setup();
  const first = await s.put((await s.prepare("README")).staged);
  const second = await s.put((await s.prepare("README")).staged);
  expect([first.name, second.name]).toEqual(["README", "README (1)"]);
});

test("中文与空格文件名原样保留", async () => {
  const s = setup();
  const placed = await s.put((await s.prepare("年度 总结 2026.xlsx")).staged);
  expect(placed.name).toBe("年度 总结 2026.xlsx");
  expect(await readdir(s.target)).toEqual(["年度 总结 2026.xlsx"]);
});

test("带路径的文件名只取 basename，不写出目录之外", async () => {
  const s = setup();
  const a = await s.put((await s.prepare("../../x")).staged);
  const b = await s.put((await s.prepare("a/b")).staged);
  expect([a.name, b.name]).toEqual(["x", "b"]);
  expect(path.dirname(a.path)).toBe(s.target);
  expect(path.dirname(b.path)).toBe(s.target);
  // 上级目录里除了 dir 与 stage，没有多出别的东西
  expect((await readdir(s.root)).sort()).toEqual(["dir", "stage"]);
});

test("文件名为空或全是控制字符时用 download", async () => {
  const s = setup();
  const empty = await s.put((await s.prepare("")).staged);
  const ctrl = await s.put((await s.prepare("\u0000\u0001\u001f")).staged);
  expect([empty.name, ctrl.name]).toEqual(["download", "download (1)"]);
});

test("源文件不存在：报错且不留半截文件", async () => {
  const s = setup();
  await mkdir(s.target, { recursive: true });
  const err = await s
    .put({ filename: "ghost.zip", path: path.join(s.root, "missing.bin") })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(await readdir(s.target)).toEqual([]);
});

test("不覆盖已有文件：已存在的保持原内容，新文件换名", async () => {
  const s = setup();
  await mkdir(s.target, { recursive: true });
  await writeFile(path.join(s.target, "a.txt"), "old");
  const placed = await s.put(
    (await s.prepare("a.txt", Buffer.from("new"))).staged,
  );
  expect(placed.name).toBe("a (1).txt");
  expect(await readFile(path.join(s.target, "a.txt"), "utf8")).toBe("old");
  expect(await readFile(placed.path, "utf8")).toBe("new");
});

test("排他创建失败（别人抢先建了）按已存在处理，换下一个名字", async () => {
  const s = setup();
  await mkdir(s.target, { recursive: true });
  // lstat 说没有、writeStream 却失败，再过一次 lstat 就看到了：模拟并发抢占
  const raced = new Set<string>();
  const racing = {
    ...env,
    lstat: async (p: string) =>
      raced.has(p) ? { isDirectory: false, isFile: true, size: 0 } : null,
    writeStream: async (p: string, opts?: { mode?: number }) => {
      if (p.endsWith("race.zip")) {
        raced.add(p);
        throw new Error("EEXIST: file already exists");
      }
      return env.writeStream(p, opts);
    },
  } as unknown as LocalEnv;
  await writeFile(path.join(s.target, "race.zip"), "someone else");
  const { staged } = await s.prepare("race.zip");
  const placed = await putIntoDirectory(racing, s.dir, staged);
  expect(placed.name).toBe("race (1).zip");
  expect(await readFile(path.join(s.target, "race.zip"), "utf8")).toBe(
    "someone else",
  );
});
