import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import {
  type StubReply,
  startStub,
  stubSessionFactory,
} from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";

// 真实服务 + 真实会话：父模型真的调 spawn_subagent，子代理的调用记在子会话名下。
// 父会话的审计「子代理」档读 /subagent-calls：整棵子树的调用，并标明来自哪个子会话。
// 一个场景含两轮对话、三层会话，比默认的 5 秒慢。
vi.setConfig({ testTimeout: 30_000 });

import { BRIEF } from "../../test/support/subagents.js";

type Msg = { role: string; content?: unknown };
const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b: { text?: string }) => b?.text ?? "").join("")
      : "";

// 根：问「甲」派甲、其余派乙；子代理按任务：甲交付一句话，乙派孙代理再交付，孙交付一句话。
// spawn_subagent 默认阻塞，交付就是工具结果，所以没有 wait。
const stub = await startStub((_n, body): StubReply => {
  const msgs = (body.messages ?? []) as Msg[];
  const last = msgs.at(-1);
  const brief = msgs.find(
    (m) => m.role === "user" && textOf(m.content).includes(BRIEF),
  );
  const task = brief
    ? (/Task:\n(.+)/.exec(textOf(brief.content))?.[1] ?? "")
    : "";
  const tools = msgs.filter((m) => m.role === "tool").length;
  if (!brief) {
    if (last?.role !== "tool") {
      const ask = textOf(msgs.findLast((m) => m.role === "user")?.content);
      return {
        tool: "spawn_subagent",
        args: { task: ask.includes("甲") ? "任务甲" : "派孙" },
      };
    }
    return "汇总";
  }
  if (task === "派孙") {
    if (tools === 0)
      return { tool: "spawn_subagent", args: { task: "孙任务" } };
    if (tools === 1) return { tool: "deliver", args: { summary: "乙的结论" } };
    return "乙收尾";
  }
  const word = task === "任务甲" ? "甲的结论" : "孙的结论";
  return tools === 0 ? { tool: "deliver", args: { summary: word } } : word;
});
afterAll(() => stub.close());

let base: string;
let server: YuanshuServer | null = null;
const clients: TestClient[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-subcalls-"));
  await mkdir(path.join(base, "web"), { recursive: true });
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.stop().catch(() => {});
  server = null;
  stub.requests.length = 0;
  await rm(base, { recursive: true, force: true });
});

