import { describe, expect, test } from "vitest";
import {
  detectSource,
  isSafeRef,
  parseInstallSource,
  SKILL_NAME_RE,
  safeSubdir,
  sourceLabel,
} from "./source.js";

const ok = (raw: unknown) => {
  const r = parseInstallSource(raw);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};
const msg = (raw: unknown) => {
  const r = parseInstallSource(raw);
  return r.ok ? null : r.message;
};
const detect = (spec: string) => detectSource(spec);
const detected = (spec: string) => {
  const d = detect(spec);
  if ("error" in d) throw new Error(`${spec} → ${d.error}`);
  return d;
};

// 识别顺序：本地路径 → scp → 网页地址 → host/owner/repo → owner/repo → npm。
describe("detectSource：表驱动", () => {
  const cases: [string, ReturnType<typeof detected>][] = [
    // 1. 本地目录
    ["./skills/pdf", { kind: "dir", spec: "./skills/pdf" }],
    ["../pdf", { kind: "dir", spec: "../pdf" }],
    ["/abs/pdf", { kind: "dir", spec: "/abs/pdf" }],
    ["~/pdf", { kind: "dir", spec: "~/pdf" }],
    // 2. scp 形式，去掉 .git，主机原样保留（取回时一律走 https）
    [
      "git@github.com:cloudflare/security-audit-skill.git",
      { kind: "git", spec: "github.com/cloudflare/security-audit-skill" },
    ],
    [
      "git@git.corp.io:team/repo",
      { kind: "git", spec: "git.corp.io/team/repo" },
    ],
    // 3. 网页地址：github 只取 owner/repo，其余主机取整条路径
    [
      "https://github.com/cloudflare/security-audit-skill",
      { kind: "git", spec: "github.com/cloudflare/security-audit-skill" },
    ],
    [
      "https://github.com/cloudflare/security-audit-skill.git",
      { kind: "git", spec: "github.com/cloudflare/security-audit-skill" },
    ],
    ["http://github.com/o/r/", { kind: "git", spec: "github.com/o/r" }],
    [
      "https://github.com/o/r/issues/12",
      { kind: "git", spec: "github.com/o/r" },
    ],
    [
      "https://github.com/o/r@v1",
      { kind: "git", spec: "github.com/o/r", ref: "v1" },
    ],
    [
      "https://github.com/o/r/tree/main/skills/foo",
      {
        kind: "git",
        spec: "github.com/o/r",
        ref: "main",
        subdir: "skills/foo",
      },
    ],
    [
      "https://github.com/o/r/tree/main",
      { kind: "git", spec: "github.com/o/r", ref: "main" },
    ],
    // tree 优先于末尾 @ref
    [
      "https://github.com/o/r/tree/main/skills/foo@v1",
      {
        kind: "git",
        spec: "github.com/o/r",
        ref: "main",
        subdir: "skills/foo@v1",
      },
    ],
    [
      "https://gitlab.com/group/sub/repo/-/tree/main/skills/foo",
      {
        kind: "git",
        spec: "gitlab.com/group/sub/repo",
        ref: "main",
        subdir: "skills/foo",
      },
    ],
    [
      "https://gitlab.com/group/repo/-/tree/v2",
      { kind: "git", spec: "gitlab.com/group/repo", ref: "v2" },
    ],
    [
      "https://git.corp.io/team/repo",
      { kind: "git", spec: "git.corp.io/team/repo" },
    ],
    // 4. host/owner/repo[@ref]，host 须含点
    [
      "github.com/cloudflare/security-audit-skill",
      { kind: "git", spec: "github.com/cloudflare/security-audit-skill" },
    ],
    [
      "github.com/od/design-skills@v2.3.0",
      { kind: "git", spec: "github.com/od/design-skills", ref: "v2.3.0" },
    ],
    // 5. 恰两段 → 补成 github.com
    [
      "cloudflare/security-audit-skill",
      { kind: "git", spec: "github.com/cloudflare/security-audit-skill" },
    ],
    [
      "owner/repo@v1",
      { kind: "git", spec: "github.com/owner/repo", ref: "v1" },
    ],
    // 6. npm
    ["@acme/pi-skills", { kind: "npm", spec: "@acme/pi-skills" }],
    ["@acme/pi-skills@1.5.0", { kind: "npm", spec: "@acme/pi-skills@1.5.0" }],
    ["code-review", { kind: "npm", spec: "code-review" }],
    [
      "code-review@2.0.0-beta.1",
      { kind: "npm", spec: "code-review@2.0.0-beta.1" },
    ],
  ];
  test.each(cases)("%s", (spec, expected) => {
    expect(detected(spec)).toEqual(expected);
  });

  test("识别不了时列出支持的写法", () => {
    for (const spec of [
      "code-review@latest",
      "..",
      "--upload-pack=sh",
      "x@y@z",
    ]) {
      const d = detect(spec);
      expect(d, spec).toHaveProperty("error");
      if ("error" in d) expect(d.error).toMatch(/支持的写法/);
    }
    // 地址或 tag 形态的问题单独给具体的文案
    expect(detect("https://x.y/z@1")).toHaveProperty("error");
    expect((detect("") as { error: string }).error).toBe("来源不能为空");
  });
});

