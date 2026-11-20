import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";

// 用户点停止：已排队、还没送达模型的消息必须一并清掉，并通过 queue.updated 同步给所有订阅者。
// 真实服务 + 真实会话（stub 当模型），走 WS 的 send_message / stop。
// 默认每次回 reply-N。派发场景（SPAWN 打开时）：父收到「spawn」就派一个子代理，随后的一步很慢（让父一直在跑），
// 子代理立刻回一句结论。
const BRIEF = "You are a subagent dispatched by another agent session";
type Msg = { role: string; content?: unknown };
const SPAWN = { on: false };
// 工具场景（SLOW 打开时）：收到「slow」就跑一条要几秒的 bash，工具返回后回一句话。
const SLOW = { on: false };
const stub = await startStub((n, body) => {
  if (SLOW.on) {
    const m = (body.messages ?? []) as Msg[];
    const l = m.at(-1);
    if (l?.role === "user" && JSON.stringify(l.content).includes("slow"))
      return { tool: "bash", args: { command: "sleep 4" } };
    return `reply-${n}`;
  }
  if (!SPAWN.on) return `reply-${n}`;
  const msgs = (body.messages ?? []) as Msg[];
  const last = msgs.at(-1);
  const txt = JSON.stringify(last?.content ?? "");
  if (
    msgs.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes(BRIEF),
    )
  ) {
    // 子代理：交付要晚于 job_start 的观察期（0.3 秒），这样交付走回调，而父此时还在跑
    const first = last?.role !== "tool";
    stub.mode.delayMs = first ? 500 : 0;
    return first
      ? { tool: "deliver", args: { summary: "child-result" } }
      : "child-done";
  }
  if (last?.role === "user" && txt.includes("spawn"))
    return {
      tool: "job_start",
      args: { name: "spawn_subagent", arguments: { task: "T" } },
    };
  if (last?.role === "tool") stub.mode.delayMs = 3000;
  return `reply-${n}`;
});
afterAll(() => stub.close());

let base: string;
let server: YuanshuServer | null = null;
const clients: TestClient[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-stopq-"));
  await mkdir(path.join(base, "web"), { recursive: true });
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.stop().catch(() => {});
  server = null;
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
  SPAWN.on = false;
  SLOW.on = false;
  await rm(base, { recursive: true, force: true });
});

async function launch(builtinTools = false) {
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub, {}, builtinTools),
    },
  );
  const addr = await server.start();
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
  };
}

async function open(s: Awaited<ReturnType<typeof launch>>, id?: string) {
  const sid =
    id ??
    (
      (await (
        await fetch(`${s.http}/api/v1/sessions`, { method: "POST" })
      ).json()) as {
        id: string;
      }
    ).id;
  const c = await TestClient.connect(`${s.ws}/api/v1/sessions/${sid}/stream`);
  clients.push(c);
  return { sid, c };
}

type Q = { queue: string[] };
const queues = (c: TestClient) =>
  c.frames
    .filter((f) => f.type === "queue.updated")
    .map((f) => (f.data as Q).queue);
const ends = (c: TestClient) =>
  c.types().filter((t) => t === "run.ended").length;
const requested = () => JSON.stringify(stub.requests.map((r) => r.body));

// 第一条消息正在生成时，再发两条（进队列）
async function runningWithQueue(c: TestClient) {
  stub.mode.delayMs = 600;
  await c.command("send_message", { text: "first" });
  await waitFor(
    () => c.types().filter((t) => t === "message.started").length >= 2,
    "助手消息开始",
  );
  await c.command("send_message", { text: "second-queued" });
  await c.command("send_message", { text: "third-queued" });
  await waitFor(() => queues(c).some((q) => q.length === 2), "队列里有两条");
}

test("停止：待发队列清空，并经 queue.updated 同步给所有订阅者；排队的消息不会送达模型", async () => {
  const s = await launch();
  const { sid, c } = await open(s);
  const { c: other } = await open(s, sid);
  await runningWithQueue(c);

  expect((await c.command("stop")).ok).toBe(true);
  await waitFor(() => ends(c) >= 1, "run.ended");

  // 两个订阅者看到的最后一次队列状态都是空
  for (const x of [c, other]) {
    await waitFor(() => queues(x).at(-1)?.length === 0, "队列同步为空");
  }
  // 停止之后不会再有排队的消息被送去模型
  await new Promise((r) => setTimeout(r, 300));
  expect(requested()).not.toContain("second-queued");
  expect(requested()).not.toContain("third-queued");
  expect(ends(c)).toBe(1);
});

