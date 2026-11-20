import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";

// 压缩期间再发消息：先排在队列里（可编辑、可删除），压缩结束后再送给 agent。
// 真实服务 + 真实会话（stub 当模型），走 WS 的 send_message / compact / edit_queue / remove_queue。
// 压缩要调一次模型生成摘要：stub 把这次请求拖慢，窗口里才发得进消息。
const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base: string;
let server: YuanshuServer | null = null;
const clients: TestClient[] = [];

beforeEach(async () => {
  base = makeTmpDir("yuanshu-compactq-");
  await mkdir(path.join(base, "web"), { recursive: true });
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.stop().catch(() => {});
  server = null;
  stub.requests.length = 0;
  stub.mode.delayMs = 0;
});

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
      // 保留窗口调到最小，手动压缩才会真的切出「摘要 + 保留的消息」
      sessionFactory: stubSessionFactory(stub, {}, false, undefined, {
        keepRecentTokens: 1,
        reserveTokens: 1,
      }),
    },
  );
  const addr = await server.start();
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
  };
}

type Q = { queue: string[] };
const queues = (c: TestClient) =>
  c.frames
    .filter((f) => f.type === "queue.updated")
    .map((f) => (f.data as Q).queue);
const count = (c: TestClient, type: string) =>
  c.types().filter((t) => t === type).length;
const requested = () => JSON.stringify(stub.requests.map((r) => r.body));

// 先聊两轮，再发起压缩并等它真的进入压缩（摘要请求被拖住）
async function compacting() {
  const s = await launch();
  const sid = (
    (await (
      await fetch(`${s.http}/api/v1/sessions`, { method: "POST" })
    ).json()) as {
      id: string;
    }
  ).id;
  const c = await TestClient.connect(`${s.ws}/api/v1/sessions/${sid}/stream`);
  clients.push(c);
  await c.command("send_message", { text: "one" });
  await waitFor(() => count(c, "run.ended") >= 1, "第一轮结束");
  await c.command("send_message", { text: "two" });
  await waitFor(() => count(c, "run.ended") >= 2, "第二轮结束");
  stub.mode.delayMs = 600;
  const before = stub.requests.length;
  expect((await c.command("compact")).ok).toBe(true);
  await waitFor(() => stub.requests.length > before, "摘要请求发出");
  stub.mode.delayMs = 0;
  return c;
}

test("压缩期间发的消息进队列并同步显示，压缩完成后才送给 agent", async () => {
  const c = await compacting();
  const before = stub.requests.length;
  expect((await c.command("send_message", { text: "after-compact" })).ok).toBe(
    true,
  );
  expect(queues(c).at(-1)).toEqual(["after-compact"]);
  // 压缩还没结束：这条消息没有送去模型
  expect(requested()).not.toContain("after-compact");

  await waitFor(() => count(c, "context.compacted") >= 1, "压缩完成");
  await waitFor(() => count(c, "run.ended") >= 3, "排着的消息跑完一轮");
  expect(queues(c).at(-1)).toEqual([]);
  expect(stub.requests.length).toBeGreaterThan(before);
  expect(requested()).toContain("after-compact");
});

test("压缩期间排着的消息可以编辑和删除，剩下的按原顺序依次送出", async () => {
  const c = await compacting();
  for (const text of ["q1", "q2", "q3"])
    await c.command("send_message", { text });
  expect(queues(c).at(-1)).toEqual(["q1", "q2", "q3"]);

  expect(
    (
      await c.command("edit_queue", {
        index: 0,
        text: "q1-edited",
        attachments: [],
      })
    ).ok,
  ).toBe(true);
  expect((await c.command("remove_queue", { index: 1 })).ok).toBe(true);
  expect(queues(c).at(-1)).toEqual(["q1-edited", "q3"]);
  const full = await c.command("get_queue");
  expect(JSON.stringify(full)).toContain("q1-edited");

  await waitFor(() => count(c, "run.ended") >= 3, "排着的消息跑完");
  const body = requested();
  expect(body).toContain("q1-edited");
  expect(body).toContain("q3");
  expect(body).not.toContain("q2");
  // 编辑前的原文不会送出
  expect(body.replace("q1-edited", "")).not.toContain("q1");
  expect(body.indexOf("q1-edited")).toBeLessThan(body.indexOf("q3"));
});