describe("auto：交给子解析器", () => {
  test("网页地址不带 ref，版本为 null", () => {
    expect(ok({ kind: "auto", spec: "https://github.com/o/r" })).toEqual({
      source: { kind: "git", url: "github.com/o/r" },
      version: null,
      hint: "r",
    });
  });

  test("owner/repo 补主机；带 .git 去掉", () => {
    expect(
      ok({ kind: "auto", spec: "cloudflare/security-audit-skill" }),
    ).toEqual({
      source: {
        kind: "git",
        url: "github.com/cloudflare/security-audit-skill",
      },
      version: null,
      hint: "security-audit-skill",
    });
  });

  test("git@ 地址 → https 形态的 host/owner/repo", () => {
    expect(
      ok({ kind: "auto", spec: "git@git.corp.io:team/repo.git" }).source,
    ).toEqual({ kind: "git", url: "git.corp.io/team/repo" });
  });

  test("tree 给出 ref 与 subdir", () => {
    expect(
      ok({
        kind: "auto",
        spec: "https://github.com/upstash/context7/tree/master/packages/pi",
      }),
    ).toMatchObject({
      source: {
        kind: "git",
        url: "github.com/upstash/context7",
        ref: "master",
        subdir: "packages/pi",
      },
      version: "master",
    });
  });

  test("请求里的 subdir 覆盖来源里的 subdir", () => {
    expect(
      ok({
        kind: "auto",
        spec: "https://github.com/o/r/tree/main/a",
        subdir: "b/c",
      }).source,
    ).toEqual({
      kind: "git",
      url: "github.com/o/r",
      ref: "main",
      subdir: "b/c",
    });
  });

  test("npm 带或不带版本", () => {
    expect(ok({ kind: "auto", spec: "@acme/pi-skills" })).toEqual({
      source: { kind: "npm", pkg: "@acme/pi-skills" },
      version: null,
      hint: "pi-skills",
    });
    expect(ok({ kind: "auto", spec: "code-review@1.0.0" })).toMatchObject({
      source: { kind: "npm", pkg: "code-review" },
      version: "1.0.0",
    });
  });

  test("本地目录", () => {
    const r = ok({ kind: "auto", spec: "./skills/pdf-tools" });
    expect(r.version).toBeNull();
    expect(
      r.source.kind === "dir" && r.source.path.endsWith("/skills/pdf-tools"),
    ).toBe(true);
  });

  test("不合法的 auto 一律 invalid_source，不访问来源", () => {
    for (const spec of [
      "",
      "git@nope",
      "https://github.com/onlyowner",
      "x@y@z",
    ])
      expect(msg({ kind: "auto", spec }), spec).not.toBeNull();
  });
});

describe("npm 来源", () => {
  test("版本可选；作用域包与名称推断", () => {
    expect(ok({ kind: "npm", spec: "@acme/pi-skills@1.5.0" })).toEqual({
      source: { kind: "npm", pkg: "@acme/pi-skills" },
      version: "1.5.0",
      hint: "pi-skills",
    });
    expect(ok({ kind: "npm", spec: "@acme/pi-skills" }).version).toBeNull();
    expect(ok({ kind: "npm", spec: "code-review@2.0.0-beta.1" }).version).toBe(
      "2.0.0-beta.1",
    );
    expect(ok({ kind: "npm", spec: "code-review" }).source).toEqual({
      kind: "npm",
      pkg: "code-review",
    });
  });

  test("版本不是数字开头（tag / 范围）、大写、带协议、裸路径都被拒", () => {
    for (const spec of [
      "code-review@latest",
      "code-review@^1.0.0",
      "Code-Review@1.0.0",
      "npm:code-review@1.0.0",
      "https://x.y/z@1.0.0",
      "@acme",
      "",
    ])
      expect(msg({ kind: "npm", spec }), spec).not.toBeNull();
  });
});

