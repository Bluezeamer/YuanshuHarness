import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { isSensitive, isSensitiveSelector, resolveTarget } from "./paths.js";

const root = mkdtempSync(path.join(tmpdir(), "yuanshu-paths-"));
const cwd = path.join(root, "proj");
const outside = path.join(root, "outside");
mkdirSync(cwd);
mkdirSync(outside);
symlinkSync(path.join(outside, "new.txt"), path.join(cwd, "dangling")); // 悬空
symlinkSync(path.join(cwd, "loop2"), path.join(cwd, "loop1"));
symlinkSync(path.join(cwd, "loop1"), path.join(cwd, "loop2")); // 循环
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveTarget：无法可靠解析一律返回 null（不放行）", () => {
  test.each([
    ["悬空链接本身", "dangling"],
    ["悬空链接下的子路径", "dangling/sub/x.txt"],
    ["循环链接", "loop1"],
    ["循环链接下的子路径", "loop1/x.txt"],
  ])("%s", (_n, p) => {
    expect(resolveTarget(p, cwd)).toBeNull();
  });

  test("尚不存在的路径照常解析", () => {
    expect(resolveTarget("x/y/z.txt", cwd)).toBe(
      path.join(realpathSync(cwd), "x/y/z.txt"),
    );
  });
});

describe("评审 R2：花括号展开限额", () => {
  const many = (last: string) =>
    `{${Array.from({ length: 64 }, (_, i) => `a${i}`).join(",")},${last}}`;

  test("敏感名放在第 65 个分支也不能漏", () => {
    expect(isSensitive(many(".env"))).toBe(true);
    expect(isSensitiveSelector(many(".env"))).toBe(true);
  });

  test("超限一律按敏感处理，即使分支都无害", () => {
    expect(isSensitive(many("zz"))).toBe(true);
  });

  test("64 个以内照常展开", () => {
    expect(isSensitive("{a,b,c}/x")).toBe(false);
    expect(isSensitive("{a,.env}")).toBe(true);
  });

  test("指数级嵌套毫秒级完成", () => {
    const evil = `${"{a,b}".repeat(40)}/x`;
    const t = Date.now();
    expect(isSensitive(evil)).toBe(true);
    expect(isSensitiveSelector(evil)).toBe(true);
    expect(Date.now() - t).toBeLessThan(200);
  });

  test("超长词直接按敏感处理", () => {
    expect(isSensitive("{a,b}".concat("x".repeat(5000)))).toBe(true);
  });
});

describe("评审 R2：敏感名大小写折叠", () => {
  test.each([
    ".ENV",
    ".Env.local",
    ".SSH/config",
    "a/ID_RSA",
    "ID_ED25519.pub",
    "x.PEM",
    "k.Key",
    ".NpmRc",
    ".AWS/credentials",
    "ID_R*",
    ".EN*",
  ])("%s 敏感", (p) => {
    expect(isSensitive(p)).toBe(true);
  });
});