test("停止后再发新消息：新消息正常送达，且不会夹带停止前排队的旧消息", async () => {
  const s = await launch();
  const { c } = await open(s);
  await runningWithQueue(c);
  await c.command("stop");
  await waitFor(() => ends(c) >= 1, "run.ended");

  stub.mode.delayMs = 0;
  stub.requests.length = 0;
  await c.command("send_message", { text: "fresh" });
  await waitFor(() => ends(c) >= 2, "第二次 run.ended");
  const body = requested();
  expect(body).toContain("fresh");
  expect(body).not.toContain("second-queued");
  expect(body).not.toContain("third-queued");
});

test("停止后重新订阅：快照里的队列也是空的", async () => {
  const s = await launch();
  const { sid, c } = await open(s);
  await runningWithQueue(c);
  await c.command("stop");
  await waitFor(() => ends(c) >= 1, "run.ended");
  const { c: late } = await open(s, sid);
  await waitFor(() => late.types().includes("snapshot"), "snapshot");
  const snap = late.frames.find((f) => f.type === "snapshot");
  expect(snap).toBeDefined();
  const data = snap?.data as Q | undefined;
  expect(data?.queue).toEqual([]);
});

test("空闲时停止：队列本来就空，不多发 queue.updated，也不报错", async () => {
  const s = await launch();
  const { c } = await open(s);
  expect((await c.command("stop")).ok).toBe(true);
  await new Promise((r) => setTimeout(r, 100));
  expect(queues(c)).toEqual([]);
});

test("停止只清用户排队的消息：子代理结果通知不丢，随下一次发送送达", async () => {
  SPAWN.on = true;
  const s = await launch();
  const { sid, c } = await open(s);
  await c.command("send_message", { text: "spawn" });
  // 子代理很快完成，结果通知排进父的队列；此时父还在跑（它的下一步被拖慢了）
  const childDone = async () =>
    (
      (await (
        await fetch(`${s.http}/api/v1/sessions/${sid}/flows`)
      ).json()) as {
        executions: Array<{ state: string }>;
      }
    ).executions[0]?.state === "done";
  for (let i = 0; i < 200 && !(await childDone()); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(await childDone()).toBe(true);
  expect(ends(c)).toBe(0);

  await c.command("send_message", { text: "user-queued" });
  await waitFor(() => queues(c).some((q) => q.includes("user-queued")), "排队");
  await c.command("stop");
  await waitFor(() => ends(c) >= 1, "run.ended");
  await waitFor(() => queues(c).at(-1)?.length === 0, "队列为空");

  stub.mode.delayMs = 0;
  stub.requests.length = 0;
  await c.command("send_message", { text: "fresh" });
  await waitFor(() => ends(c) >= 2, "第二次 run.ended");
  const body = requested();
  expect(body).toContain("fresh");
  expect(body).toContain("[Subagent");
  expect(body).toContain("child-result");
  expect(body).not.toContain("user-queued");
}, 30_000);

test("工具正在执行时停止：排队的消息也不会趁收尾被写进上下文", async () => {
  SLOW.on = true;
  const s = await launch(true);
  // 完全允许档：bash 不弹审批，直接执行
  await fetch(`${s.http}/api/v1/defaults`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissionTier: "full" }),
  });
  const { c } = await open(s);
  await c.command("send_message", { text: "slow" });
  await waitFor(() => c.types().includes("tool.started"), "bash 开始");
  await c.command("send_message", { text: "user-queued" });
  await waitFor(() => queues(c).some((q) => q.includes("user-queued")), "排队");
  await c.command("stop");
  await waitFor(() => ends(c) >= 1, "run.ended", 15_000);
  await waitFor(() => queues(c).at(-1)?.length === 0, "队列为空");

  stub.requests.length = 0;
  await c.command("send_message", { text: "fresh" });
  await waitFor(() => ends(c) >= 2, "第二次 run.ended");
  expect(requested()).toContain("fresh");
  // 不在新请求的历史里：既没被排空进上下文，也没被留到这次
  expect(requested()).not.toContain("user-queued");
}, 30_000);