describe("git 来源", () => {
  test("host/org/repo[@ref]，不带协议；ref 可省略", () => {
    expect(
      ok({ kind: "git", spec: "github.com/od/design-skills@v2.3.0" }),
    ).toEqual({
      source: {
        kind: "git",
        url: "github.com/od/design-skills",
        ref: "v2.3.0",
      },
      version: "v2.3.0",
      hint: "design-skills",
    });
    expect(
      ok({ kind: "git", spec: "github.com/od/design-skills" }),
    ).toMatchObject({
      version: null,
      source: { kind: "git", url: "github.com/od/design-skills" },
    });
    expect(
      ok({ kind: "git", spec: "git.corp.io/team/repo@feature/x" }).version,
    ).toBe("feature/x");
    // 带 subdir
    expect(
      ok({ kind: "git", spec: "github.com/o/r", subdir: "packages/pi" }).source,
    ).toEqual({ kind: "git", url: "github.com/o/r", subdir: "packages/pi" });
  });

  test("带协议、缺仓库路径、ref 以 - 开头或含 .. 、坏 subdir 都被拒", () => {
    for (const spec of [
      "https://github.com/od/design-skills@v1",
      "git@github.com:od/design-skills@v1",
      "github.com/od",
      "https://x.y/z",
      "github.com/od/x@--upload-pack=sh",
      "github.com/od/x@a..b",
    ])
      expect(msg({ kind: "git", spec }), spec).not.toBeNull();
    for (const subdir of ["../etc", "/abs", "a/../../b", "a\0b", 1])
      expect(
        msg({ kind: "git", spec: "github.com/o/r", subdir }),
      ).not.toBeNull();
  });

  test("isSafeRef / safeSubdir", () => {
    expect(isSafeRef("v1.2.3")).toBe(true);
    expect(isSafeRef("release/1.x")).toBe(true);
    expect(isSafeRef("-x")).toBe(false);
    expect(isSafeRef("a b")).toBe(false);
    expect(isSafeRef("a..b")).toBe(false);
    expect(safeSubdir("packages/pi/skills/x")).toBe("packages/pi/skills/x");
    expect(safeSubdir("./packages/pi")).toBe("packages/pi");
    expect(safeSubdir("a/./b//c")).toBe("a/b/c");
    expect(safeSubdir("a/../b")).toBeNull();
    expect(safeSubdir("")).toBeNull();
  });

  test("技能名规则与 pi 加载器一致", () => {
    for (const name of ["a", "ab", "1abc", "a-b", "a".repeat(64)])
      expect(SKILL_NAME_RE.test(name), name).toBe(true);
    for (const name of ["", "-a", "a-", "a--b", "A", "a b", "a".repeat(65)])
      expect(SKILL_NAME_RE.test(name), name).toBe(false);
  });
});

describe("本地目录与 observed", () => {
  test("须以 ./ ../ / ~/ 开头，并归一成绝对路径", () => {
    const r = ok({ kind: "dir", spec: "./skills/pdf-tools" });
    expect(
      r.source.kind === "dir" && r.source.path.endsWith("/skills/pdf-tools"),
    ).toBe(true);
    expect(r.version).toBeNull();
    expect(r.hint).toBe("pdf-tools");
    expect(ok({ kind: "dir", spec: "/abs/path/x" }).source).toEqual({
      kind: "dir",
      path: "/abs/path/x",
    });
    expect(msg({ kind: "dir", spec: "skills/x" })).toContain("./");
    expect(msg({ kind: "dir", spec: "C:\\x" })).not.toBeNull();
  });

  test("observed 需要 hostId 与 path", () => {
    expect(
      ok({ kind: "observed", hostId: "local", path: "/a/b" }).source,
    ).toEqual({
      kind: "observed",
      hostId: "local",
      path: "/a/b",
    });
    expect(msg({ kind: "observed", path: "/a" })).not.toBeNull();
    expect(msg({ kind: "observed", hostId: "local" })).not.toBeNull();
  });

  test("未知类型与非对象", () => {
    expect(msg({ kind: "zip", spec: "x" })).not.toBeNull();
    expect(msg("npm:x@1")).not.toBeNull();
    expect(msg(null)).not.toBeNull();
  });

  test("sourceLabel：git 带 subdir 时加 #", () => {
    expect(sourceLabel({ kind: "npm", pkg: "a" })).toBe("npm:a");
    expect(sourceLabel({ kind: "git", url: "github.com/o/r" })).toBe(
      "git:github.com/o/r",
    );
    expect(
      sourceLabel({
        kind: "git",
        url: "github.com/o/r",
        ref: "v1",
        subdir: "packages/pi",
      }),
    ).toBe("git:github.com/o/r#packages/pi");
  });
});
