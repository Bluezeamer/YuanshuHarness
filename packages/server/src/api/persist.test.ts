import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { waitFor } from "../../test/support/frames.js";
import {
  appendDanglingToolCall,
  persistSession,
  startStub,
  stubSessionFactory,
} from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { findSessionFile } from "../store/sessions.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base: string;
let dataDir: string;
let webRoot: string;
const servers: YuanshuServer[] = [];
const clients: TestClient[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-persist-"));
  dataDir = path.join(base, "data");
  webRoot = path.join(base, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, "index.html"), "<title>x</title>");
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.stop().catch(() => {});
  stub.mode.delayMs = 0;
  stub.requests.length = 0;
  await rm(base, { recursive: true, force: true });
});

// R13：设 YUANSHU_TEST_TOKEN 时整组用例带令牌重跑，行为必须与回环无令牌一致。
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

async function launch(withFactory = true) {
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      allowCidrs: [],
      ...(TOKEN ? { token: TOKEN } : {}),
    },
    {
      webRoot,
      ...(withFactory ? { sessionFactory: stubSessionFactory(stub) } : {}),
    },
  );
  const addr = await server.start();
  servers.push(server);
  const stop = async () => {
    servers.splice(servers.indexOf(server), 1);
    await server.stop();
  };
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
    stop,
  };
}
type Srv = Awaited<ReturnType<typeof launch>>;

const api = (s: Srv, p: string, init?: RequestInit) =>
  fetch(`${s.http}/api/v1/sessions${p}`, authInit(init));
const json = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function chat(s: Srv, text: string, id?: string): Promise<string> {
  const sid =
    id ??
    ((await (await api(s, "", { method: "POST" })).json()) as { id: string })
      .id;
  const c = await TestClient.connect(
    `${s.ws}/api/v1/sessions/${sid}/stream`,
    TOKEN ? { token: TOKEN } : {},
  );
  clients.push(c);
  const before = c.types().filter((t) => t === "run.ended").length;
  await c.command("send_message", { text });
  await waitFor(
    () => c.types().filter((t) => t === "run.ended").length > before,
    "run.ended",
  );
  c.close();
  return sid;
}

