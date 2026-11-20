import "./isolate.js";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { fakeHome } from "./isolate.js";

// R9：契约测试不得碰真实的 ~/.pi。
test("R9 HOME 与 SDK 默认配置目录都被隔离到临时目录", () => {
  expect(homedir()).toBe(fakeHome);
  expect(getAgentDir().startsWith(fakeHome)).toBe(true);
});

test("R9 没有任何契约测试文件硬编码了端点或密钥（只经环境变量）", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = dirname(fileURLToPath(import.meta.url));
  const roots = [dir, join(dir, "../live")];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const f of readdirSync(root).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(root, f), "utf8");
      if (
        /\b(?:10|100|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text) ||
        /sk-[A-Za-z0-9]{16,}/.test(text)
      )
        offenders.push(f);
    }
  }
  expect(offenders).toEqual([]);
});

test("R9 每个契约测试文件的第一条 import 都是隔离模块", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = dirname(fileURLToPath(import.meta.url));
  const bad = readdirSync(dir)
    .filter((n) => n.endsWith(".test.ts"))
    .filter(
      (n) =>
        !/^import "\.\/isolate\.js";/.test(readFileSync(`${dir}/${n}`, "utf8")),
    );
  expect(bad).toEqual([]);
});
