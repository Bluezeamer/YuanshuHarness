import { expect, test } from "vitest";
import {
  type DropEntry,
  type DropItem,
  type DropTransfer,
  droppedFiles,
} from "./dropFiles";

const file = (name: string, type = "text/plain") =>
  new File(["x"], name, { type });

const fileEntry = (f: File): DropEntry => ({
  isFile: true,
  isDirectory: false,
  name: f.name,
  file: (ok) => ok(f),
});

// 目录 reader 每次只回一批，再读返回空数组——与浏览器 readEntries 语义一致
const dirEntry = (name: string, children: DropEntry[]): DropEntry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let done = false;
    return {
      readEntries: (ok) => {
        if (done) ok([]);
        else {
          done = true;
          ok(children);
        }
      },
    };
  },
});

const item = (entry: DropEntry | null): DropItem => ({
  kind: "file",
  webkitGetAsEntry: () => entry,
});

const transfer = (over: Partial<DropTransfer>): DropTransfer => ({
  items: [],
  files: [],
  ...over,
});

test("一次拖入多个文件：全部保留（任意类型）", async () => {
  const a = file("a.txt");
  const b = file("b.html", "text/html");
  const files = await droppedFiles(
    transfer({
      items: [item(fileEntry(a)), item(fileEntry(b))],
      files: [a, b],
    }),
  );
  expect(files.map((f) => f.name)).toEqual(["a.txt", "b.html"]);
});

test("目录递归：嵌套目录里的文件全部展开", async () => {
  const a = file("a.txt");
  const b = file("b.md", "text/markdown");
  const folder = dirEntry("docs", [
    fileEntry(a),
    dirEntry("sub", [fileEntry(b), fileEntry(file("c.png", "image/png"))]),
  ]);
  const files = await droppedFiles(transfer({ items: [item(folder)] }));
  expect(files.map((f) => f.name)).toEqual(["a.txt", "b.md", "c.png"]);
});

test("目录分批返回：读到空数组才停", async () => {
  const batches: DropEntry[][] = [
    [fileEntry(file("1.txt"))],
    [fileEntry(file("2.txt")), fileEntry(file("3.txt"))],
    [],
  ];
  let i = 0;
  const folder: DropEntry = {
    isFile: false,
    isDirectory: true,
    name: "big",
    createReader: () => ({
      readEntries: (ok) => ok(batches[i++] ?? []),
    }),
  };
  const files = await droppedFiles(transfer({ items: [item(folder)] }));
  expect(files.map((f) => f.name)).toEqual(["1.txt", "2.txt", "3.txt"]);
});

test("空文件夹：没有文件", async () => {
  expect(
    await droppedFiles(transfer({ items: [item(dirEntry("empty", []))] })),
  ).toEqual([]);
});

test("同一次拖拽里重复的相对路径只算一次", async () => {
  const folder = dirEntry("photos", [fileEntry(file("a.png", "image/png"))]);
  const files = await droppedFiles(
    transfer({ items: [item(folder), item(folder)] }),
  );
  expect(files.map((f) => f.name)).toEqual(["a.png"]);
});

test("items 不可用：回退 files（无 items / 拿不到 entry 两种情况）", async () => {
  const a = file("a.txt");
  const b = file("b.txt");
  expect(
    (await droppedFiles(transfer({ files: [a, b] }))).map((f) => f.name),
  ).toEqual(["a.txt", "b.txt"]);
  expect(
    (
      await droppedFiles(transfer({ items: [{ kind: "file" }], files: [a] }))
    ).map((f) => f.name),
  ).toEqual(["a.txt"]);
});

test("空拖放：什么都不返回", async () => {
  expect(await droppedFiles(transfer({}))).toEqual([]);
  expect(await droppedFiles(null)).toEqual([]);
});
