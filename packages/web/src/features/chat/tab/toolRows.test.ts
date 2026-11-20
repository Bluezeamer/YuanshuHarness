import { expect, test } from "vitest";
import { viewOf } from "./toolRows";

test("文件类工具的摘要把 host 与路径合起来读，没写 host 只显示路径", () => {
  expect(viewOf("read", { path: "src/a.ts" }).primary).toBe("src/a.ts");
  expect(viewOf("read", { host: "dev1", path: "/data/x.log" }).primary).toBe(
    "dev1 · /data/x.log",
  );
  expect(
    viewOf("write", { host: "dev1:train", path: "out/a.txt", content: "x" })
      .primary,
  ).toBe("dev1:train · out/a.txt");
  expect(
    viewOf("edit", { host: "local:proj", path: "a.ts", edits: [] }).primary,
  ).toBe("local:proj · a.ts");
});

test("grep / find 是「检索词 in 位置」，ls 只给位置；只写 host 不写 path 时只显示 host", () => {
  expect(viewOf("grep", { host: "dev1:train", pattern: "loss" }).primary).toBe(
    "loss in dev1:train",
  );
  expect(
    viewOf("find", { host: "dev1", path: "/var/log", pattern: "*.log" })
      .primary,
  ).toBe("*.log in dev1 · /var/log");
  expect(viewOf("ls", { host: "dev1:train" }).primary).toBe("dev1:train");
});

test("transfer_files 两端各带各的 host", () => {
  expect(
    viewOf("transfer_files", {
      from_host: "dev1",
      from: "/data/ckpt.pt",
      to: "models/ckpt.pt",
    }).primary,
  ).toBe("dev1 · /data/ckpt.pt → models/ckpt.pt");
});

test("bash 指定了运行目录时，摘要先写 host 再写命令", () => {
  expect(viewOf("bash", { command: "ls" }).primary).toBe("ls");
  expect(
    viewOf("bash", { host: "dev1:train", command: "pytest -x\nmore" }).primary,
  ).toBe("dev1:train · pytest -x");
});
