// 第二轮评审加固：直接驱动权限扩展的 tool_call 处理器（假 pi），不起会话。
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { PromptSpec } from "../session/prompts.js";
import { type PermissionDeps, permissionExtension } from "./extension.js";
import { dirAt, locateAt } from "./testkit.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-hard-")));
const cwd = path.join(root, "proj");
const outside = path.join(root, "outside");
mkdirSync(cwd);
mkdirSync(outside);
symlinkSync(outside, path.join(cwd, "link"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Result = { block?: boolean; reason?: string } | undefined;

function harness({
  cwd: dir = cwd,
  ...over
}: Partial<PermissionDeps> & { cwd?: string } = {}) {
  const asked: PromptSpec[] = [];
  let handler: (e: unknown) => Promise<Result> = async () => undefined;
  // 档位跟着 over 走：命令类按目标目录的档判，夹具里的目录上下文也要是同一档。
  const tier = (over.tier ?? (() => "rules"))();
  permissionExtension({
    directoryCtx: dirAt(dir, { tier }),
    tier: () => tier,
    locate: locateAt(dir, { tier }),
    ask: async (spec) => {
      asked.push(spec);
      return { outcome: "answered", optionId: "deny" };
    },
    ...over,
  })({
    on: (_ev: string, h: (e: unknown) => Promise<Result>) => {
      handler = h;
    },
  } as never);
  const call = (toolName: string, input: Record<string, unknown>) =>
    handler({ toolName, input });
  const ids = () => asked.map((a) => a.options?.map((o) => o.id));
  return { call, asked, ids };
}

describe("1. grep/find 的选择器参数也过敏感与 cwd 边界", () => {
  test.each([
    ["grep", { pattern: "T", glob: "id_rsa*" }],
    ["grep", { pattern: "T", glob: ".env*" }],
    ["grep", { pattern: "T", glob: "{a,.env}" }],
    ["grep", { pattern: "T", glob: "*.pem" }],
    ["find", { pattern: "*.key" }],
    ["find", { pattern: "**/.ssh/*" }],
    ["find", { pattern: "id_*" }],
  ])("%s %j：审批且不可记住", async (tool, input) => {
    const h = harness();
    await h.call(tool, { ...input, path: cwd });
    expect(h.ids()).toEqual([["allow", "deny"]]);
  });

  test.each([
    ["grep", { pattern: "id_rsa", glob: "**/*.ts" }], // pattern 是内容正则，不当路径
    ["grep", { pattern: "x", glob: "*.{ts,tsx}" }],
    ["find", { pattern: "**/*.md" }],
    ["find", { pattern: "*" }],
  ])("正常选择器不误拦 %s %j", async (tool, input) => {
    const h = harness();
    expect(await h.call(tool, { ...input, path: cwd })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });

  test.each([
    ["find", { pattern: "../outside/*.txt" }],
    ["find", { pattern: "/etc/*.conf" }],
    ["grep", { pattern: "x", glob: "../**/*.ts" }],
  ])("选择器指向 cwd 外 %s %j：审批、不可记住", async (tool, input) => {
    const h = harness();
    await h.call(tool, { ...input, path: cwd });
    expect(h.ids()).toEqual([["allow", "deny"]]);
  });
});

describe("2. 只读白名单的路径操作数受 cwd 边界约束", () => {
  test.each([
    "cat /etc/hosts",
    "cat ../outside.txt",
    "ls /",
    "ls link", // 符号链接逃出 cwd
    "cat link/x.txt",
    "grep /etc x", // 疑似路径，保守审批
    "head -n 1 ../x",
  ])("%s：不自动放行，转规则外审批（可记住）", async (command) => {
    const h = harness();
    await h.call("bash", { command });
    expect(h.ids()).toEqual([["allow", "deny", "remember"]]);
  });

  test.each([
    "ls",
    "cat a.txt",
    "ls sub/dir && cat sub/a.txt",
    "grep -rn foo .",
    "echo hello",
    "head -n 5 a.txt",
  ])("%s：cwd 内只读照常放行", async (command) => {
    const h = harness();
    expect(await h.call("bash", { command })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });
});

describe("5. 送审内容脱敏", () => {
  const SECRET = "AKIA_TOP_SECRET_VALUE";
  const review = () => {
    const seen: unknown[] = [];
    return {
      seen,
      review: async (c: unknown) => {
        seen.push(c);
        return { decision: "allow" as const };
      },
    };
  };

  test("write.content 不出现在审核输入，保留路径与长度", async () => {
    const r = review();
    const h = harness({ tier: () => "auto", review: r.review });
    const f = path.join(outside, "k.txt");
    await h.call("write", { path: f, content: SECRET });
    expect(r.seen).toHaveLength(1);
    const text = JSON.stringify(r.seen[0]);
    expect(text).not.toContain(SECRET);
    expect(r.seen[0]).toMatchObject({
      tool: "write",
      input: { path: f, contentLength: SECRET.length },
    });
  });

  test("edit 的新旧文本不出现在审核输入", async () => {
    const r = review();
    const h = harness({ tier: () => "auto", review: r.review });
    await h.call("edit", {
      path: path.join(outside, "k.txt"),
      edits: [{ oldText: `old_${SECRET}`, newText: `new_${SECRET}` }],
    });
    expect(JSON.stringify(r.seen[0])).not.toContain(SECRET);
  });
});

describe("7. 不可记住与 sudo 按首词 basename 归一化", () => {
  test.each([
    "/bin/bash script.sh",
    "/usr/bin/env FOO=1 ls",
    "/usr/bin/xargs rm",
    "/usr/bin/nohup sleep 1 && echo hi",
  ])("%s：没有 remember 选项", async (command) => {
    const h = harness();
    await h.call("bash", { command: `mkdir ${outside}/x; ${command}` });
    expect(h.ids()).toEqual([["allow", "deny"]]);
  });

  test("/usr/bin/sudo 不交审核模型", async () => {
    let reviewed = 0;
    const h = harness({
      tier: () => "auto",
      review: async () => {
        reviewed++;
        return { decision: "allow" };
      },
    });
    await h.call("bash", { command: "/usr/bin/sudo rm -rf x" });
    expect(reviewed).toBe(0);
    expect(h.asked).toHaveLength(1);
  });
});

describe("第三轮：无 glob 的 grep/find 与跟随链接的递归选项", () => {
  test("目录树里有 .env 时，不带 glob 的 grep/find 要审批", async () => {
    const dir = path.join(root, "withenv");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "sub", ".env"), "SECRET=1");
    const h = harness({ cwd: dir });
    await h.call("grep", { pattern: "SECRET", path: dir });
    await h.call("find", { path: dir });
    expect(h.ids()).toEqual([
      ["allow", "deny"],
      ["allow", "deny"],
    ]);
  });

  test("没有敏感文件时不误拦", async () => {
    const h = harness();
    expect(await h.call("grep", { pattern: "x", path: cwd })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });

  test.each([
    "grep -R x .",
    "grep -rR x .",
    "grep --dereference-recursive x .",
    "find . -L -name x",
  ])("%s：不自动放行", async (command) => {
    const h = harness();
    await h.call("bash", { command });
    expect(h.asked).toHaveLength(1);
  });
});

// 评审 M1#1：原词无害、真实路径敏感（cwd 里的链接指向 .env）
describe("M1#1：符号链接指向敏感文件", () => {
  const dir = path.join(root, "linkenv");
  mkdirSync(dir);
  writeFileSync(path.join(dir, ".env"), "SECRET=1");
  writeFileSync(path.join(dir, "plain.txt"), "hi");
  symlinkSync(path.join(dir, ".env"), path.join(dir, "public"));
  symlinkSync(path.join(dir, "plain.txt"), path.join(dir, "pub2"));

  test.each([
    "cat public",
    "head -n 1 public",
    "grep -f public x",
    "grep -fpublic x",
    "grep --file=public x",
    "dd if=public",
  ])("%s：只读白名单也要人工审批，且不可记住", async (command) => {
    const h = harness({ cwd: dir });
    await h.call("bash", { command });
    expect(h.ids()).toEqual([["allow", "deny"]]);
  });

  test("链接指向普通文件的同类命令照常放行", async () => {
    const h = harness({ cwd: dir });
    expect(await h.call("bash", { command: "cat pub2" })).toBeUndefined();
    expect(h.asked).toHaveLength(0);
  });

  test("已记住的命令在链接改指敏感文件后不再放行", async () => {
    const h = harness({
      cwd: dir,
      directoryCtx: dirAt(dir, {
        rules: { path: [], command: ["rm pub2"] },
      }),
    });
    expect(await h.call("bash", { command: "rm pub2" })).toBeUndefined();
    rmSync(path.join(dir, "pub2"));
    symlinkSync(path.join(dir, ".env"), path.join(dir, "pub2"));
    await h.call("bash", { command: "rm pub2" });
    expect(h.ids()).toEqual([["allow", "deny"]]);
  });
});

describe("M4 评审 #5：审批弹窗完整展示命令", () => {
  const cmd = (n: number) => `mkdir ${outside}/m4 && echo ${"a".repeat(n)}`;

  test("超过旧上限的长命令：弹窗 detail 与正文带完整命令", async () => {
    const h = harness();
    const command = cmd(3000);
    await h.call("bash", { command });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.detail?.summary).toBe(command);
  });

  test("长到弹窗装不下：不弹窗，直接拒绝并说明", async () => {
    const h = harness();
    const r = await h.call("bash", { command: cmd(9000) });
    expect(h.asked).toHaveLength(0);
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("无法完整展示");
  });

  test("auto 档下命令长到审核方看不全：不送审，降级给用户", async () => {
    let reviewed = 0;
    const h = harness({
      tier: () => "auto",
      review: async () => {
        reviewed++;
        return { decision: "allow" as const };
      },
    });
    await h.call("bash", { command: cmd(2500) });
    expect(reviewed).toBe(0);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.body).toContain("自动审核看不全");
  });
});
