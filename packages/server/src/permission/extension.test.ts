import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";

// 按已有工具结果条数依次发起 CALLS 里的调用，用完后收尾。
const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [];
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{ role: string }>;
  return CALLS[msgs.filter((m) => m.role === "tool").length] ?? "done";
});
afterAll(() => stub.close());

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  CALLS.length = 0;
  stub.requests.length = 0;
});

async function setup(promptTimeoutMs?: number) {
  const outside = mkdtempSync(path.join(tmpdir(), "yuanshu-out-"));
  const t = testPool(
    stubSessionFactory(stub, {}, true),
    testData(),
    promptTimeoutMs ? { promptTimeoutMs } : {},
  );
  cleanups.push(
    () => rmSync(outside, { recursive: true, force: true }),
    () => t.data.close(true),
    () => t.pool.dispose(),
  );
  const info = await t.pool.create();
  const entry = t.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  const ws = t.data.workspaces.getDefault();
  if (!ws) throw new Error("no ws");
  return { ...t, entry, c, outside, ws };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const prompts = (c: Ctx["c"]) =>
  c.frames.filter((f) => f.type === "prompt.requested");
const ended = (c: Ctx["c"]) => () => c.types().includes("run.ended");
const answer = async (x: Ctx, optionId: string, n = 0) => {
  await waitFor(() => prompts(x.c).length > n, "prompt.requested");
  x.entry.answerPrompt(prompts(x.c)[n]?.data.promptId, { optionId });
};
const toolResults = () =>
  JSON.stringify(
    (stub.requests.at(-1)!.body as { messages: unknown[] }).messages,
  );

describe("R6 审批弹窗", () => {
  test("cwd 外写：弹审批（approval/choice，含 remember 与 detail），allow 后执行", async () => {
    const x = await setup();
    const f = path.join(x.outside, "a.txt");
    CALLS.push({ tool: "write", args: { path: f, content: "hi" } });
    x.entry.send("go");
    await answer(x, "allow");
    await waitFor(ended(x.c), "run.ended", 8000);
    const p = prompts(x.c)[0]?.data;
    expect(p).toMatchObject({ source: "approval", kind: "choice" });
    expect(p?.options.map((o: { id: string }) => o.id)).toEqual([
      "allow",
      "deny",
      "remember",
    ]);
    expect(p?.detail).toEqual({ tool: "write", summary: f });
    expect(readFileSync(f, "utf8")).toBe("hi");
    expect(x.data.rules.list(x.ws.id)).toEqual([]);
  });

  test("deny：不执行，reason 回给 agent", async () => {
    const x = await setup();
    const f = path.join(x.outside, "a.txt");
    CALLS.push({ tool: "write", args: { path: f, content: "hi" } });
    x.entry.send("go");
    await answer(x, "deny");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    expect(toolResults()).toContain("用户拒绝");
  });

  test("remember：写入目录规则，同目录第二次不再弹", async () => {
    const x = await setup();
    CALLS.push(
      {
        tool: "write",
        args: { path: path.join(x.outside, "a.txt"), content: "1" },
      },
      {
        tool: "write",
        args: { path: path.join(x.outside, "b.txt"), content: "2" },
      },
    );
    x.entry.send("go");
    await answer(x, "remember");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(1);
    expect(readFileSync(path.join(x.outside, "b.txt"), "utf8")).toBe("2");
    expect(x.data.rules.list(x.ws.id)).toMatchObject([
      { kind: "path", access: "write", value: x.outside },
    ]);
  });

  test("命令 remember：完全相同的命令不再弹，变体仍弹", async () => {
    const x = await setup();
    const m = path.join(x.outside, "m1");
    CALLS.push(
      { tool: "bash", args: { command: `mkdir ${m}` } },
      { tool: "bash", args: { command: `mkdir  ${m}` } },
      { tool: "bash", args: { command: `mkdir ${m} && ls` } },
    );
    x.entry.send("go");
    await answer(x, "remember");
    await answer(x, "deny", 1);
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(2);
    expect(x.data.rules.list(x.ws.id)[0]).toMatchObject({
      kind: "command",
      access: null,
      value: `mkdir ${m}`,
    });
  });

  test("敏感路径 cwd 内也弹，且没有 remember 选项", async () => {
    const x = await setup();
    CALLS.push({ tool: "write", args: { path: ".env", content: "k=v" } });
    x.entry.send("go");
    await answer(x, "deny");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(
      prompts(x.c)[0]?.data.options.map((o: { id: string }) => o.id),
    ).toEqual(["allow", "deny"]);
  });

  test("cwd 内与只读命令不弹", async () => {
    const x = await setup();
    CALLS.push(
      { tool: "write", args: { path: "in.txt", content: "z" } },
      { tool: "bash", args: { command: "ls" } },
    );
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(readFileSync(path.join(x.ws.path, "in.txt"), "utf8")).toBe("z");
  });
});

describe("符号链接无法解析按 cwd 外处理", () => {
  test("cwd 内指向外部不存在文件的悬空链接：写入弹审批，拒绝后外部文件不存在", async () => {
    const x = await setup();
    const target = path.join(x.outside, "new.txt");
    symlinkSync(target, path.join(x.ws.path, "escape"));
    CALLS.push({ tool: "write", args: { path: "escape", content: "x" } });
    x.entry.send("go");
    await answer(x, "deny");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(
      prompts(x.c)[0]?.data.options.map((o: { id: string }) => o.id),
    ).toEqual(["allow", "deny"]);
    expect(existsSync(target)).toBe(false);
  });
});

describe("R8 失败一律拒绝", () => {
  test("超时：block，文件未写", async () => {
    const x = await setup(150);
    const f = path.join(x.outside, "t.txt");
    CALLS.push({ tool: "write", args: { path: f, content: "x" } });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    expect(toolResults()).toContain("超时");
  });

  test("stop 撤销：block，文件未写", async () => {
    const x = await setup();
    const f = path.join(x.outside, "s.txt");
    CALLS.push({ tool: "write", args: { path: f, content: "x" } });
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    await x.entry.stop();
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
  });

  test("规则读取抛错：block 而不是放行", async () => {
    const x = await setup();
    const f = path.join(x.outside, "e.txt");
    x.data.db.exec("DROP TABLE permission_rules");
    CALLS.push({ tool: "write", args: { path: f, content: "x" } });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    expect(toolResults()).toContain("出错");
  });
});

describe("R9 / R10", () => {
  test("档位改 full 后下一次调用即时放行；改回 rules 又拦", async () => {
    const x = await setup();
    const f = path.join(x.outside, "f.txt");
    CALLS.push(
      { tool: "write", args: { path: f, content: "1" } },
      { tool: "write", args: { path: f, content: "2" } },
    );
    x.data.workspaces.update(x.ws.id, { tier: "full" });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(readFileSync(f, "utf8")).toBe("2");
    x.data.workspaces.update(x.ws.id, { tier: "rules" });
    CALLS.push({ tool: "write", args: { path: f, content: "3" } });
    x.entry.send("again");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    await answer(x, "deny");
  });

  test("auto 且无审核方时同 rules", async () => {
    const x = await setup();
    x.data.workspaces.update(x.ws.id, { tier: "auto" });
    CALLS.push({
      tool: "write",
      args: { path: path.join(x.outside, "g.txt"), content: "1" },
    });
    x.entry.send("go");
    await answer(x, "deny");
    await waitFor(ended(x.c), "run.ended", 8000);
  });

  test("ask_user 不触发审批；未知工具视为规则外", async () => {
    const x = await setup();
    CALLS.push({ tool: "ask_user", args: { question: "q?" } });
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    expect(prompts(x.c)[0]?.data.source).toBe("question");
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { text: "ok" });
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(1);
  });
});
