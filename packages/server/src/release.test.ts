import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// 发布物的静态断言：读仓库里的配置文件，不启动任何东西。
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(`${repo}${rel}`, "utf8");
interface PackageJson {
  private?: boolean;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}
const json = (rel: string) => JSON.parse(read(rel)) as PackageJson;

const EXACT = /^\d+\.\d+\.\d+$/;
const atLeast = (version: string, min: string) => {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

describe("运行时依赖（R9）", () => {
  const server = json("packages/server/package.json");

  test("fastify 与 @fastify/static 在 dependencies 里，且是精确版本", () => {
    expect(server.dependencies.fastify).toMatch(EXACT);
    expect(server.dependencies["@fastify/static"]).toMatch(EXACT);
  });

  test("fastify 为 5.x 且不低于 5.12.2", () => {
    const v = server.dependencies.fastify ?? "";
    expect(v.startsWith("5.")).toBe(true);
    expect(atLeast(v, "5.12.2")).toBe(true);
  });
});

describe("npm 包结构（R10）", () => {
  const server = json("packages/server/package.json");
  const web = json("packages/web/package.json");

  test("server 与 web 在首次发布前都保持 private", () => {
    expect(server.private).toBe(true);
    expect(web.private).toBe(true);
  });

  test("bin、engines、license", () => {
    expect(server.bin).toEqual({ yuanshu: "dist/bin.js" });
    expect(server.engines).toEqual({ node: ">=22.19.0" });
    expect(server.license).toBe("MIT");
  });

  test("files 白名单只含构建产物与 web 静态目录", () => {
    expect(server.files).toEqual(["dist", "web"]);
  });

  test("入口源文件带 shebang", () => {
    expect(
      read("packages/server/src/bin.ts").startsWith("#!/usr/bin/env node\n"),
    ).toBe(true);
  });

  test("web 占位静态页存在", () => {
    expect(existsSync(`${repo}packages/web/public/index.html`)).toBe(true);
  });

  test("web 的构建不再用 tsc 发射", () => {
    expect(web.scripts.build).not.toContain("tsc");
    expect(existsSync(`${repo}packages/web/tsconfig.build.json`)).toBe(false);
  });
});
