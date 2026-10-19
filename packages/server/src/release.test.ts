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

  test("files 白名单只含构建产物、web 静态目录与 Apache-2.0 署名文件", () => {
    expect(server.files).toEqual(["dist", "web", "NOTICE", "licenses"]);
  });

  test("入口源文件带 shebang", () => {
    expect(
      read("packages/server/src/bin.ts").startsWith("#!/usr/bin/env node\n"),
    ).toBe(true);
  });

  test("web 的入口页存在且有应用根节点", () => {
    expect(read("packages/web/index.html")).toContain('id="root"');
  });

  test("web 的构建不再用 tsc 发射", () => {
    expect(web.scripts.build).not.toContain("tsc");
    expect(existsSync(`${repo}packages/web/tsconfig.build.json`)).toBe(false);
  });
});

describe("Dockerfile（R12）", () => {
  const dockerfile = existsSync(`${repo}Dockerfile`) ? read("Dockerfile") : "";
  const lines = dockerfile.split("\n").map((l) => l.trim());
  const froms = lines.filter(
    (l) => /^FROM\s/i.test(l) && !/^FROM\s+scratch(\s|$)/i.test(l),
  );

  test("存在，且是多阶段", () => {
    expect(froms.length).toBeGreaterThanOrEqual(2);
  });

  test("每个 FROM 都锁定到 node:24.<次>.<补>-<Debian 代号>-slim", () => {
    for (const from of froms) {
      expect(from).toMatch(
        /^FROM\s+node:24\.\d+\.\d+-[a-z]+-slim(\s+AS\s+\w+)?$/i,
      );
    }
  });

  test("以 node 用户运行，入口是 exec 形式的 yuanshu serve", () => {
    expect(lines).toContain("USER node");
    expect(lines).toContain('ENTRYPOINT ["yuanshu", "serve"]');
  });

  test("环境变量、端口、健康检查；不声明 VOLUME", () => {
    expect(lines).toContain("ENV YUANSHU_HOST=0.0.0.0 YUANSHU_DATA_DIR=/data");
    expect(lines).toContain("EXPOSE 7420");
    expect(lines.some((l) => l.startsWith("HEALTHCHECK "))).toBe(true);
    expect(lines.some((l) => /^VOLUME\s/i.test(l))).toBe(false);
  });

  test("健康检查不依赖 curl 或 wget", () => {
    const hc = lines.filter((l) => l.includes("healthz")).join("\n");
    expect(hc).not.toMatch(/curl|wget/);
  });
});

describe(".dockerignore（R14）", () => {
  const entries = existsSync(`${repo}.dockerignore`)
    ? read(".dockerignore")
        .split("\n")
        .map((l) => l.trim())
    : [];

  test.each([
    ".git",
    "node_modules",
    "tmp",
    ".claude",
    ".pi",
    ".worktrees",
    "**/dist",
    "packages/server/web",
  ])("排除 %s", (item) => {
    expect(entries).toContain(item);
  });
});