const TOKEN = process.env.YUANSHU_TEST_TOKEN;
const authInit = (init: RequestInit = {}): RequestInit =>
  TOKEN
    ? {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${TOKEN}`,
        },
      }
    : init;

async function launch() {
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      allowCidrs: [],
      ...(TOKEN ? { token: TOKEN } : {}),
    },
    {
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub),
    },
  );
  const addr = await server.start();
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
  };
}
type Srv = Awaited<ReturnType<typeof launch>>;

const get = (s: Srv, p: string) =>
  fetch(`${s.http}/api/v1/sessions${p}`, authInit());
const json = async <T>(s: Srv, p: string) => (await get(s, p)).json() as T;

interface Call {
  id: string;
  seq: number;
  turn: number | null;
  trigger: string;
  subagent?: { sessionId: string; name: string };
}
interface SubPage {
  calls: Call[];
  nextBefore: string | null;
  total: number;
}

// 等到 3 个子会话都落了终态，且模型请求连续 400ms 没有新增（父的收尾轮也跑完了）。
async function settled(s: Srv, id: string) {
  const done = async () =>
    (
      await json<{ executions: Array<{ state: string }> }>(s, `/${id}/flows`)
    ).executions.filter((e) => e.state === "done").length;
  let quiet = 0;
  let seen = -1;
  for (let i = 0; i < 600 && quiet < 8; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const n = stub.requests.length;
    quiet = n === seen && (await done()) === 3 ? quiet + 1 : 0;
    seen = n;
  }
  if (quiet < 8) throw new Error("等待超时：场景没有静止");
}

// 根会话依次问「甲」与「乙」：甲派一个只答一句的子代理，乙派一个会再派孙代理的子代理。
async function scenario() {
  const s = await launch();
  const res = await fetch(
    `${s.http}/api/v1/sessions`,
    authInit({ method: "POST" }),
  );
  const { id } = (await res.json()) as { id: string };
  const c = await TestClient.connect(
    `${s.ws}/api/v1/sessions/${id}/stream`,
    TOKEN ? { token: TOKEN } : {},
  );
  clients.push(c);
  for (const text of ["去问甲", "去问乙"]) {
    await c.command("send_message", { text });
    // 子代理的结果可能先于 wait 到达而多唤醒父一轮，所以不数 run.ended，等到全部子会话结束且模型请求静默。
    await waitFor(() => c.types().includes("run.ended"), "run.ended", 15000);
  }
  await settled(s, id);
  const flows = await json<{
    executions: Array<{ id: string; parentId: string; name: string }>;
  }>(s, `/${id}/flows`);
  const exec = (name: string) => {
    const e = flows.executions.find((x) => x.name === name);
    if (!e) throw new Error(`没有执行体：${name}`);
    return e;
  };
  return {
    s,
    id,
    jia: exec("任务甲").id,
    yi: exec("派孙").id,
    sun: exec("孙任务").id,
  };
}

test("父会话的 /calls 不含子代理调用，/subagent-calls 含整棵子树并标明来自哪个子会话", async () => {
  const { s, id, jia, yi, sun } = await scenario();

  // 自己的调用口径不变：只有自己的 seq 1..n（n 与 usage.steps 一致），没有 subagent 触发的，也不带来源标记
  const own = await json<{ calls: Call[] }>(s, `/${id}/calls?limit=200`);
  const usage = await json<{ steps: number }>(s, `/${id}/usage`);
  expect(own.calls.length).toBe(usage.steps);
  expect(own.calls.map((c) => c.seq)).toEqual(
    Array.from({ length: usage.steps }, (_, i) => usage.steps - i),
  );
  expect(own.calls.filter((c) => c.trigger === "subagent")).toEqual([]);
  expect(own.calls.every((c) => c.subagent === undefined)).toBe(true);

  // 子树 = 甲、乙、孙各自名下的调用（逐个从既有的 /sessions/:childId/calls 取数核对）。
  // 条数不写死：子代理的结果通知可能多唤醒一轮，但下限固定（乙至少 派发 / 等待 / 结论 三次）。
  const mine = async (sid: string) =>
    (await json<{ calls: Call[] }>(s, `/${sid}/calls?limit=200`)).calls;
  const [nJia, nYi, nSun] = [
    (await mine(jia)).length,
    (await mine(yi)).length,
    (await mine(sun)).length,
  ];
  expect(nJia).toBeGreaterThanOrEqual(1);
  expect(nYi).toBeGreaterThanOrEqual(3);
  expect(nSun).toBeGreaterThanOrEqual(1);
  const sub = await json<SubPage>(s, `/${id}/subagent-calls`);
  expect(sub.total).toBe(nJia + nYi + nSun);
  expect(sub.calls).toHaveLength(sub.total);
  expect(sub.nextBefore).toBeNull();
  expect(sub.calls.every((c) => c.trigger === "subagent")).toBe(true);
  const by = (sid: string) =>
    sub.calls.filter((c) => c.subagent?.sessionId === sid);
  expect(by(jia)).toHaveLength(nJia);
  expect(by(yi)).toHaveLength(nYi);
  expect(by(sun)).toHaveLength(nSun);
  expect(by(jia)[0]?.subagent?.name).toBe("任务甲");
  expect(by(yi)[0]?.subagent?.name).toBe("派孙");
  expect(by(sun)[0]?.subagent?.name).toBe("孙任务");
  // seq / turn 是子会话内的序号
  expect(by(yi).map((c) => c.seq)).toEqual(
    Array.from({ length: nYi }, (_, i) => nYi - i),
  );
  expect(by(yi).every((c) => c.turn === 1)).toBe(true);

  // 倒序（id 是时间序）
  const ids = sub.calls.map((c) => c.id);
  expect(ids).toEqual([...ids].sort().reverse());

  // 单条详情按子会话 id 取，且正是那条调用
  const one = sub.calls[0] as Call;
  const rec = await json<{ id: string; sessionId: string }>(
    s,
    `/${one.subagent?.sessionId}/calls/${one.id}`,
  );
  expect(rec).toMatchObject({ id: one.id, sessionId: one.subagent?.sessionId });
});

test("子会话自己的 /subagent-calls 只含它名下的子树；没有子代理的会话为空", async () => {
  const { s, jia, yi, sun } = await scenario();
  const nSun = (await json<{ calls: Call[] }>(s, `/${sun}/calls?limit=200`))
    .calls.length;
  const ofYi = await json<SubPage>(s, `/${yi}/subagent-calls`);
  expect(ofYi.total).toBe(nSun);
  expect(new Set(ofYi.calls.map((c) => c.subagent?.sessionId))).toEqual(
    new Set([sun]),
  );
  const ofJia = await json<SubPage>(s, `/${jia}/subagent-calls`);
  expect(ofJia).toEqual({ calls: [], nextBefore: null, total: 0 });
});

test("分页：按 id 游标翻页，不重不漏，total 不随分页变化", async () => {
  const { s, id } = await scenario();
  const all = await json<SubPage>(s, `/${id}/subagent-calls`);
  expect(all.total).toBeGreaterThanOrEqual(5);
  const seen: string[] = [];
  let before: string | null = null;
  let pages = 0;
  do {
    const q: string = `limit=2${before ? `&before=${before}` : ""}`;
    const p = await json<SubPage>(s, `/${id}/subagent-calls?${q}`);
    expect(p.total).toBe(all.total);
    seen.push(...p.calls.map((c) => c.id));
    before = p.nextBefore;
    pages++;
  } while (before !== null);
  expect(pages).toBe(Math.ceil(all.total / 2));
  expect(seen).toEqual(all.calls.map((c) => c.id));
});

test("参数校验：会话不存在 404，游标与条数非法 400", async () => {
  const { s, id } = await scenario();
  expect((await get(s, "/nope/subagent-calls")).status).toBe(404);
  expect((await get(s, `/${id}/subagent-calls?before=3`)).status).toBe(400);
  expect((await get(s, `/${id}/subagent-calls?limit=0`)).status).toBe(400);
  expect((await get(s, `/${id}/subagent-calls?limit=201`)).status).toBe(400);
});
