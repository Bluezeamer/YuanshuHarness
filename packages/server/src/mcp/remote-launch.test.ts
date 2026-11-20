import { describe, expect, test } from "vitest";
import { PGID_MARKER, remoteLaunch } from "./remote-launch.js";

const base = {
  command: "npx",
  args: ["-y", "some-mcp", "--flag"],
  cwd: "/home/me/project",
  vars: { TOKEN: "abc" },
  nonce: "abc123",
};

const lines = (script: string) => script.split("\n");

describe("remoteLaunch", () => {
  test("脚本顺序：自删、PGID、export、cd、exec", () => {
    const r = remoteLaunch(base);
    expect(r.scriptPath).toBe("/tmp/yuanshu-mcp-abc123.sh");
    const l = lines(r.script);
    expect(l[0]).toBe("#!/bin/sh");
    expect(l[1]).toBe('rm -f "$0"');
    expect(l[2]).toBe(`echo "${PGID_MARKER}$$" >&2`);
    expect(l[3]).toBe("export TOKEN='abc'");
    expect(l[4]).toBe("cd '/home/me/project' || exit 1");
    expect(l[5]).toBe("exec 'npx' '-y' 'some-mcp' '--flag'");
  });

  test("特殊字符被单引号包住，原样不被展开", () => {
    const r = remoteLaunch({
      ...base,
      cwd: "/tmp/with space",
      vars: {
        A: "a $HOME `id`",
        B: "!echo hacked",
        C: "it's",
        D: "line1\nline2",
      },
    });
    const l = lines(r.script);
    expect(l).toContain("export A='a $HOME `id`'");
    expect(l).toContain("export B='!echo hacked'");
    expect(l).toContain("export C='it'\\''s'");
    expect(r.script).toContain("export D='line1\nline2'");
    expect(r.script).toContain("cd '/tmp/with space' || exit 1");
  });

  test("shellCommand 经登录 shell 执行脚本", () => {
    expect(remoteLaunch(base).shellCommand).toBe(
      `exec "\${SHELL:-/bin/sh}" -lc 'exec sh '\\''/tmp/yuanshu-mcp-abc123.sh'\\'''`,
    );
  });

  test("非法变量名抛错", () => {
    expect(() => remoteLaunch({ ...base, vars: { "A-B": "x" } })).toThrow(
      "invalid environment variable name: A-B",
    );
    expect(() => remoteLaunch({ ...base, vars: { "1A": "x" } })).toThrow(
      "invalid environment variable name: 1A",
    );
  });

  test("非法 nonce 抛错", () => {
    expect(() => remoteLaunch({ ...base, nonce: "a/b" })).toThrow();
    expect(() => remoteLaunch({ ...base, nonce: "" })).toThrow();
  });
});
