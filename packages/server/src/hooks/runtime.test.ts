import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MaskVar } from "../permission/masking.js";
import type { AuditInput } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { DirectoryStore } from "../store/directories.js";
import { LOCAL_ENV_ID } from "../store/environments.js";
import { HookStore } from "../store/hooks.js";
import { type HookCtx, HookRuntime } from "./runtime.js";

let dir: string;
let db: Db;
let store: HookStore;
const vars: MaskVar[] = [{ name: "tok", value: "secret123" }];
const audit: AuditInput[] = [];
let runtime: HookRuntime;

let ctx: HookCtx;
let ws2: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-hook-rt-"));
  db = openDatabase(dir);
  store = new HookStore(db);
  // hooks.directory_id 有外键，作用域用例需要真实的 directory 行。
  const directories = new DirectoryStore(db);
  const w1 = directories.create("一号", dir);
  ws2 = directories.create("二号", path.join(dir, "two"))?.id ?? "";
  ctx = {
    sessionId: "s1",
    directoryId: w1?.id ?? "",
    cwd: dir,
    execCwd: dir,
    environmentId: LOCAL_ENV_ID,
  };
  audit.length = 0;
  runtime = new HookRuntime({
    store,
    variables: () => vars,
    audit: { record: (e: AuditInput) => audit.push(e) } as never,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("命中与执行", () => {
  test("没有 hook 时立即返回空效果", async () => {
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out).toEqual({
      blocked: null,
      context: [],
      feedback: [],
      updatedInput: null,
    });
    expect(audit).toHaveLength(0);
  });

  test("已禁用的 hook 不执行", async () => {
    store.create({
      name: "拒绝",
      point: "PreToolUse",
      matcher: "bash",
      command: "exit 2",
      timeoutSec: 10,
      enabled: false,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toBeNull();
    expect(audit).toHaveLength(0);
  });

  test("matcher 不匹配时不执行", async () => {
    store.create({
      name: "拒绝",
      point: "PreToolUse",
      matcher: "write",
      command: "exit 2",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toBeNull();
  });

  test("directory 作用域 hook 只在该 directory 生效", async () => {
    const h = store.create({
      name: "仅 ws2",
      point: "PreToolUse",
      matcher: "bash",
      command: "exit 2",
      timeoutSec: 10,
      enabled: true,
      directoryId: ws2,
    });
    const out1 = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out1.blocked).toBeNull();

    const out2 = await runtime.fire(
      "PreToolUse",
      { ...ctx, directoryId: ws2 },
      { tool_name: "bash" },
    );
    expect(out2.blocked).toContain(`hook「${h.name}」`);
  });

  test("全局 hook 对所有 directory 生效", async () => {
    const h = store.create({
      name: "全局",
      point: "PreToolUse",
      matcher: "bash",
      command: "exit 2",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toContain(`hook「${h.name}」`);
  });
});

describe("退出码与输出解释", () => {
  test("退出 0 表示放行", async () => {
    store.create({
      name: "ok",
      point: "PreToolUse",
      matcher: "bash",
      command: "echo pass",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toBeNull();
    expect(audit[0]?.detail).toMatchObject({ result: "ok" });
  });

  test("退出 2 表示阻断，stderr 回显给模型", async () => {
    const h = store.create({
      name: "拒绝",
      point: "PreToolUse",
      matcher: "bash",
      command: 'echo "禁止该操作" >&2; exit 2',
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toContain(`hook「${h.name}」`);
    expect(out.blocked).toContain("禁止该操作");
    expect(audit[0]?.detail).toMatchObject({ result: "blocked" });
  });

  test("非 0 非 2 的退出码放行并记 error", async () => {
    store.create({
      name: "崩溃",
      point: "PreToolUse",
      matcher: "bash",
      command: "exit 1",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toBeNull();
    expect(audit[0]?.detail).toMatchObject({ result: "error" });
  });

  test("退出 0 且 stdout 是 JSON decision:block 时阻断", async () => {
    const h = store.create({
      name: "JSON 拒绝",
      point: "PreToolUse",
      matcher: "bash",
      command: 'echo \'{"decision":"block","reason":"不允许"}\'',
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toContain(`hook「${h.name}」`);
    expect(out.blocked).toContain("不允许");
  });

  test("非阻断点位的退出 2 或 JSON block 只产生反馈", async () => {
    store.create({
      name: "反馈",
      point: "PostToolUse",
      matcher: "bash",
      command: 'echo "建议" >&2; exit 2',
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PostToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toBeNull();
    expect(out.feedback[0]).toContain("反馈");
    expect(out.feedback[0]).toContain("建议");
    expect(audit[0]?.detail).toMatchObject({ result: "feedback" });
  });

  test("超时强杀，放行并记 timeout", async () => {
    store.create({
      name: "慢",
      point: "PreToolUse",
      matcher: "bash",
      command: "sleep 10",
      timeoutSec: 1,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    expect(out.blocked).toBeNull();
    const rec = audit[0];
    expect(rec?.detail).toMatchObject({ result: "timeout" });
    expect(rec?.summary).toContain("timeout");
  });
});

describe("隐私遮罩", () => {
  test("载荷里的隐私变量真值送进 hook 前被遮罩", async () => {
    // 让 hook 把收到的 stdin 原样落盘，直接检查 hook 实际拿到了什么。
    const out = path.join(dir, "payload.json");
    store.create({
      name: "log",
      point: "PreToolUse",
      matcher: "bash",
      command: `cat > '${out}'`,
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    await runtime.fire("PreToolUse", ctx, {
      tool_name: "bash",
      tool_input: { command: "echo secret123" },
    });
    const received = readFileSync(out, "utf8");
    expect(received).not.toContain("secret123");
    expect(received).toContain("@tok");
  });

  test("hook 输出里的隐私变量回灌前被遮罩", async () => {
    store.create({
      name: "泄密",
      point: "PostToolUse",
      matcher: "bash",
      command:
        'echo \'{"decision":"allow","additionalContext":"token is secret123"}\'',
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PostToolUse", ctx, { tool_name: "bash" });
    expect(out.context[0]).not.toContain("secret123");
    expect(out.context[0]).toContain("@tok");
  });
});

describe("试跑", () => {
  test("test 接口不看 matcher 与启用状态，用给定载荷执行一次", async () => {
    const h = store.create({
      name: "拒绝",
      point: "PreToolUse",
      matcher: "write",
      command: "exit 2",
      timeoutSec: 10,
      enabled: false,
      directoryId: null,
    });
    // 虽然 matcher 不匹配且已禁用，test 仍跑。
    const run = await runtime.test(h, ctx, {
      tool_name: "bash",
      tool_input: {},
    });
    expect(run.result).toBe("blocked");
    expect(audit[0]?.detail).toMatchObject({ test: true });
  });

  test("未提供 payload 时用点位的样例", async () => {
    const h = store.create({
      name: "log",
      point: "PreToolUse",
      matcher: "",
      command: "cat",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const run = await runtime.test(h, ctx);
    expect(run.result).toBe("ok");
    // stdout 应该是样例 JSON（含 tool_name: bash）。
    expect(run.stdout).toContain("bash");
    expect(run.stdout).toContain("tool_name");
  });
});

describe("updatedInput", () => {
  test("PreToolUse 的 JSON 输出可改写 tool_input", async () => {
    store.create({
      name: "改写",
      point: "PreToolUse",
      matcher: "bash",
      command:
        'echo \'{"decision":"allow","updatedInput":{"command":"echo replaced"}}\'',
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    const out = await runtime.fire("PreToolUse", ctx, {
      tool_name: "bash",
      tool_input: { command: "echo original" },
    });
    expect(out.updatedInput).toEqual({ command: "echo replaced" });
  });

  test("多个 hook 串行时，后面的 hook 看到前面改写后的输入", async () => {
    store.create(
      {
        name: "第一个",
        point: "PreToolUse",
        matcher: "bash",
        command: 'echo \'{"decision":"allow","updatedInput":{"step":1}}\'',
        timeoutSec: 10,
        enabled: true,
        directoryId: null,
      },
      new Date("2026-01-01T00:00:00Z"),
    );
    // 创建时间不同才有确定的执行顺序（同毫秒内 id 的随机位会决定先后）。
    store.create(
      {
        name: "第二个",
        point: "PreToolUse",
        matcher: "bash",
        command:
          'cat | grep -q step && echo \'{"decision":"allow","updatedInput":{"step":2}}\'',
        timeoutSec: 10,
        enabled: true,
        directoryId: null,
      },
      new Date("2026-01-01T00:00:01Z"),
    );
    const out = await runtime.fire("PreToolUse", ctx, {
      tool_name: "bash",
      tool_input: { command: "original" },
    });
    expect(out.updatedInput).toEqual({ step: 2 });
  });
});

describe("审计", () => {
  test("每次 hook 执行写一条审计（点位、id、结果、耗时）", async () => {
    const h = store.create({
      name: "ok",
      point: "PreToolUse",
      matcher: "bash",
      command: "echo ok",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    await runtime.fire("PreToolUse", ctx, { tool_name: "bash" });
    const rec = audit[0];
    expect(rec).toBeDefined();
    expect(rec?.kind).toBe("hook");
    expect(rec?.sessionId).toBe("s1");
    expect(rec?.summary).toContain("PreToolUse");
    expect(rec?.summary).toContain(h.name);
    expect(rec?.summary).toContain("ok");
    expect(rec?.detail).toMatchObject({
      op: "PreToolUse",
      target: h.name,
      result: "ok",
      hookId: h.id,
      point: "PreToolUse",
    });
    expect(rec?.detail).toHaveProperty("durationMs");
  });

  test("试跑的审计带 test 标记", async () => {
    const h = store.create({
      name: "测试",
      point: "PreToolUse",
      matcher: "",
      command: "echo test",
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });
    await runtime.test(h, ctx);
    expect(audit[0]?.detail).toMatchObject({ test: true });
  });
});
