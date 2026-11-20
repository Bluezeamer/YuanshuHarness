import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
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
import { SubagentStore } from "../store/subagents.js";
import { CollabArea } from "../subagent/collab.js";

// 新地址规则：绝对路径必须带主机前缀（相对路径仍相对当前目录）。
// 位置模型：host 说在哪台机器，path 只是路径。
const local = (p: string) => ({ host: "local", path: p });

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
  const ws = t.data.directories.getDefault();
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
    CALLS.push({ tool: "write", args: { ...local(f), content: "hi" } });
    x.entry.send("go");
    await answer(x, "allow");
    await waitFor(ended(x.c), "run.ended", 8000);
    const p = prompts(x.c)[0]?.data;
    expect(p).toMatchObject({ source: "approval", input: "text" });
    expect(p?.options.map((o: { id: string }) => o.id)).toEqual([
      "allow",
      "deny",
      "remember",
    ]);
    expect(p?.detail).toEqual({
      tool: "write",
      summary: `local:${f}`,
    });
    expect(readFileSync(f, "utf8")).toBe("hi");
    expect(x.data.rules.list(x.ws.id)).toEqual([]);
  });

  test("deny：不执行，reason 回给 agent", async () => {
    const x = await setup();
    const f = path.join(x.outside, "a.txt");
    CALLS.push({ tool: "write", args: { ...local(f), content: "hi" } });
    x.entry.send("go");
    await answer(x, "deny");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    expect(toolResults()).toContain("用户拒绝");
  });

  test.each([
    ["deny + 文字", { optionId: "deny", text: "别写到外面" }],
    ["只写文字", { text: "别写到外面" }],
  ])("拒绝时把用户写的话带给模型（%s）", async (_label, a) => {
    const x = await setup();
    const f = path.join(x.outside, "n.txt");
    CALLS.push({ tool: "write", args: { ...local(f), content: "hi" } });
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, a);
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    const results = toolResults();
    expect(results).toContain("用户拒绝了该操作");
    expect(results).toContain("用户补充：别写到外面");
  });

  test("remember：写入目录规则，同目录第二次不再弹", async () => {
    const x = await setup();
    CALLS.push(
      {
        tool: "write",
        args: { ...local(path.join(x.outside, "a.txt")), content: "1" },
      },
      {
        tool: "write",
        args: { ...local(path.join(x.outside, "b.txt")), content: "2" },
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
    CALLS.push({ tool: "write", args: { ...local(f), content: "x" } });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    expect(toolResults()).toContain("超时");
  });

  test("stop 撤销：block，文件未写", async () => {
    const x = await setup();
    const f = path.join(x.outside, "s.txt");
    CALLS.push({ tool: "write", args: { ...local(f), content: "x" } });
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
    CALLS.push({ tool: "write", args: { ...local(f), content: "x" } });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    // 归属目录的判定上下文取不到：拒绝，并且只说不可用（不把内部错误原文交给模型）
    expect(toolResults()).toContain("permission context for");
  });

  test("bash 的判定上下文取不到：同样拒绝并只说不可用", async () => {
    const x = await setup();
    x.data.db.exec("DROP TABLE permission_rules");
    CALLS.push({ tool: "bash", args: { command: "mkdir n" } });
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(toolResults()).toContain("permission context for");
  });
});

