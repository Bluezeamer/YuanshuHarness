import { afterEach, expect, test, vi } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import {
  type StubReply,
  startStub,
  stubSessionFactory,
  type TestData,
  testData,
  testPool,
} from "../../test/support/stub.js";
import type { Goal } from "../store/session-state.js";
import { SessionStateStore } from "../store/session-state.js";
import { AttachmentDirectories } from "./attachments.js";
import type { SessionPool } from "./pool.js";

// 合法的 1x1 PNG：模型要能真的把它序列化成图片输入。
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// 每个用例一个 stub：目标轮会连续发起多次请求，共用一个 stub 时请求记录会互相干扰。
let stub: Awaited<ReturnType<typeof startStub>> | undefined;
let pool: SessionPool | undefined;
let data: TestData | undefined;
async function boot(
  extra: Parameters<typeof testPool>[2] = {},
  existing?: TestData,
  reply: (n: number, body: Record<string, unknown>) => StubReply = (n) =>
    `reply-${n}`,
  wrap: (
    f: ReturnType<typeof stubSessionFactory>,
  ) => ReturnType<typeof stubSessionFactory> = (f) => f,
  modelExtra: Record<string, unknown> = {},
) {
  stub = await startStub(reply);
  const t = testPool(
    wrap(stubSessionFactory(stub, modelExtra)),
    existing,
    extra,
  );
  pool = t.pool;
  data = t.data;
  const info = await pool.create();
  const entry = pool.get(info.id);
  if (!entry) throw new Error("会话不存在");
  return { info, entry, stub, data: t.data };
}
afterEach(async () => {
  pool?.dispose();
  data?.close();
  await stub?.close();
  pool = undefined;
  data = undefined;
  stub = undefined;
});

// 假模型只会回文本：目标轮没有任何工具调用，连续三轮后由 harness 判定受阻。
test("用户设目标后自动续跑：连续三轮没有工具调用即受阻，目标文本只出现在注入消息里", async () => {
  const { entry, stub } = await boot();
  const c = collector();
  entry.subscribe(c);

  entry.goal.create("GOAL-MARK-1");
  await waitFor(
    () => entry.state.goal?.state === "blocked",
    "目标受阻",
    10_000,
  );
  expect(entry.state.goal).toMatchObject({
    state: "blocked",
    rounds: 3,
    reason: { code: "no-tool-calls" },
  });

  // 收尾消息是单独一轮：等它真的发给模型
  await waitFor(
    () =>
      stub.requests.some((r) =>
        JSON.stringify(r.body).includes(
          "The last 3 goal rounds made no tool calls",
        ),
      ),
    "收尾消息",
  );
  // 模型收到的请求：三轮目标消息 + 一条收尾消息
  const bodies = stub.requests.map((r) => r.body);
  // 三轮注入：第 n 轮的请求里，最新一条是 [Goal round n/50]
  const rounds = bodies.flatMap((b) => {
    const msgs = (b.messages ?? []) as { role: string; content: unknown }[];
    const last = msgs.at(-1);
    const m = /\[Goal round (\d+)\/50\]/.exec(JSON.stringify(last ?? ""));
    return m ? [Number(m[1])] : [];
  });
  expect(rounds).toEqual([1, 2, 3]);
  // 收尾消息是最后一条
  expect(JSON.stringify(bodies.at(-1))).toContain(
    "The last 3 goal rounds made no tool calls",
  );
  // 目标文本不进系统提示
  for (const b of bodies) {
    const sys = (
      (b.messages ?? []) as { role: string; content: unknown }[]
    ).find((m) => m.role === "system" || m.role === "developer");
    expect(JSON.stringify(sys?.content)).not.toContain("GOAL-MARK-1");
  }

  // 卡片：set + 3 张 round + 1 张 blocked（收尾消息自己就是卡片，不额外发）
  const cards = c.frames.filter(
    (f) => f.type === "notice" && f.data.kind === "goal",
  );
  expect(cards.map((f) => f.data.goal.event)).toEqual([
    "set",
    "round",
    "round",
    "round",
    "blocked",
  ]);
  expect(cards[1]?.data.goal).toMatchObject({ round: 1, maxRounds: 50 });
  expect(cards.at(-1)?.data.goal).toMatchObject({
    event: "blocked",
    reason: { code: "no-tool-calls" },
  });
}, 20_000);