describe("R4 / 启动与锁", () => {
  test("无会话工厂的 Server 也创建数据库并列出索引中的会话", async () => {
    const a = await launch();
    const id = await chat(a, "hi");
    await a.stop();
    const b = await launch(false);
    expect(await readdir(dataDir)).toContain("yuanshu.db");
    const list = (await (await api(b, "")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(list.sessions.map((s) => s.id)).toEqual([id]);
    expect((await api(b, "", { method: "POST" })).status).toBe(501);
    const hist = await api(b, `/${id}/messages`);
    expect(hist.status).toBe(200);
    const stream = await fetch(
      `${b.http}/api/v1/sessions/${id}/stream`,
      authInit(),
    );
    expect(stream.status).toBe(500);
  });

  test("R3 同一数据目录的第二个 Server 启动失败，不影响第一个；停止后可再启动", async () => {
    const a = await launch();
    const second = createServer(
      { host: "127.0.0.1", port: 0, dataDir, allowCidrs: [] },
      { webRoot },
    );
    await expect(second.start()).rejects.toThrow(/数据库|另一个/);
    expect((await fetch(`${a.http}/healthz`)).status).toBe(200);
    await a.stop();
    const c = await launch();
    expect((await fetch(`${c.http}/healthz`)).status).toBe(200);
  });

  test("R2 数据库版本高于代码：启动失败，数据库与会话文件不变", async () => {
    await mkdir(path.join(dataDir, "sessions"), { recursive: true });
    const db = new Database(path.join(dataDir, "yuanshu.db"));
    db.pragma("user_version = 99");
    db.close();
    const s = createServer(
      { host: "127.0.0.1", port: 0, dataDir, allowCidrs: [] },
      { webRoot },
    );
    await expect(s.start()).rejects.toThrow(/99/);
    const again = new Database(path.join(dataDir, "yuanshu.db"));
    expect(again.pragma("user_version", { simple: true })).toBe(99);
    again.close();
  });
});

describe("重启恢复（端到端）", () => {
  test("建会话对话 → 重启 → 列表在、重连得到快照、继续对话；历史分页与全文可取", async () => {
    const a = await launch();
    const id = await chat(a, "first-question");
    await a.stop();

    const b = await launch();
    const list = (await (await api(b, "")).json()) as {
      sessions: Array<{ id: string; running: boolean }>;
    };
    expect(list.sessions.map((s) => s.id)).toContain(id);
    const c = await TestClient.connect(
      `${b.ws}/api/v1/sessions/${id}/stream`,
      TOKEN ? { token: TOKEN } : {},
    );
    clients.push(c);
    await waitFor(() => c.frames.length > 0, "snapshot");
    expect(c.frames[0]?.type).toBe("snapshot");
    expect(
      c.frames[0]?.data.messages.map((m: { text: string }) => m.text),
    ).toEqual(["first-question", "reply-1"]);
    stub.requests.length = 0;
    await c.command("send_message", { text: "second" });
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
    expect(JSON.stringify(stub.requests[0]?.body)).toContain("first-question");

    const page = (await (await api(b, `/${id}/messages?limit=3`)).json()) as {
      messages: Array<{ index: number; text: string }>;
      nextBefore: string | null;
    };
    expect(page.messages.map((m) => m.index)).toEqual([1, 2, 3]);
    expect(page.nextBefore).not.toBeNull();
    const rest = (await (
      await api(b, `/${id}/messages?limit=3&before=${page.nextBefore}`)
    ).json()) as {
      messages: Array<{ index: number }>;
      nextBefore: string | null;
    };
    expect(rest.messages.map((m) => m.index)).toEqual([0]);
    expect(rest.nextBefore).toBeNull();
    const one = await api(b, `/${id}/messages/0`);
    expect(await one.json()).toEqual({
      index: 0,
      role: "user",
      text: "first-question",
    });
  });

  test("R11 加载失败返回 500，不影响其他会话", async () => {
    const a = await launch();
    const good = await chat(a, "ok");
    await a.stop();
    const bad = "01a14000-0000-7000-8000-0000000000bb";
    await writeFile(
      path.join(dataDir, "sessions", `2026-01-01T00-00-00-000Z_${bad}.jsonl`),
      "garbage\n",
    );
    const b = await launch();
    const res = await fetch(
      `${b.http}/api/v1/sessions/${bad}/stream`,
      authInit(),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "session_load_failed" });
    const c = await TestClient.connect(
      `${b.ws}/api/v1/sessions/${good}/stream`,
      TOKEN ? { token: TOKEN } : {},
    );
    clients.push(c);
    await waitFor(() => c.frames.length > 0, "snapshot");
    expect((await api(b, `/${bad}/messages`)).status).toBe(500);
  });

  test("R12 悬挂工具调用的会话：重启后第一次发送带中断通知", async () => {
    const a = await launch();
    const id = await chat(a, "q");
    await a.stop();
    const file = findSessionFile(path.join(dataDir, "sessions"), id);
    if (!file) throw new Error();
    appendDanglingToolCall(file);
    const b = await launch();
    stub.requests.length = 0;
    await chat(b, "continue", id);
    expect(JSON.stringify(stub.requests[0]?.body)).toContain(
      "上一次运行被中断",
    );
  });
});

describe("R13-R17 REST", () => {
  test("PATCH：改名、校验、404；重启后名称仍在", async () => {
    const a = await launch();
    const id = await chat(a, "x");
    const ok = await api(a, `/${id}`, json({ name: " 我的会话 " }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id, name: "我的会话" });
    for (const body of [
      { name: "   " },
      { name: "n".repeat(201) },
      {},
      { name: 5 },
    ])
      expect((await api(a, `/${id}`, json(body))).status).toBe(400);
    expect(
      (
        await api(
          a,
          `/01a14000-0000-7000-8000-0000000000ee`,
          json({ name: "x" }),
        )
      ).status,
    ).toBe(404);
    await a.stop();
    const b = await launch();
    expect(await (await api(b, `/${id}`)).json()).toMatchObject({
      name: "我的会话",
    });
  });

  test("DELETE：运行中 409；空闲 204，连接以 1001 关闭，之后 404；未加载的会话也能删", async () => {
    const a = await launch();
    const id = await chat(a, "x");
    const c = await TestClient.connect(
      `${a.ws}/api/v1/sessions/${id}/stream`,
      TOKEN ? { token: TOKEN } : {},
    );
    clients.push(c);
    await waitFor(() => c.frames.length > 0, "snapshot");
    stub.mode.delayMs = 1500;
    await c.command("send_message", { text: "slow" });
    await waitFor(() => c.types().includes("run.started"), "run.started");
    expect((await api(a, `/${id}`, { method: "DELETE" })).status).toBe(409);
    expect(findSessionFile(path.join(dataDir, "sessions"), id)).not.toBeNull();
    await c.command("stop");
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
    stub.mode.delayMs = 0;
    const res = await api(a, `/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    await waitFor(() => c.closed !== null, "连接关闭");
    expect(c.closed?.code).toBe(1001);
    expect((await api(a, `/${id}`)).status).toBe(404);
    expect((await api(a, `/${id}`, { method: "DELETE" })).status).toBe(404);

    const other = await chat(a, "y");
    await a.stop();
    const b = await launch();
    expect((await api(b, `/${other}`, { method: "DELETE" })).status).toBe(204);
    expect(findSessionFile(path.join(dataDir, "sessions"), other)).toBeNull();
    const list = (await (await api(b, "")).json()) as { sessions: unknown[] };
    expect(list.sessions).toEqual([]);
  });

  test("messages：非法参数 400，越界与不存在 404；空会话历史为空", async () => {
    const a = await launch();
    const id = await chat(a, "x");
    for (const q of [
      "limit=0",
      "limit=201",
      "limit=abc",
      "before=!!!",
      "before=OTk5OQ",
    ])
      expect((await api(a, `/${id}/messages?${q}`)).status).toBe(400);
    expect((await api(a, `/${id}/messages/99`)).status).toBe(404);
    expect((await api(a, `/${id}/messages/-1`)).status).toBe(400);
    expect((await api(a, `/${id}/messages/abc`)).status).toBe(400);
    expect(
      (await api(a, `/01a14000-0000-7000-8000-0000000000ee/messages`)).status,
    ).toBe(404);
    expect((await api(a, `/..%2f..%2fetc/messages`)).status).toBe(404);
    const empty = (
      (await (await api(a, "", { method: "POST" })).json()) as { id: string }
    ).id;
    expect(await (await api(a, `/${empty}/messages`)).json()).toEqual({
      messages: [],
      nextBefore: null,
    });
  });

  test("列表条目字段与排序；预置会话文件在启动对账后可见", async () => {
    await mkdir(path.join(dataDir, "sessions"), { recursive: true });
    const pre = "01a14000-0000-7000-8000-0000000000f2";
    await persistSession(
      stub,
      path.join(dataDir, "sessions"),
      pre,
      ["hello"],
      "preset",
    );
    const a = await launch();
    const list = (await (await api(a, "")).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({
      id: pre,
      name: "preset",
      running: false,
    });
    expect(Object.keys(list.sessions[0] ?? {}).sort()).toEqual([
      "agentId",
      "createdAt",
      "id",
      "mode",
      "name",
      "reviewPolicy",
      "running",
      "updatedAt",
      "workspaceId",
    ]);
  });
});
