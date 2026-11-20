import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// 结构守卫：扫源码，守住后端已经做到的分层规矩。违规时列出文件，别靠自觉。

const SRC = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(path.join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [path.join(dir, e.name)]
        : [],
  );
}

const all = walk(SRC).map((file) => ({
  rel: path.relative(SRC, file),
  text: readFileSync(file, "utf8"),
}));
const code = all.filter((f) => !f.rel.endsWith(".test.ts"));

const offenders = (files: typeof all, re: RegExp) =>
  files.filter((f) => re.test(f.text)).map((f) => f.rel);

describe("后端结构守卫", () => {
  test("api 层没有 SQL，也不碰数据库驱动", () => {
    const api = code.filter((f) => f.rel.startsWith("api/"));
    expect(offenders(api, /\.prepare\(\s*[`"']/)).toEqual([]);
    expect(
      offenders(api, /from\s+["'][^"']*(store\/db\.js|better-sqlite3)["']/),
    ).toEqual([]);
  });

  test("store 层不向上依赖 api 与 server", () => {
    const store = code.filter((f) => f.rel.startsWith("store/"));
    expect(offenders(store, /from\s+["']\.\.\/(api\/|server\.js)/)).toEqual([]);
  });

  test("isObject 只在 lib/validate.ts 定义一份", () => {
    const dup = code.filter(
      (f) =>
        f.rel !== "lib/validate.ts" &&
        /(const|function)\s+isObject\b/.test(f.text),
    );
    expect(dup.map((f) => f.rel)).toEqual([]);
  });

  test("SessionPool / EnvHub / McpRuntime 只在 server.ts 里构造", () => {
    const others = code.filter((f) => f.rel !== "server.ts");
    expect(
      offenders(others, /new\s+(SessionPool|EnvHub|McpRuntime)\s*\(/),
    ).toEqual([]);
  });

  test("没有 export default", () => {
    expect(offenders(all, /^export\s+default\b/m)).toEqual([]);
  });
});
