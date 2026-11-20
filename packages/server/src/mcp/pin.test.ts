import { describe, expect, test } from "vitest";
import type { McpConfig } from "../store/mcp.js";
import {
  classifyFailure,
  compareVersionsDesc,
  parseNpmView,
  parsePypi,
  parseSource,
  ResolveError,
  VERSION_RE,
  withVersion,
} from "./pin.js";

const stdio = (command: string, args: string[]): McpConfig => ({
  transport: "stdio",
  command,
  args,
  env: [],
});

describe("parseSource", () => {
  test("npx：浮动与固定、scope 包、带路径的命令", () => {
    expect(parseSource(stdio("npx", ["-y", "pw-mcp"]))).toEqual({
      runtime: "npm",
      pkg: "pw-mcp",
      version: null,
      argIndex: 1,
    });
    expect(parseSource(stdio("npx", ["-y", "@a/b@1.2.3"]))).toMatchObject({
      pkg: "@a/b",
      version: "1.2.3",
    });
    expect(
      parseSource(stdio("/usr/bin/npx", ["x@2.0.0-beta.1"])),
    ).toMatchObject({ pkg: "x", version: "2.0.0-beta.1" });
    // 标签不是版本：仍是浮动
    expect(parseSource(stdio("npx", ["x@latest"]))).toMatchObject({
      pkg: "x",
      version: null,
    });
  });

  test("uvx：@ 与 == 两种写法", () => {
    expect(parseSource(stdio("uvx", ["srv"]))).toMatchObject({
      runtime: "pypi",
      pkg: "srv",
      version: null,
    });
    expect(parseSource(stdio("uvx", ["srv==0.3.0"]))).toMatchObject({
      version: "0.3.0",
    });
    expect(parseSource(stdio("uvx", ["srv@0.3.0"]))).toMatchObject({
      version: "0.3.0",
    });
  });

  test("认不出的写法与 http 都不可固定", () => {
    expect(parseSource(stdio("node", ["server.js"]))).toBeNull();
    expect(parseSource(stdio("npx", ["-p", "a", "b"]))).toBeNull();
    expect(parseSource(stdio("uvx", ["--from", "a", "b"]))).toBeNull();
    expect(parseSource(stdio("npx", ["-y"]))).toBeNull();
    expect(
      parseSource({ transport: "http", url: "https://a.example", headers: [] }),
    ).toBeNull();
  });
});

describe("withVersion", () => {
  test("只替换包规格这一项，其余参数与环境不动", () => {
    const c = stdio("npx", ["-y", "@a/b", "--flag"]);
    const s = parseSource(c);
    if (!s) throw new Error("no source");
    expect(withVersion(c, s, "1.2.3")).toEqual(
      stdio("npx", ["-y", "@a/b@1.2.3", "--flag"]),
    );
    // 已有版本也能改成旧版
    const pinned = stdio("npx", ["@a/b@2.0.0"]);
    const s2 = parseSource(pinned);
    if (!s2) throw new Error("no source");
    expect(withVersion(pinned, s2, "1.0.0")).toEqual(
      stdio("npx", ["@a/b@1.0.0"]),
    );
  });
});

describe("版本号", () => {
  test("x.y.z 校验", () => {
    for (const v of ["1.2.3", "0.0.83", "2.0.0-beta.1", "1.0.0+build5"])
      expect(VERSION_RE.test(v)).toBe(true);
    for (const v of ["latest", "1.2", "v1.2.3", "^1.2.3", ""])
      expect(VERSION_RE.test(v)).toBe(false);
  });

  test("新的在前，预发布低于同号正式版", () => {
    const sorted = ["1.0.9", "1.10.0", "1.2.0", "1.10.0-rc.1", "0.9.9"].sort(
      compareVersionsDesc,
    );
    expect(sorted).toEqual([
      "1.10.0",
      "1.10.0-rc.1",
      "1.2.0",
      "1.0.9",
      "0.9.9",
    ]);
  });
});

describe("解析结果与失败归类", () => {
  test("npm view 输出", () => {
    const out = JSON.stringify({
      "dist-tags": { latest: "1.2.3", next: "2.0.0-rc.1" },
      versions: ["1.0.0", "1.2.3"],
      description: "  一个 MCP  ",
    });
    expect(parseNpmView(out, "p")).toEqual({
      latest: "1.2.3",
      versions: ["1.0.0", "1.2.3"],
      description: "一个 MCP",
    });
    expect(() => parseNpmView("not json", "p")).toThrow(ResolveError);
  });

  test("PyPI 响应：撤回的版本不进候选", () => {
    expect(
      parsePypi(
        {
          info: { version: "0.3.0", summary: "pg" },
          releases: {
            "0.2.0": [{ yanked: false }],
            "0.2.5": [{ yanked: true }],
            "0.3.0": [{}],
          },
        },
        "p",
      ),
    ).toEqual({
      latest: "0.3.0",
      versions: ["0.2.0", "0.3.0"],
      description: "pg",
    });
  });

  test("无网络、包不存在、其他失败各有明确原因", () => {
    expect(
      classifyFailure("getaddrinfo ENOTFOUND registry.npmjs.org", "p").code,
    ).toBe("network_unavailable");
    expect(classifyFailure("npm error code E404", "p").code).toBe(
      "package_not_found",
    );
    expect(classifyFailure("something odd", "p").code).toBe("resolve_failed");
  });
});