// 池级的限制：轮数上限取设置里的默认值（每个目标新建时现取）。
test("轮数上限按设置的默认值现取", async () => {
  const { entry } = await boot({ goalMaxRounds: () => 5 });
  entry.goal.create("g");
  // 上限在新建时按默认值现取
  expect(entry.state.goal?.maxRounds).toBe(5);
  await waitFor(() => (entry.state.goal?.rounds ?? 0) >= 1, "第一轮");
  await entry.goal.pause();
  expect(entry.state.goal?.state).toBe("paused");
}, 20_000);

// 不限（null）是有效值：不能被「缺省 50」吞掉
test("设置里的上限是不限（null）时，新目标不限轮数", async () => {
  const { entry } = await boot({ goalMaxRounds: () => null });
  entry.goal.create("g");
  expect(entry.state.goal?.maxRounds).toBeNull();
  await entry.goal.pause();
}, 20_000);

test("状态落库；换池加载时 active 变 paused（server-restart）", async () => {
  // 目标要落库，池得接上 state store。
  const first = testData();
  const states = new SessionStateStore(first.db);
  const { entry, info, stub } = await boot({ states }, first);
  entry.goal.create("持久目标");
  await waitFor(() => (entry.state.goal?.rounds ?? 0) >= 1, "第一轮");
  await waitFor(() => pool?.sessionFile(info.id) != null, "会话文件已落盘");
  // 模拟「重启前停在 active」：停掉第一个池之后把库里的状态改回 active
  const saved = states.get(info.id).goal;
  pool?.dispose();
  await entry.stop().catch(() => {});
  states.save(info.id, {
    ...states.get(info.id),
    goal: { ...(saved as Goal), state: "active" },
  });

  const second = testPool(stubSessionFactory(stub), first, { states });
  pool = second.pool;
  const loaded = await second.pool.acquire(info.id);
  expect(loaded?.state.goal).toMatchObject({
    text: "持久目标",
    state: "paused",
    reason: { code: "server-restart" },
  });
}, 20_000);

// 每轮都有工具调用：不会被判成「连续没有工具调用」。工具计数是 pool 把 onToolStart 转给目标的接线。
test("每轮都调工具的目标不会被判受阻，持续续跑", async () => {
  // 目标消息之后先调一次 get_goal，拿到工具结果后再回文字
  const reply = (_n: number, body: Record<string, unknown>): StubReply => {
    const last = ((body.messages ?? []) as { role: string }[]).at(-1);
    return last?.role === "tool" ? "已读取" : { tool: "get_goal", args: {} };
  };
  const { entry } = await boot({}, undefined, reply);
  entry.goal.create("g");
  await waitFor(
    () => (entry.state.goal?.rounds ?? 0) >= 4,
    "跑到第四轮",
    15_000,
  );
  expect(entry.state.goal?.state).toBe("active");
  await entry.goal.pause();
}, 30_000);

// 重试用尽仍失败：目标暂停等用户，不自动重试（否则每次失败都会再注入一轮）
test("模型请求出错：目标暂停并写明原因，之后不再注入", async () => {
  const { entry, stub } = await boot();
  stub.mode.status = 500;
  entry.goal.create("g");
  await waitFor(() => entry.state.goal?.state === "paused", "目标暂停", 15_000);
  expect(entry.state.goal?.reason?.code).toBe("request-failed");
  const asked = stub.requests.length;
  await new Promise((r) => setTimeout(r, 300));
  expect(stub.requests.length).toBe(asked);
}, 30_000);

