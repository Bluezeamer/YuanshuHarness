import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { MAX_QUEUE_ITEM } from "./events.js";

// 排队输入的编辑 / 删除：真实服务 + 真实会话（stub 当模型），走 WS 的 send_message / edit_queue / remove_queue。
// default 每次回 reply-N；SPAWN 打开时父收到「spawn」就派一个子代理，随后的一步很慢（让父一直在跑），
// 子代理立刻回一句结论，结果通知会排进父的 follow-up 队列（不是用户输入，编辑/删除排队消息时必须保住）。
const BRIEF = "You are a subagent dispatched by another agent session";
type Msg = { role: string; content?: unknown };
const SPAWN = { on: false };
const stub = await startStub((n, body) => {
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
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-queue-edit-"));
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
  await rm(base, { recursive: true, force: true });
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
// 另一张合法 PNG：用来分辨哪一张图被留下、哪一张被替换掉。
const KEPT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function launch(modelExtra: Record<string, unknown> = {}) {
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub, modelExtra),
    },
  );
  const addr = await server.start();
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
  };
}

async function open(s: Awaited<ReturnType<typeof launch>>) {
  const sid = (
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
type QueuedText = { text: string; attachments?: unknown[] };
const queues = (c: TestClient) =>
  c.frames
    .filter((f) => f.type === "queue.updated")
    .map((f) => (f.data as Q).queue);
const ends = (c: TestClient) =>
  c.types().filter((t) => t === "run.ended").length;
const requested = () => JSON.stringify(stub.requests.map((r) => r.body));

// 第一条消息正在生成时，再发两条（进 steering 队列，顺序与 UI 一致）
async function runningWithQueue(c: TestClient, delayMs = 600) {
  stub.mode.delayMs = delayMs;
  await c.command("send_message", { text: "first" });
  await waitFor(
    () => c.types().filter((t) => t === "message.started").length >= 2,
    "助手消息开始",
  );
  await c.command("send_message", { text: "second-queued" });
  await c.command("send_message", { text: "third-queued" });
  await waitFor(() => queues(c).some((q) => q.length === 2), "队列里有两条");
}

test("编辑排队消息：队列立即更新，随后送达模型的是新文本且保持原顺序", async () => {
  const s = await launch();
  const { c } = await open(s);
  await runningWithQueue(c);

  expect(
    (
      await c.command("edit_queue", {
        index: 1,
        text: "edited-third",
        attachments: [],
      })
    ).ok,
  ).toBe(true);
  await waitFor(
    () => queues(c).at(-1)?.join("|") === "second-queued|edited-third",
    "队列里换成编辑后的文本",
  );

  stub.mode.delayMs = 0;
  await waitFor(() => ends(c) >= 1, "run.ended", 15_000);
  const body = requested();
  expect(body).toContain("second-queued");
  expect(body).toContain("edited-third");
  expect(body).not.toContain("third-queued");
  // 排在第二位的仍是第二条：编辑不改变顺序
  expect(body.indexOf("second-queued")).toBeLessThan(
    body.indexOf("edited-third"),
  );
});

test(">512 字符的排队消息：显示被截断，get_queue 取回全文，编辑后送达全文", async () => {
  const s = await launch();
  const { c } = await open(s);
  stub.mode.delayMs = 800;
  await c.command("send_message", { text: "first" });
  await waitFor(
    () => c.types().filter((t) => t === "message.started").length >= 2,
    "助手消息开始",
  );
  // 尾巴在显示截断之外：只拿显示文本当编辑起点会静默丢内容
  const long = `${"长".repeat(600)}TAIL-MARKER`;
  await c.command("send_message", { text: long });
  await waitFor(() => queues(c).some((q) => q.length === 1), "排队");
  const shown = queues(c).at(-1)?.[0] ?? "";
  expect(shown).toHaveLength(MAX_QUEUE_ITEM);
  expect(shown).not.toContain("TAIL-MARKER");

  const r = await c.command("get_queue");
  expect(r.ok).toBe(true);
  expect((r.data as { queue: QueuedText[] }).queue).toEqual([{ text: long }]);

  const edited = `${"长".repeat(600)}EDITED-TAIL`;
  expect(
    (
      await c.command("edit_queue", {
        index: 0,
        text: edited,
        attachments: [],
      })
    ).ok,
  ).toBe(true);
  await waitFor(
    () => queues(c).filter((q) => q.length === 1).length >= 2,
    "编辑后的队列帧",
  );

  stub.mode.delayMs = 0;
  await waitFor(() => ends(c) >= 1, "run.ended", 15_000);
  expect(requested()).toContain(edited);
});

test("删除排队消息：从队列消失，也不会送达模型", async () => {
  const s = await launch();
  const { c } = await open(s);
  await runningWithQueue(c);

  expect((await c.command("remove_queue", { index: 0 })).ok).toBe(true);
  await waitFor(
    () => queues(c).at(-1)?.join("|") === "third-queued",
    "队列里只剩一条",
  );

  stub.mode.delayMs = 0;
  await waitFor(() => ends(c) >= 1, "run.ended", 15_000);
  const body = requested();
  expect(body).toContain("third-queued");
  expect(body).not.toContain("second-queued");
});

test("非法编辑 / 删除：越界、空文本、非数字 index 都被拒绝，队列不变", async () => {
  const s = await launch();
  const { c } = await open(s);
  await runningWithQueue(c, 2000);

  const cases: Array<{ command: string; args: Record<string, unknown> }> = [
    {
      command: "edit_queue",
      args: { index: 2, text: "越界", attachments: [] },
    },
    {
      command: "edit_queue",
      args: { index: -1, text: "负数", attachments: [] },
    },
    {
      command: "edit_queue",
      args: { index: 0, text: "   ", attachments: [] },
    },
    {
      command: "edit_queue",
      args: { index: "0", text: "类型不对", attachments: [] },
    },
    // attachments 必填
    { command: "edit_queue", args: { index: 0, text: "缺附件参数" } },
    { command: "remove_queue", args: { index: 9 } },
    { command: "remove_queue", args: { index: "0" } },
  ];
  for (const x of cases) {
    const r = await c.command(x.command, x.args);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_request");
  }
  expect(queues(c).at(-1)).toEqual(["second-queued", "third-queued"]);
});

test("编辑排队消息不会误删 follow-up 里的子代理结果通知", async () => {
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
  expect(
    (
      await c.command("edit_queue", {
        index: 0,
        text: "user-queued-edited",
        attachments: [],
      })
    ).ok,
  ).toBe(true);
  await waitFor(
    () => queues(c).at(-1)?.includes("user-queued-edited") === true,
    "队列换成编辑后的文本",
  );
  await waitFor(() => ends(c) >= 1, "run.ended", 30_000);

  const body = requested();
  expect(body).toContain("user-queued-edited");
  expect(body).not.toContain('"user-queued"');
  // 子代理通知仍在：随后的请求里能看到系统通知与子代理结论
  expect(body).toContain("[Subagent");
  expect(body).toContain("child-result");
}, 40_000);

// 上传一个附件，返回服务端记下的引用（与 REST 上传接口同形）。
async function upload(
  s: Awaited<ReturnType<typeof launch>>,
  sid: string,
  name: string,
  data: Uint8Array,
) {
  const res = await fetch(
    `${s.http}/api/v1/sessions/${sid}/attachments?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: data,
    },
  );
  return (await res.json()) as {
    path: string;
    name: string;
    mime: string;
    sizeText: string;
  };
}

test("排队消息带附件：get_queue 拆出文字与附件；编辑后该条的图片被替换，其余条目原图不动", async () => {
  // 模型要支持图片输入，带图的排队消息才发得出去
  const s = await launch({ input: ["text", "image"] });
  const { sid, c } = await open(s);
  stub.mode.delayMs = 800;
  await c.command("send_message", { text: "first" });
  await waitFor(
    () => c.types().filter((t) => t === "message.started").length >= 2,
    "助手消息开始",
  );

  const png = await upload(s, sid, "p.png", PNG);
  const kept = await upload(s, sid, "kept.png", KEPT);
  const note = await upload(s, sid, "note.txt", Buffer.from("abc"));
  await c.command("send_message", {
    text: "with-image",
    attachments: [{ path: png.path }],
  });
  await c.command("send_message", {
    text: "keep-image",
    attachments: [{ path: kept.path }],
  });
  await waitFor(() => queues(c).some((q) => q.length === 2), "队列里有两条");

  // get_queue：文字里没有标记行，附件单独给出
  const q = async () =>
    (await c.command("get_queue")).data as {
      queue: { text: string; attachments?: { name: string }[] }[];
    };
  const first = await q();
  expect(first.queue.map((x) => x.text)).toEqual(["with-image", "keep-image"]);
  expect(first.queue[0]?.attachments?.map((a) => a.name)).toEqual(["p.png"]);
  expect(first.queue[1]?.attachments?.map((a) => a.name)).toEqual(["kept.png"]);

  // 换成非图片附件：这条的图片按新解析结果清掉，文字只带一行新标记
  expect(
    (
      await c.command("edit_queue", {
        index: 0,
        text: "edited",
        attachments: [{ path: note.path }],
      })
    ).ok,
  ).toBe(true);
  const edited = await q();
  expect(edited.queue[0]?.text).toBe("edited");
  expect(edited.queue[0]?.attachments?.map((a) => a.name)).toEqual([
    "note.txt",
  ]);
  // 其余条目原样（连同自己的附件）
  expect(edited.queue[1]).toEqual(first.queue[1]);

  stub.mode.delayMs = 0;
  await waitFor(() => ends(c) >= 1, "run.ended", 20_000);
  const body = requested();
  expect(body).toContain("edited");
  expect(body).toContain("note.txt");
  expect(body).not.toContain("with-image");
  // 被编辑那条的图片按新解析结果换成没有图片；另一条的原图仍然带回
  expect(body).not.toContain(PNG.toString("base64"));
  expect(body).toContain(KEPT.toString("base64"));
  // 标记行没有被重复追加
  expect(body.match(/\[attach_file\].*note\.txt/g)).toHaveLength(1);
});