describe("R9 / R10", () => {
  test("档位改 full 后下一次调用即时放行；改回 rules 又拦", async () => {
    const x = await setup();
    const f = path.join(x.outside, "f.txt");
    CALLS.push(
      { tool: "write", args: { ...local(f), content: "1" } },
      { tool: "write", args: { ...local(f), content: "2" } },
    );
    x.data.defaults.setPermissionTier("full");
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(prompts(x.c)).toHaveLength(0);
    expect(readFileSync(f, "utf8")).toBe("2");
    x.data.defaults.setPermissionTier("rules");
    CALLS.push({ tool: "write", args: { ...local(f), content: "3" } });
    x.entry.send("again");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    await answer(x, "deny");
  });

  test("auto 且无审核方时同 rules", async () => {
    const x = await setup();
    x.data.defaults.setPermissionTier("auto");
    CALLS.push({
      tool: "write",
      args: { ...local(path.join(x.outside, "g.txt")), content: "1" },
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

describe("协作区（虚拟主机 collab）：只放行该放的，其余直接拒绝", () => {
  async function withCollab() {
    const data = testData();
    const base = mkdtempSync(path.join(tmpdir(), "yuanshu-collab-p-"));
    const collab = new CollabArea(path.join(base, "collab"));
    const t = testPool(stubSessionFactory(stub, {}, true), data, {
      collab,
      subagents: new SubagentStore(data.db),
    });
    cleanups.push(
      () => rmSync(base, { recursive: true, force: true }),
      () => data.close(true),
      () => t.pool.dispose(),
    );
    const entry = t.pool.get((await t.pool.create()).id);
    if (!entry) throw new Error("no entry");
    const c = collector();
    entry.subscribe(c);
    return { entry, c, collab, base, data, pool: t.pool };
  }
  type W = Awaited<ReturnType<typeof withCollab>>;
  const asked = (x: W) => prompts(x.c as never).length;
  const run = async (x: W) => {
    x.entry.send("go");
    await waitFor(() => ended(x.c as never)(), "run.ended", 8000);
  };

  test("读自己这棵树里的文件：不弹审批，内容读得到", async () => {
    const x = await withCollab();
    x.collab.writeReport(x.entry.id, "c1", "TREE-SECRET-OK");
    CALLS.push({
      tool: "read",
      args: { host: "collab", path: "/c1/report.md" },
    });
    await run(x);
    expect(asked(x)).toBe(0);
    expect(toolResults()).toContain("TREE-SECRET-OK");
  });

  test("根会话不能写协作区：任何档位都直接拒绝，没有审批出口", async () => {
    for (const tier of ["rules", "full"] as const) {
      const x = await withCollab();
      x.data.defaults.setPermissionTier(tier);
      x.collab.writeReport(x.entry.id, "c1", "seed");
      CALLS.push({
        tool: "write",
        args: { host: "collab", path: "/c1/forged.md", content: "x" },
      });
      await run(x);
      expect(asked(x)).toBe(0);
      expect(toolResults()).toContain(
        "That path in the collab host is not yours to change.",
      );
      expect(
        existsSync(path.join(x.collab.ownDir(x.entry.id, "c1"), "forged.md")),
      ).toBe(false);
    }
  });

  test("树里放一个指向树外的符号链接：按真实位置判，拒绝", async () => {
    const x = await withCollab();
    const secret = path.join(x.base, "outside-secret.txt");
    writeFileSync(secret, "OUT-OF-TREE");
    x.collab.writeReport(x.entry.id, "c1", "seed");
    const link = path.join(x.collab.ownDir(x.entry.id, "c1"), "link.txt");
    symlinkSync(secret, link);
    CALLS.push({
      tool: "read",
      args: { host: "collab", path: "/c1/link.txt" },
    });
    await run(x);
    expect(asked(x)).toBe(0);
    expect(toolResults()).not.toContain("OUT-OF-TREE");
  });

  test("本机绝对路径不再有内置放行：写协作区的真实路径回到普通审批", async () => {
    const x = await withCollab();
    const f = path.join(x.collab.ownDir(x.entry.id, "c1"), "forged.md");
    CALLS.push({ tool: "write", args: { ...local(f), content: "x" } });
    x.entry.send("go");
    await waitFor(() => prompts(x.c as never).length > 0, "prompt.requested");
    expect(asked(x)).toBe(1);
    x.entry.answerPrompt(prompts(x.c as never)[0]?.data.promptId, {
      optionId: "deny",
    });
    await waitFor(ended(x.c as never), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
  });
});