// 注入本身失败（没有运行开始，没有 run.ended）：靠 onRunFailed 收尾，否则会一直重新注入
test("目标消息发不出去：目标暂停，只尝试一次", async () => {
  const attempts = vi.fn();
  const wrap = (f: ReturnType<typeof stubSessionFactory>) =>
    (async (o) => {
      const s = await f(o);
      const send = s.sendCustomMessage.bind(s);
      s.sendCustomMessage = (async (m, opts) => {
        if (m.customType !== "yuanshu.goal") return send(m, opts);
        attempts();
        throw new Error("boom");
      }) as typeof s.sendCustomMessage;
      return s;
    }) as typeof f;
  const { entry } = await boot({}, undefined, (n) => `reply-${n}`, wrap);
  entry.goal.create("g");
  await waitFor(() => entry.state.goal?.state === "paused", "目标暂停");
  expect(entry.state.goal?.reason).toMatchObject({
    code: "request-failed",
    detail: "boom",
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(attempts).toHaveBeenCalledTimes(1);
});

test("用户点停止：目标暂停（你停止了运行），之后不会被自动拉起来", async () => {
  const { entry, stub } = await boot();
  stub.mode.delayMs = 400;
  entry.goal.create("g");
  await waitFor(() => stub.requests.length >= 1, "第一轮已发出");
  await entry.stop();
  expect(entry.state.goal).toMatchObject({
    state: "paused",
    reason: { code: "user-stopped" },
  });
  const asked = stub.requests.length;
  await new Promise((r) => setTimeout(r, 500));
  expect(stub.requests.length).toBe(asked);
}, 20_000);

// 还有后台任务或子代理在跑：它们结束的回调会再唤醒会话，这时再注入只会让模型空说「还在等」
test("有在跑的后台任务或子代理时不续跑，结束后才续", async () => {
  const busy = { jobs: true, tree: false };
  const jobs = {
    list: () => (busy.jobs ? [{ state: "running" }] : []),
    notices: () => [],
  };
  const subagents = {
    get: () => undefined,
    hasRunningInTree: () => busy.tree,
  };
  const { entry, stub } = await boot({
    jobs: jobs as never,
    subagents: subagents as never,
  });
  entry.goal.create("g");
  await new Promise((r) => setTimeout(r, 200));
  expect(stub.requests.length).toBe(0);
  busy.jobs = false;
  busy.tree = true;
  entry.goal.settled();
  await new Promise((r) => setTimeout(r, 200));
  expect(stub.requests.length).toBe(0);
  busy.tree = false;
  entry.goal.settled();
  await waitFor(() => stub.requests.length >= 1, "任务与子代理都结束后续跑");
  await entry.goal.pause();
}, 20_000);

// 注入后到 agent_start 之间有一小段窗口：busy 靠 starting 计数在此期间为真，否则重复检查会再注入一条
test("注入后立即反复检查续跑，同一时刻只注入一条", async () => {
  const { entry, stub } = await boot();
  stub.mode.delayMs = 300;
  entry.goal.create("g");
  for (let i = 0; i < 20; i++) {
    entry.goal.settled();
    await new Promise((r) => setImmediate(r));
  }
  expect(entry.state.goal?.rounds).toBe(1);
  await entry.goal.pause();
}, 20_000);

// 带附件的目标：第一轮把图片交给模型，之后只带标记行；换附件后下一轮再带一次图。
test("目标带图片：第一轮请求里有图片，后续轮只有标记行；换附件后下一轮再带一次", async () => {
  const d = testData();
  const attachments = new AttachmentDirectories(
    d.directories,
    d.dir,
    (sessionId) => pool?.workspaceIdOf(sessionId) ?? sessionId,
  );
  const { entry, info, stub } = await boot(
    { attachments },
    d,
    undefined,
    (f) => f,
    {
      input: ["text", "image"],
    },
  );
  // 走真实上传路径落一张图，客户端只给路径引用；解析口径与 WS 命令一致。
  const saved = await attachments.save(info.id, "p.png", PNG);
  const c = await pool?.resolveContent(info.id, "看图", [saved.path]);
  if (!c) throw new Error("池没建好");
  entry.goal.create("看图", { attachments: c.attachments, images: c.images });
  await waitFor(() => stub.requests.length >= 1, "第一轮");
  expect(JSON.stringify(stub.requests[0]?.body)).toContain(
    `data:image/png;base64,${PNG.toString("base64")}`,
  );
  // 第二轮不再带图（历史里第一轮的那条还在，只看最后一条），但标记行仍在
  await waitFor(() => stub.requests.length >= 2, "第二轮");
  const last = (
    (stub.requests[1]?.body.messages ?? []) as {
      role: string;
      content: unknown;
    }[]
  ).at(-1);
  expect(JSON.stringify(last)).not.toContain("data:image/png;base64,");
  expect(JSON.stringify(last)).toContain("[attach_file] attachment:");

  // 换附件：先暂停，免得自动续跑抢在改动前面；改完继续，下一轮再带一次图
  await entry.goal.pause();
  await waitFor(() => !entry.busy, "这一轮跑完");
  entry.goal.edit({
    content: { attachments: c.attachments, images: c.images },
  });
  const before = stub.requests.length;
  entry.goal.resume();
  await waitFor(() => stub.requests.length > before, "换附件后的一轮");
  const injected = (
    (stub.requests.at(-1)?.body.messages ?? []) as {
      role: string;
      content: unknown;
    }[]
  ).at(-1);
  expect(JSON.stringify(injected)).toContain("data:image/png;base64,");
  await entry.goal.pause();
}, 30_000);
