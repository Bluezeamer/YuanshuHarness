import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import type { ReviewerFactory } from "./review.js";

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

const ALLOW = '{"decision":"allow","risk":"low","reason":"ok"}';

// 假审核方：记录每次送审的系统/用户文本，按 reply 回复。
function reviewer(reply: string | (() => Promise<string>)) {
  const seen: Array<{ system: string; user: string }> = [];
  let disposed = 0;
  const factory: ReviewerFactory = async (o) => {
    const messages: unknown[] = [];
    return {
      messages: messages as never,
      async prompt(t: string) {
        seen.push({ system: o.systemPrompt, user: t });
        const r = typeof reply === "string" ? reply : await reply();
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: r }],
        });
      },
      dispose() {
        disposed++;
      },
    };
  };
  return { factory, seen, disposed: () => disposed };
}

async function setup(
  rv: ReturnType<typeof reviewer> | null,
  tier: "rules" | "auto" = "auto",
  extra: { reviewTimeoutMs?: number } = {},
) {
  const outside = mkdtempSync(path.join(tmpdir(), "yuanshu-out-"));
  const t = testPool(stubSessionFactory(stub, {}, true), testData(), {
    ...(rv ? { reviewerFactory: rv.factory } : {}),
    ...extra,
  });
  cleanups.push(
    () => rmSync(outside, { recursive: true, force: true }),
    () => t.data.close(true),
    () => t.pool.dispose(),
  );
  const ws = t.data.workspaces.getDefault();
  if (!ws) throw new Error("no ws");
  t.data.workspaces.update(ws.id, { tier });
  const info = await t.pool.create();
  const entry = t.pool.get(info.id);
  if (!entry) throw new Error("no entry");
  const c = collector();
  entry.subscribe(c);
  return { ...t, entry, c, outside, info };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const prompts = (c: Ctx["c"]) =>
  c.frames.filter((f) => f.type === "prompt.requested");
const ended = (c: Ctx["c"]) => () => c.types().includes("run.ended");
const lastResults = () =>
  JSON.stringify(
    (stub.requests.at(-1)!.body as { messages: unknown[] }).messages,
  );
const outsideWrite = (x: Ctx) => {
  const f = path.join(x.outside, "a.txt");
  CALLS.push({ tool: "write", args: { path: f, content: "hi" } });
  return f;
};

describe("R2 allow / deny", () => {
  test("auto 档规则外动作：审核 allow 则直接执行，不弹窗", async () => {
    const rv = reviewer('{"decision":"allow","risk":"low","reason":"ok"}');
    const x = await setup(rv);
    const f = outsideWrite(x);
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(true);
    expect(prompts(x.c)).toHaveLength(0);
    expect(rv.seen).toHaveLength(1);
    expect(rv.disposed()).toBe(1);
  });

  test("审核 deny：不执行，理由回给 agent，不弹窗", async () => {
    const rv = reviewer(
      '{"decision":"deny","risk":"high","reason":"越界写入"}',
    );
    const x = await setup(rv);
    const f = outsideWrite(x);
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
    expect(prompts(x.c)).toHaveLength(0);
    expect(lastResults()).toContain("越界写入");
  });
});

describe("R3 降级为弹窗", () => {
  test.each([
    ["ask", '{"decision":"ask"}'],
    ["乱码", "不是 JSON"],
    ["非法取值", '{"decision":"yes"}'],
  ])("%s：弹给用户，allow 后才执行", async (_n, reply) => {
    const x = await setup(reviewer(reply));
    const f = outsideWrite(x);
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    expect(existsSync(f)).toBe(false);
    // 降级原因进 body，弹窗据此向用户说明
    expect(prompts(x.c)[0]?.data.body).toContain("审核方拿不准，交由你决定");
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "allow" });
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(true);
  });

  test("审核报错：弹给用户", async () => {
    const x = await setup(
      reviewer(async () => {
        throw new Error("模型挂了");
      }),
    );
    outsideWrite(x);
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "deny" });
    await waitFor(ended(x.c), "run.ended", 8000);
  });

  test("审核超时：弹给用户，迟到的 allow 不放行", async () => {
    const x = await setup(
      reviewer(() => new Promise((r) => setTimeout(() => r(ALLOW), 400))),
      "auto",
      { reviewTimeoutMs: 50 },
    );
    const f = outsideWrite(x);
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    expect(prompts(x.c)[0]?.data.body).toContain("审核超时");
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(f)).toBe(false);
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "deny" });
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(existsSync(f)).toBe(false);
  });
});

