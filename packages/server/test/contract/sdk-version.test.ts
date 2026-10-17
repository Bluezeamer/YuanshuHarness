import "./isolate.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SDK = "@earendil-works/pi-coding-agent";
const here = dirname(fileURLToPath(import.meta.url));
const serverPkg = JSON.parse(
  readFileSync(join(here, "../../package.json"), "utf8"),
);
const lock = readFileSync(join(here, "../../../../pnpm-lock.yaml"), "utf8");

const isExact = (spec: string) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec);

describe("R1 SDK 精确锁定", () => {
  test("判定函数能识别范围符（已知坏输入）", () => {
    for (const bad of ["^1.3.0", "~1.3.0", ">=1.3.0", "1.x", "latest", "*"])
      expect(isExact(bad)).toBe(false);
    expect(isExact("1.3.0")).toBe(true);
  });

  test("server 的依赖是精确版本", () => {
    expect(isExact(serverPkg.dependencies[SDK])).toBe(true);
  });

  test("锁文件与 package.json 一致，且实际安装的就是该版本", () => {
    const want = serverPkg.dependencies[SDK];
    expect(lock).toContain(
      `'${SDK}':\n        specifier: ${want}\n        version: ${want}`,
    );
    const installed = JSON.parse(
      readFileSync(
        join(here, "../../node_modules", SDK, "package.json"),
        "utf8",
      ),
    ).version;
    expect(installed).toBe(want);
  });
});
