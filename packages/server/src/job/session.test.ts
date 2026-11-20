import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";

// 真实服务 + 真实会话（stub 当模型）：模型用 job_start 把命令放到后台，外层调用先返回，
// 命令跑完后回调自己找上门，把空闲的会话叫醒。
type Msg = { role: string; content?: unknown };
const stub = await startStub((n, body) => {
  const msgs = (body.messages ?? []) as Msg[];
  const last = msgs.at(-1);
  const txt = JSON.stringify(last?.content ?? "");
  if (last?.role === "user" && txt.includes("Background job"))
    return "ack-callback";
  if (last?.role === "user" && txt.includes("go"))
    return {
      tool: "job_start",
      args: {
        name: "bash",
        arguments: { command: "sleep 1.2; echo bg-$((6*7))" },
        label: "slow-build",
      },
    };
  if (last?.role === "user" && txt.includes("list"))
    return { tool: "job_list", args: {} };
  return `reply-${n}`;
});
afterAll(() => stub.close());

let base: string;
let server: YuanshuServer | null = null;
const clients: TestClient[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-jobsess-"));
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

const ends = (c: TestClient) =>
  c.types().filter((t) => t === "run.ended").length;
const requested = () => JSON.stringify(stub.requests.map((r) => r.body));

async function launch() {
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub, {}, true),
    },
  );
  const addr = await server.start();
  const http = `http://127.0.0.1:${addr.port}`;
  // 完全允许档：bash 不弹审批
  await fetch(`${http}/api/v1/defaults`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissionTier: "full" }),
  });
  const { id } = (await (
    await fetch(`${http}/api/v1/sessions`, { method: "POST" })
  ).json()) as { id: string };
  const c = await TestClient.connect(
    `ws://127.0.0.1:${addr.port}/api/v1/sessions/${id}/stream`,
  );
  clients.push(c);
  return { http, id, c };
}

test("job_start：外层调用立即返回，命令跑完后回调唤醒空闲的会话", async () => {
  const { http, id, c } = await launch();
  await c.command("send_message", { text: "go" });
  await waitFor(() => ends(c) >= 1, "第一次 run.ended");
  // 第一轮的工具结果是「已启动」，不是命令输出
  expect(requested()).toContain("Started job");
  expect(requested()).not.toContain("bg-42");

  // 命令完成 → 回调把会话叫醒，第二次运行里带着日志末尾
  await waitFor(() => ends(c) >= 2, "回调触发的第二次 run.ended", 15_000);
  const body = requested();
  expect(body).toContain("[Background job");
  expect(body).toContain("finished with exit code 0");
  expect(body).toContain("bg-42");

  const { jobs } = (await (
    await fetch(`${http}/api/v1/sessions/${id}/jobs`)
  ).json()) as { jobs: Array<{ state: string; label: string }> };
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ state: "done", label: "slow-build" });

  // 登记与终态各推一次 jobs.updated（右栏的「后台任务」据此刷新）
  expect(
    c.types().filter((t) => t === "jobs.updated").length,
  ).toBeGreaterThanOrEqual(2);

  // 回调同时是一帧 notice（kind: job）：卡片的位置就是消息进入对话序列的位置
  expect(c.types()).toContain("notice");
  const notice = c.frames.find((f) => f.type === "notice");
  expect(notice?.data).toMatchObject({
    kind: "job",
    job: { state: "done", label: "slow-build" },
  });

  // 历史接口给它同样的锚点
  const msgs = (await (
    await fetch(`${http}/api/v1/sessions/${id}/messages`)
  ).json()) as {
    notices: Array<{
      afterIndex: number;
      ts?: string;
      kind: string;
      job: { id: string };
    }>;
  };
  expect(msgs.notices).toHaveLength(1);
  expect(msgs.notices[0]?.job.id).toBe(notice?.data.job.id);
  // user + 带工具调用的助手消息 + 报告已启动的助手消息，之后才是回调
  expect(msgs.notices[0]?.afterIndex).toBe(3);
  expect(msgs.notices[0]?.ts).toEqual(expect.any(String));
}, 30_000);

test("job_list 列出自己的任务；REST 能读详情与日志", async () => {
  const { http, c } = await launch();
  await c.command("send_message", { text: "go" });
  await waitFor(() => ends(c) >= 2, "回调", 15_000);
  stub.requests.length = 0;
  await c.command("send_message", { text: "list" });
  await waitFor(() => ends(c) >= 3, "第三次 run.ended");
  expect(requested()).toContain("slow-build");

  const row = (await (
    await fetch(`${http}/api/v1/sessions/${(await sessions(http))[0]}/jobs`)
  ).json()) as { jobs: Array<{ id: string; input: string }> };
  const id = row.jobs[0]?.id as string;
  // 完整命令进了任务记录
  expect(row.jobs[0]?.input).toBe("sleep 1.2; echo bg-$((6*7))");
  const detail = (await (await fetch(`${http}/api/v1/jobs/${id}`)).json()) as {
    job: { state: string; input: string };
  };
  expect(detail.job.state).toBe("done");
  expect(detail.job.input).toBe("sleep 1.2; echo bg-$((6*7))");
  const log = (await (await fetch(`${http}/api/v1/jobs/${id}/log`)).json()) as {
    text: string;
    next: number;
    ended: boolean;
  };
  expect(log.text).toContain("bg-42");
  expect(log.ended).toBe(true);
  // 已读到末尾：再取一次是空的
  const rest = (await (
    await fetch(`${http}/api/v1/jobs/${id}/log?from=${log.next}`)
  ).json()) as { text: string; ended: boolean };
  expect(rest).toMatchObject({ text: "", ended: true });
}, 30_000);

async function sessions(http: string): Promise<string[]> {
  const r = (await (await fetch(`${http}/api/v1/sessions`)).json()) as {
    sessions: Array<{ id: string }>;
  };
  return r.sessions.map((s) => s.id);
}