describe("工具输出进审核上下文", () => {
  test("真实会话里的工具输出（截断 200 字符）出现在不可信区，不进可信区", async () => {
    const rv = reviewer(ALLOW);
    const x = await setup(rv);
    const long = `MARKER_OUT_${"z".repeat(400)}`;
    // 超长词无法按文件名解析（>255），echo 它会被保守地送审；改为先写文件再 cat
    CALLS.push(
      { tool: "write", args: { path: "long.txt", content: long } },
      { tool: "bash", args: { command: "cat long.txt" } },
    );
    outsideWrite(x); // 第二步：规则外写入触发审核
    x.entry.send("go");
    await waitFor(ended(x.c), "run.ended", 8000);
    const user = rv.seen[0]?.user ?? "";
    const [trusted, untrusted] = user.split("## 不可信上下文");
    expect(untrusted).toContain("工具输出：MARKER_OUT_");
    expect(untrusted).not.toContain("z".repeat(250)); // 截断
    expect(trusted).not.toContain("MARKER_OUT_");
  });
});

describe("R4 硬边界不交审核", () => {
  test("敏感路径与 sudo 不调用审核方，直接弹窗", async () => {
    const rv = reviewer(ALLOW);
    const x = await setup(rv);
    CALLS.push({ tool: "bash", args: { command: "sudo ls" } });
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    expect(rv.seen).toHaveLength(0);
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "deny" });
    await waitFor(ended(x.c), "run.ended", 8000);
  });

  test("敏感路径写入（.env）不调用审核方，直接弹窗", async () => {
    const rv = reviewer(ALLOW);
    const x = await setup(rv);
    CALLS.push({
      tool: "write",
      args: { path: path.join(x.outside, ".env"), content: "K=1" },
    });
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    expect(rv.seen).toHaveLength(0);
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "deny" });
    await waitFor(ended(x.c), "run.ended", 8000);
  });
});

describe("R7 档位与未注入", () => {
  test("rules 档不调用审核方", async () => {
    const rv = reviewer(ALLOW);
    const x = await setup(rv, "rules");
    outsideWrite(x);
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    expect(rv.seen).toHaveLength(0);
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "deny" });
    await waitFor(ended(x.c), "run.ended", 8000);
  });

  test("auto 档未注入审核方：退化为弹窗", async () => {
    const x = await setup(null);
    outsideWrite(x);
    x.entry.send("go");
    await waitFor(() => prompts(x.c).length > 0, "prompt.requested");
    x.entry.answerPrompt(prompts(x.c)[0]?.data.promptId, { optionId: "deny" });
    await waitFor(ended(x.c), "run.ended", 8000);
  });
});

describe("R6 会话级策略与证据", () => {
  test("setReviewPolicy 进入系统提示；证据分段；空串清除；超长拒绝", async () => {
    const rv = reviewer(ALLOW);
    const x = await setup(rv);
    const info = await x.pool.setReviewPolicy(x.info.id, "  严禁联网  ");
    expect(info?.reviewPolicy).toBe("严禁联网");
    outsideWrite(x);
    x.entry.send("请写文件");
    await waitFor(ended(x.c), "run.ended", 8000);
    expect(rv.seen[0]?.system).toContain("严禁联网");
    expect(rv.seen[0]?.user).toContain("## 可信证据");
    expect(rv.seen[0]?.user).toContain("用户：请写文件");
    expect(
      (await x.pool.setReviewPolicy(x.info.id, "  "))?.reviewPolicy,
    ).toBeNull();
    await expect(
      x.pool.setReviewPolicy(x.info.id, "x".repeat(4001)),
    ).rejects.toThrow();
    expect(await x.pool.setReviewPolicy("不存在", "x")).toBeNull();
  });
});
