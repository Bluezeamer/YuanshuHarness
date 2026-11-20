// 浏览器接口：页面增删唤醒、操作权、控制台与缩略图、引擎重试，以及工作区级事件流。
// 注册表与假页面用 pages/testkit，不装浏览器；Fastify 与 ws 是真的。

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { Writable } from "node:stream";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import WebSocket from "ws";
import { waitFor } from "../../test/support/frames.js";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { ToolCtx, type ToolPage } from "../browser/agent/testkit.js";
import type { EngineState } from "../browser/engine/types.js";
import { LoginService } from "../browser/login/login.js";
import { cleanupTmpDirs, makeRegistry } from "../browser/pages/testkit.js";
import { FrameStore } from "../browser/replay/frames.js";
import { Replay } from "../browser/replay/replay.js";
import { createShowBus, type ShowRequest } from "../browser/show.js";
import { UPLOAD_MAX_TOTAL_BYTES } from "../browser/uploads/limits.js";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { HttpError } from "../lib/http-error.js";
import { BrowserLoginStore } from "../store/browser-logins.js";
import { BrowserStepStore } from "../store/browser-steps.js";
import type { Directory } from "../store/directories.js";
import { browserApi } from "./browser.js";

afterAll(cleanupTmpDirs);

type Json = Record<string, unknown> & {
  // 响应体只在断言里读，字段按用例各取各的
  // biome-ignore lint/suspicious/noExplicitAny: 测试里的松散响应体
  [key: string]: any;
};

const READY: EngineState = {
  status: "ready",
  executable: "/x/chrome",
  sandbox: { enabled: true },
  emojiFont: true,
  problem: null,
};

class FakeEngine {
  current: EngineState = READY;
  ensured = 0;
  private readonly subs = new Set<(s: EngineState) => void>();
  state() {
    return this.current;
  }
  subscribe(cb: (s: EngineState) => void) {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  async ensure() {
    this.ensured += 1;
  }
  emit(state: EngineState) {
    this.current = state;
    for (const cb of this.subs) cb(state);
  }
}

let app: FastifyInstance;
let base = "";
let wsBase = "";
let h: ReturnType<typeof makeRegistry>;
let engine: FakeEngine;
let replay: Replay;
let logins: BrowserLoginStore;
let login: LoginService;
let subscriptions = { n: 0 };
// 端口发现接口：用例直接换这一份。
let listening: Array<{ envId: string; port: number }> = [];
// 挂起下载：用例直接控制暂存结果与调用记录，不碰真文件（除非用例自己给了真的暂存路径）。
let calls: Array<{ fn: string; args: unknown[] }> = [];
let staged: { filename: string; path: string; size: number } | null = null;
let stageError: Error | null = null;
let settleResult = true;
// 挂起上传：同样的直接控制方式。
let uploadError: Error | null = null;
// 展示提示：真的 bus（投递与退订的行为就是被测的东西本身）。
let showBus = createShowBus();
let cancelResult = true;
// 目录与环境：用例直接换这一份。
let directories: Directory[] = [];
let envFor: (d: Directory) => ExecEnv | null = () => new LocalEnv();
const ctxs = new Map<string, ToolCtx>();
const sockets: WebSocket[] = [];

beforeEach(async () => {
  ctxs.clear();
  listening = [];
  calls = [];
  staged = null;
  stageError = null;
  settleResult = true;
  uploadError = null;
  showBus = createShowBus();
  cancelResult = true;
  directories = [];
  envFor = () => new LocalEnv();
  // 用工具层的假上下文：它的假页面能预设控制台条目。
  h = makeRegistry({
    limits: { perWorkspace: 2 },
    context: async (key) => {
      const c = new ToolCtx();
      ctxs.set(key, c);
      h.onCtx?.(c);
      return c;
    },
  });
  engine = new FakeEngine();
  replay = new Replay({
    steps: new BrowserStepStore(h.db),
    frames: new FrameStore(`${makeTmpDir("yuanshu-api-replay-")}/frames`),
    registry: h.registry,
    rootOf: (s) => h.parents.get(s) ?? s,
  });
  // 统计事件订阅数：连接关闭后必须退订。每个用例一个计数器，上个用例迟到的关闭不会算进来。
  const counter = { n: 0 };
  subscriptions = counter;
  const subscribe = h.registry.subscribe.bind(h.registry);
  h.registry.subscribe = (cb) => {
    counter.n += 1;
    const off = subscribe(cb);
    return () => {
      counter.n -= 1;
      off();
    };
  };
  // 登录态：真库真加密，上下文的状态取注册表里那一个（ToolCtx 已有替身）。
  logins = new BrowserLoginStore(h.db, randomBytes(32));
  login = new LoginService({
    store: logins,
    stateOf: (key) => h.registry.storageState(key),
    liveKeys: () => [],
    seed: async () => {},
  });
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(browserApi, {
    registry: h.registry,
    engine: engine as never,
    workspaceExists: (id) => id === "w1" || id === "w2",
    targetOptions: () => ({
      findEnv: (name) => (name === "server" ? "local" : null),
      defaultEnvId: "local",
    }),
    replay,
    login,
    ports: { listening: async (wid) => (wid === "w1" ? listening : []) },
    downloads: {
      pending: {
        async stage(pageId, id, maxBytes) {
          calls.push({ fn: "stage", args: [pageId, id, maxBytes] });
          if (stageError) throw stageError;
          return staged ?? { filename: "a.zip", path: "/nope", size: 0 };
        },
        async settle(pageId, id, reason) {
          calls.push({ fn: "settle", args: [pageId, id, reason] });
          return settleResult;
        },
      },
      directories: (wid) => (wid === "w1" ? directories : []),
      envOf: (d) => envFor(d),
    },
    uploads: {
      pending: {
        async fill(pageId, id, files, maxBytes) {
          calls.push({ fn: "fill", args: [pageId, id, files, maxBytes] });
          if (uploadError) throw uploadError;
          // 与真实现一致：没有文件就是 400，别的校验由 uploads/pending.test 覆盖。
          if (files.length === 0)
            throw new HttpError("bad_files", "没有收到文件", 400);
        },
        cancel(pageId, id) {
          calls.push({ fn: "cancel", args: [pageId, id] });
          return cancelResult;
        },
      },
    },
    fileMaxBytes: () => 1000,
    show: showBus,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/api/v1`;
  wsBase = `ws://127.0.0.1:${port}/api/v1`;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.close();
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const openAsUser = async (target = "https://example.com/", wid = "w1") => {
  const r = await call("POST", `/workspaces/${wid}/browser/pages`, { target });
  return { r, body: (await r.json()) as Json };
};

const agentPage = async (url = "https://agent.test/", wid = "w1") =>
  (await h.registry.open({ workspaceKey: wid, actor: "s1", url })).page;

test("总览：引擎、页面、上限；不存在的工作区 404", async () => {
  const page = await agentPage();
  const r = await call("GET", "/workspaces/w1/browser");
  expect(r.status).toBe(200);
  const body = (await r.json()) as Json;
  expect(body.engine.status).toBe("ready");
  expect(body.pages.map((p: { id: string }) => p.id)).toEqual([page.id]);
  expect(body.limits).toEqual({
    perWorkspace: 2,
    global: 30,
    sleepingPerWorkspace: 100,
  });
  expect((await call("GET", "/workspaces/nope/browser")).status).toBe(404);
  // 别的工作区看不到它的页面
  const other = (await (
    await call("GET", "/workspaces/w2/browser")
  ).json()) as {
    pages: unknown[];
  };
  expect(other.pages).toEqual([]);
});

test("端口列表：只给此刻在监听的，target 用地址栏写法，按环境与端口排序", async () => {
  listening = [
    { envId: "gpu1", port: 8080 },
    { envId: "local", port: 5173 },
    { envId: "gpu1", port: 3000 },
    { envId: "local", port: 3000 },
  ];
  const r = await call("GET", "/workspaces/w1/browser/ports");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    ports: [
      { envId: "gpu1", port: 3000, target: "gpu1:3000" },
      { envId: "gpu1", port: 8080, target: "gpu1:8080" },
      { envId: "local", port: 3000, target: "server:3000" },
      { envId: "local", port: 5173, target: "server:5173" },
    ],
  });
});

test("端口列表：空列表；工作区不存在 404", async () => {
  const empty = await call("GET", "/workspaces/w1/browser/ports");
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ ports: [] });

  expect((await call("GET", "/workspaces/nope/browser/ports")).status).toBe(
    404,
  );
});

test("用户开页面：手动操作、不计会话引用；服务地址走虚拟主机名", async () => {
  const { r, body } = await openAsUser("https://example.com/a");
  expect(r.status).toBe(201);
  expect(body.page).toMatchObject({
    controller: "user",
    userOpened: true,
    usedBy: [],
    url: "https://example.com/a",
  });
  const svc = await openAsUser("server:3000/x");
  expect(svc.body.page.url).toBe("http://server.localhost:3000/x");
});

test("开页面的参数错误：空地址、不支持的协议 → 400 bad_target；工作区不存在 404", async () => {
  for (const target of ["", "   ", "file:///etc/passwd", 42]) {
    const { r, body } = await openAsUser(target as string);
    expect(r.status).toBe(400);
    expect(body.error).toBe("bad_target");
  }
  expect((await openAsUser("https://x.test/", "nope")).r.status).toBe(404);
});

test("导航失败：502，页面仍在列表里", async () => {
  h.onCtx = (c) => {
    c.pageInit = (p) => {
      p.gotoError = new Error("ERR_CONNECTION_REFUSED");
    };
  };
  const { r, body } = await openAsUser("https://down.test/");
  expect(r.status).toBe(502);
  expect(body.error).toBe("navigation_failed");
  expect(body.message).toContain("ERR_CONNECTION_REFUSED");
  expect(h.registry.list("w1")).toHaveLength(1);
});

test("达到上限且全受保护：409 limit 带中文原因", async () => {
  await openAsUser("https://a.test/");
  await openAsUser("https://b.test/");
  const { r, body } = await openAsUser("https://c.test/");
  expect(r.status).toBe(409);
  expect(body.error).toBe("limit");
  expect(body.message).toContain("最多同时激活");
});

test("唤醒：休眠页回到激活；不存在或别的工作区的页面 404", async () => {
  const a = await agentPage("https://a.test/");
  await agentPage("https://b.test/");
  await agentPage("https://c.test/");
  expect(h.registry.get(a.id)?.state).toBe("sleeping");

  const r = await call("POST", `/workspaces/w1/browser/pages/${a.id}/wake`);
  expect(r.status).toBe(200);
  expect(((await r.json()) as { state: string }).state).toBe("active");
  expect(
    (await call("POST", `/workspaces/w2/browser/pages/${a.id}/wake`)).status,
  ).toBe(404);
  expect(
    (await call("POST", "/workspaces/w1/browser/pages/pnope/wake")).status,
  ).toBe(404);
});

test("关闭：用户能关任何页面；之后 404", async () => {
  const page = await agentPage();
  const r = await call("POST", `/workspaces/w1/browser/pages/${page.id}/close`);
  expect(r.status).toBe(204);
  expect(h.registry.get(page.id)).toBeNull();
  expect(
    (await call("POST", `/workspaces/w1/browser/pages/${page.id}/close`))
      .status,
  ).toBe(404);
});

test("操作权：切到手动、交还 agent（epoch 加一）；非法 mode 400", async () => {
  const page = await agentPage();
  const url = `/workspaces/w1/browser/pages/${page.id}/control`;
  const user = (await (
    await call("POST", url, { mode: "user" })
  ).json()) as Json;
  expect(user.controller).toBe("user");
  const back = (await (
    await call("POST", url, { mode: "agent" })
  ).json()) as Json;
  expect(back).toMatchObject({ controller: "agent", epoch: 1 });
  expect((await call("POST", url, { mode: "x" })).status).toBe(400);
  expect((await call("POST", url, {})).status).toBe(400);
  expect(
    (
      await call("POST", "/workspaces/w1/browser/pages/pnope/control", {
        mode: "user",
      })
    ).status,
  ).toBe(404);
});

test("接管答复：有人在等才生效；非法 outcome 400；别的工作区 / 不存在 404", async () => {
  const page = await agentPage();
  const url = `/workspaces/w1/browser/pages/${page.id}/handoff`;
  const none = await call("POST", url, { outcome: "done" });
  expect(none.status).toBe(409);
  expect(((await none.json()) as Json).error).toBe("no_handoff");

  const wait = h.registry.beginHandoff(page.id, "需要登录");
  expect((await call("POST", url, { outcome: "x" })).status).toBe(400);
  expect((await call("POST", url, {})).status).toBe(400);
  expect(
    (await call("POST", url, { outcome: "refused", reason: "先不登" })).status,
  ).toBe(204);
  await expect(wait.answered).resolves.toEqual({
    kind: "refused",
    reason: "先不登",
  });
  wait.end();

  expect(
    (
      await call("POST", `/workspaces/w2/browser/pages/${page.id}/handoff`, {
        outcome: "done",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call("POST", "/workspaces/w1/browser/pages/pnope/handoff", {
        outcome: "done",
      })
    ).status,
  ).toBe(404);
});

test("登录态：查询与保存；别的工作区的页面 404；no_site 400、no_state 409", async () => {
  const page = await agentPage("https://accounts.google.com/login");
  const url = `/workspaces/w1/browser/pages/${page.id}/login`;

  // 上下文里还没有内容：不提示，也存不了
  expect(await (await call("GET", url)).json()).toEqual({
    site: "google.com",
    saved: false,
    offer: false,
  });
  const empty = await call("POST", url);
  expect(empty.status).toBe(409);
  expect(((await empty.json()) as Json).error).toBe("no_state");

  const ctx = ctxs.get("w1") as ToolCtx;
  ctx.storageState = async () => ({
    cookies: [
      {
        name: "sid",
        value: "abc123",
        domain: ".google.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  });
  expect(await (await call("GET", url)).json()).toEqual({
    site: "google.com",
    saved: false,
    offer: true,
  });

  const saved = await call("POST", url);
  expect(saved.status).toBe(200);
  expect((await saved.json()) as Json).toMatchObject({
    site: "google.com",
    enabled: true,
    cookies: 1,
    origins: 0,
  });
  expect(await (await call("GET", url)).json()).toMatchObject({
    site: "google.com",
    saved: true,
    offer: false,
  });

  // 本机地址没有站点可言
  h.onCtx = null;
  const local = await agentPage("http://localhost:3000/");
  const localUrl = `/workspaces/w1/browser/pages/${local.id}/login`;
  expect(await (await call("GET", localUrl)).json()).toEqual({
    site: null,
    saved: false,
    offer: false,
  });
  const noSite = await call("POST", localUrl);
  expect(noSite.status).toBe(400);
  expect(((await noSite.json()) as Json).error).toBe("no_site");

  // 别的工作区的页面：两条都 404
  for (const method of ["GET", "POST"])
    expect(
      (await call(method, `/workspaces/w2/browser/pages/${page.id}/login`))
        .status,
    ).toBe(404);
  expect(
    (await call("GET", "/workspaces/w1/browser/pages/pnope/login")).status,
  ).toBe(404);
});

test("控制台：激活页给条目，休眠页给空列表且不唤醒", async () => {
  const page = await agentPage("https://a.test/");
  const ctx = ctxs.get("w1") as ToolCtx;
  ctx.pageAt(0).consoleItems = [
    {
      id: 1,
      ts: 1,
      firstTs: 1,
      count: 1,
      kind: "console",
      level: "log",
      text: "hi",
    },
  ];
  const ok = (await (
    await call("GET", `/workspaces/w1/browser/pages/${page.id}/console`)
  ).json()) as { entries: unknown[] };
  expect(ok.entries).toHaveLength(1);

  await h.registry.sleep(page.id);
  const created = ctx.pages.length;
  const asleep = (await (
    await call("GET", `/workspaces/w1/browser/pages/${page.id}/console`)
  ).json()) as { entries: unknown[] };
  expect(asleep.entries).toEqual([]);
  expect(ctx.pages).toHaveLength(created);
});

test("缩略图：没有 404；休眠后有 JPEG", async () => {
  const page = await agentPage();
  const url = `/workspaces/w1/browser/pages/${page.id}/thumb`;
  expect((await call("GET", url)).status).toBe(404);
  await h.registry.sleep(page.id);
  const r = await call("GET", url);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("image/jpeg");
  expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(0);
});

test("引擎重试：202 并触发 ensure", async () => {
  const r = await call("POST", "/browser/engine/ensure");
  expect(r.status).toBe(202);
  expect(((await r.json()) as { engine: EngineState }).engine.status).toBe(
    "ready",
  );
  expect(engine.ensured).toBe(1);
});

// —— 事件流 ——

function connect(path: string): Promise<{ ws: WebSocket; messages: Json[] }> {
  const ws = new WebSocket(`${wsBase}${path}`);
  sockets.push(ws);
  const messages: Json[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
    ws.once("unexpected-response", (_q, res) =>
      reject(new Error(`HTTP ${res.statusCode}`)),
    );
  });
}

test("事件流：先给整体快照，再推本工作区的页面变化与引擎状态，不推别的工作区", async () => {
  const existing = await agentPage("https://a.test/");
  const { messages } = await connect("/workspaces/w1/browser/events");
  await waitFor(() => messages.length >= 1, "快照");
  expect(messages[0]).toMatchObject({ type: "snapshot" });
  expect(messages[0]?.pages.map((p: { id: string }) => p.id)).toEqual([
    existing.id,
  ]);
  expect(messages[0]?.engine.status).toBe("ready");

  const added = await agentPage("https://b.test/");
  await agentPage("https://other.test/", "w2");
  engine.emit({ ...READY, status: "starting" });
  await waitFor(() => messages.some((m) => m.type === "engine"), "引擎状态");
  const pageEvents = messages.filter((m) => m.type === "page");
  expect(
    pageEvents.some(
      (m) => m.event.type === "added" && m.event.page.id === added.id,
    ),
  ).toBe(true);
  // w2 的页面事件一条都不能到这里
  expect(
    pageEvents.every((m) =>
      m.event.type === "removed"
        ? m.event.workspaceKey === "w1"
        : m.event.page.workspaceKey === "w1",
    ),
  ).toBe(true);
  expect(messages.find((m) => m.type === "engine")?.state.status).toBe(
    "starting",
  );
});

test("事件流：ping 回 pong，不重发快照（回前台探活）", async () => {
  const { ws, messages } = await connect("/workspaces/w1/browser/events");
  await waitFor(() => messages.length >= 1, "快照");
  ws.send(JSON.stringify({ type: "ping" }));
  await waitFor(() => messages.some((m) => m.type === "pong"), "pong");
  expect(messages.filter((m) => m.type === "snapshot")).toHaveLength(1);
});

test("事件流：工作区不存在是普通 404；连接关闭后退订", async () => {
  await expect(connect("/workspaces/nope/browser/events")).rejects.toThrow(
    "HTTP 404",
  );
  const { ws } = await connect("/workspaces/w1/browser/events");
  await waitFor(() => subscriptions.n === 1, "已订阅");
  ws.close();
  await waitFor(() => subscriptions.n === 0, "已退订");
});

test("事件流：browser_show 的提示只到本工作区在线的界面，连接关闭后退订", async () => {
  const show: ShowRequest = {
    sessionId: "s1",
    by: "会话一",
    pageId: "p1",
    title: "示例页",
    url: "https://example.com/a",
    note: "看这里",
  };
  const w1 = await connect("/workspaces/w1/browser/events");
  const w2 = await connect("/workspaces/w2/browser/events");
  await waitFor(
    () => w1.messages.length >= 1 && w2.messages.length >= 1,
    "快照",
  );
  expect(showBus.publish("w1", show)).toBe(1);
  await waitFor(() => w1.messages.some((m) => m.type === "show"), "展示提示");
  expect(w1.messages.find((m) => m.type === "show")?.show).toEqual(show);
  // 别的工作区的连接收不到
  expect(w2.messages.some((m) => m.type === "show")).toBe(false);

  // 连接关闭后订阅被取消：再发布谁也收不到
  w1.ws.close();
  await waitFor(() => showBus.publish("w1", show) === 0, "已退订");
});

// —— 回放（只读） ——

describe("回放", () => {
  /** 直接经注册表开页面，再借真 Replay 记几步：截图走假页面。 */
  const recordSteps = async (wid: string, sessionId: string, n: number) => {
    const page = (
      await h.registry.open({
        workspaceKey: wid,
        actor: sessionId,
        url: "https://x.test/a",
      })
    ).page;
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      await replay.record({
        sessionId,
        workspaceKey: wid,
        pageId: page.id,
        tool: "browser_click",
        summary: `点击 e${i}`,
      });
      ids.push(replay.steps(wid, sessionId).at(-1)?.id as number);
    }
    return { page, ids };
  };

  test("会话列表：计数与时间段", async () => {
    const { ids } = await recordSteps("w1", "s1", 2);
    expect(ids).toHaveLength(2);
    const r = await call("GET", "/workspaces/w1/browser/replay");
    expect(r.status).toBe(200);
    const body = (await r.json()) as Json;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ sessionId: "s1", steps: 2 });
    expect(body.sessions[0].firstTs <= body.sessions[0].lastTs).toBe(true);
  });

  test("会话的步：按 id 升序，字段齐全", async () => {
    const { page, ids } = await recordSteps("w1", "s1", 2);
    const r = await call("GET", "/workspaces/w1/browser/replay/s1");
    expect(r.status).toBe(200);
    const body = (await r.json()) as Json;
    expect(body.steps.map((s: { id: number }) => s.id)).toEqual(ids);
    expect(body.steps[0]).toMatchObject({
      pageId: page.id,
      tool: "browser_click",
      summary: "点击 e1",
      url: "https://x.test/a",
      title: "",
    });
    expect(typeof body.steps[0].ts).toBe("string");
  });

  test("帧：image/jpeg 与缓存头，内容原样返回", async () => {
    const { ids } = await recordSteps("w1", "s1", 1);
    const r = await call(
      "GET",
      `/workspaces/w1/browser/replay/s1/frames/${ids[0]}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/jpeg");
    expect(r.headers.get("cache-control")).toBe("private, max-age=86400");
    // 假页面的画面就是 Buffer.from("jpeg")
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("jpeg");
  });

  test("别的工作区：三条路由都 404", async () => {
    const { ids } = await recordSteps("w1", "s1", 1);
    expect((await call("GET", "/workspaces/w2/browser/replay")).status).toBe(
      200,
    );
    expect(
      (
        (await (
          await call("GET", "/workspaces/w2/browser/replay")
        ).json()) as Json
      ).sessions,
    ).toEqual([]);
    expect((await call("GET", "/workspaces/w2/browser/replay/s1")).status).toBe(
      404,
    );
    expect(
      (await call("GET", `/workspaces/w2/browser/replay/s1/frames/${ids[0]}`))
        .status,
    ).toBe(404);
    // 工作区不存在更是 404
    expect((await call("GET", "/workspaces/nope/browser/replay")).status).toBe(
      404,
    );
    expect(
      (await call("GET", "/workspaces/nope/browser/replay/s1")).status,
    ).toBe(404);
    expect(
      (await call("GET", `/workspaces/nope/browser/replay/s1/frames/${ids[0]}`))
        .status,
    ).toBe(404);
  });

  test("没有步的会话 404", async () => {
    expect(
      (await call("GET", "/workspaces/w1/browser/replay/snope")).status,
    ).toBe(404);
  });

  test("stepId 不是正整数、查不到都 404", async () => {
    const { ids } = await recordSteps("w1", "s1", 1);
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const r = await call(
        "GET",
        `/workspaces/w1/browser/replay/s1/frames/${bad}`,
      );
      expect(r.status, bad).toBe(404);
    }
    expect(
      (
        await call(
          "GET",
          `/workspaces/w1/browser/replay/s1/frames/${(ids[0] as number) + 100}`,
        )
      ).status,
    ).toBe(404);
    // 会话对不上也 404
    expect(
      (await call("GET", `/workspaces/w1/browser/replay/s2/frames/${ids[0]}`))
        .status,
    ).toBe(404);
  });
});

// —— 用户页上挂起的下载 ——

const userPage = async (wid = "w1") => {
  const r = await call("POST", `/workspaces/${wid}/browser/pages`, {
    target: "https://x.test/",
  });
  return ((await r.json()) as Json).page as { id: string };
};

const downloadUrl = (pid: string, did = "d1", wid = "w1") =>
  `/workspaces/${wid}/browser/pages/${pid}/downloads/${did}`;

const dirOf = (patch: Partial<Directory> = {}): Directory => ({
  id: "dir1",
  name: "项目",
  path: makeTmpDir("yuanshu-api-browser-deliver-"),
  environmentId: "local",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

/** 暂存一个真文件：GET 要说得出字节、POST 要交得出文件。 */
const stageFile = (
  name = "报告.zip",
  bytes = Buffer.from([0, 255, 10, 13]),
) => {
  const dir = makeTmpDir("yuanshu-api-browser-stage-");
  const path = `${dir}/file`;
  writeFileSync(path, bytes);
  staged = { filename: name, path, size: bytes.length };
  return bytes;
};

const settles = () => calls.filter((c) => c.fn === "settle");
const stages = () => calls.filter((c) => c.fn === "stage");

test("保存到本机：流出正确字节、带编码的文件名，发完才 settle", async () => {
  const page = await userPage();
  const bytes = stageFile("报告 终版.zip");
  const r = await call("GET", downloadUrl(page.id));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-disposition")).toBe(
    `attachment; filename*=UTF-8''${encodeURIComponent("报告 终版.zip")}`,
  );
  expect(r.headers.get("content-type")).toBe("application/octet-stream");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("content-length")).toBe(String(bytes.length));
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...bytes]);
  // 字节全收完、连接关掉之后才结算
  await waitFor(() => settles().length === 1, "发完结算");
  expect(settles()[0]?.args).toEqual([page.id, "d1", "已保存到本机"]);
  expect(stages()[0]?.args).toEqual([page.id, "d1", 1000]);
});

// 客户端中途断开：响应没发完就不结算，暂存留着让用户再点（最终由超时清掉）。
test("保存到本机：客户端中途断开不结算", async () => {
  const page = await userPage();
  // 大文件：报告 4 MiB，浏览器那边读一点就断开
  stageFile("大文件.bin", Buffer.alloc(4 * 1024 * 1024, 7));
  const answer = await new Promise<string>((resolve, reject) => {
    const req = http.get(`${base}${downloadUrl(page.id)}`, (res) => {
      res.once("data", () => {
        req.destroy();
        resolve("closed");
      });
      res.once("end", () => resolve("ended"));
      res.once("error", reject);
    });
    req.once("error", (err) => {
      // 我们自己的 destroy 也会到这里，不算失败
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET")
        resolve("closed");
      else reject(err);
    });
  });
  expect(answer).toBe("closed");
  await new Promise((r) => setTimeout(r, 100));
  expect(settles()).toEqual([]);
});

test("保存到本机：暂存失败直接透传（404 / 502），不结算", async () => {
  const page = await userPage();
  stageError = new HttpError("download_failed", "文件太大", 502);
  const r = await call("GET", downloadUrl(page.id));
  expect(r.status).toBe(502);
  expect(await r.json()).toEqual({
    error: "download_failed",
    message: "文件太大",
  });
  expect(settles()).toEqual([]);

  stageError = new HttpError("not_found", "这个下载已经不在了", 404);
  const gone = await call("GET", downloadUrl(page.id, "d404"));
  expect(gone.status).toBe(404);
  expect(settles()).toEqual([]);
});

test("放进目录：写到目录根下，成功后结算并回名字与路径", async () => {
  const page = await userPage();
  directories = [dirOf()];
  stageFile("报告.zip");
  const r = await call("POST", `${downloadUrl(page.id)}/save`, {
    directoryId: "dir1",
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as Json;
  expect(body.name).toBe("报告.zip");
  expect(body.directory).toBe("项目");
  expect(body.path).toBe(`${directories[0]?.path}/报告.zip`);
  expect(readFileSync(body.path, "utf8").length).toBeGreaterThan(0);
  expect(settles()[0]?.args).toEqual([page.id, "d1", "已放进工作区目录"]);
});

test("放进目录：重名自动加 (1)", async () => {
  const page = await userPage();
  const dir = dirOf();
  directories = [dir];
  writeFileSync(`${dir.path}/报告.zip`, "old");
  stageFile("报告.zip");
  const body = (await (
    await call("POST", `${downloadUrl(page.id)}/save`, { directoryId: dir.id })
  ).json()) as Json;
  expect(body.name).toBe("报告 (1).zip");
  expect(readFileSync(`${dir.path}/报告.zip`, "utf8")).toBe("old");
});

test("放进目录：directoryId 缺失或不属于本工作区 → 400 bad_directory，不暂存不结算", async () => {
  const page = await userPage();
  directories = [dirOf()];
  stageFile();
  for (const body of [{}, { directoryId: "other" }, { directoryId: 42 }]) {
    const r = await call("POST", `${downloadUrl(page.id)}/save`, body);
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect(((await r.json()) as Json).error).toBe("bad_directory");
  }
  expect(calls).toEqual([]);
});

test("放进目录：环境不可用 502 env_unavailable，不暂存不结算", async () => {
  const page = await userPage();
  directories = [dirOf()];
  envFor = () => null;
  stageFile();
  const r = await call("POST", `${downloadUrl(page.id)}/save`, {
    directoryId: "dir1",
  });
  expect(r.status).toBe(502);
  expect(((await r.json()) as Json).error).toBe("env_unavailable");
  expect(calls).toEqual([]);
});

test("放进目录：写入失败 502 write_failed，不结算（暂存还在，用户可以改选）", async () => {
  const page = await userPage();
  directories = [dirOf()];
  stageFile();
  envFor = () =>
    ({
      kind: "local",
      lstat: async () => null,
      // 写流能开，一写就错：模拟写到一半失败（磁盘满、连接断）
      writeStream: async () =>
        new Writable({
          write(_chunk, _enc, cb) {
            cb(new Error("磁盘满了"));
          },
        }),
      remove: async () => {},
    }) as unknown as ExecEnv;
  const r = await call("POST", `${downloadUrl(page.id)}/save`, {
    directoryId: "dir1",
  });
  expect(r.status).toBe(502);
  expect(await r.json()).toEqual({
    error: "write_failed",
    message: "磁盘满了",
  });
  expect(settles()).toEqual([]);
});

test("丢弃：204 并结算；不存在 404", async () => {
  const page = await userPage();
  const r = await call("DELETE", downloadUrl(page.id));
  expect(r.status).toBe(204);
  expect(settles()[0]?.args).toEqual([page.id, "d1", "用户丢弃"]);

  settleResult = false;
  expect((await call("DELETE", downloadUrl(page.id, "d404"))).status).toBe(404);
});

test("三个路由：页面不属于该工作区都 404，且不调 pending", async () => {
  const page = await userPage();
  stageFile();
  directories = [dirOf()];
  const paths = [
    ["GET", downloadUrl(page.id, "d1", "w2")],
    ["POST", `${downloadUrl(page.id, "d1", "w2")}/save`],
    ["DELETE", downloadUrl(page.id, "d1", "w2")],
    ["GET", downloadUrl("pnope")],
  ] as const;
  for (const [method, path] of paths) {
    const r = await call(
      method,
      path,
      method === "POST" ? { directoryId: "dir1" } : undefined,
    );
    expect(r.status, `${method} ${path}`).toBe(404);
  }
  expect(calls).toEqual([]);
});

// —— 用户页上挂起的上传 ——

const uploadUrl = (pid: string, uid = "u1", wid = "w1") =>
  `/workspaces/${wid}/browser/pages/${pid}/uploads/${uid}`;

// 内容上限 + 1 MB 框架开销；再多 1 字节就一定越界。
const FORM_OVER = UPLOAD_MAX_TOTAL_BYTES + 1024 * 1024 + 1;

/** 造一份 multipart 请求体：拿它的 content-type 与字节去 inject。 */
const formBody = async (entries: Array<[string, File]>) => {
  const form = new FormData();
  for (const [field, file] of entries) form.append(field, file);
  const req = new Request("http://x", { method: "POST", body: form });
  return {
    contentType: req.headers.get("content-type") ?? "",
    body: Buffer.from(await req.arrayBuffer()),
  };
};

const upload = async (
  pid: string,
  body: { contentType: string; body: Buffer },
  uid = "u1",
  wid = "w1",
) =>
  app.inject({
    method: "POST",
    url: `/api/v1${uploadUrl(pid, uid, wid)}`,
    headers: { "content-type": body.contentType },
    payload: body.body,
  });

const fills = () => calls.filter((c) => c.fn === "fill");
const cancels = () => calls.filter((c) => c.fn === "cancel");

test("交文件：名字与字节交给 fill（含中文名、两个文件），回 204", async () => {
  const page = await userPage();
  const a = new File([Buffer.from("第一份内容")], "报告.txt");
  const b = new File([Buffer.from([0, 1, 255])], "b.bin");
  const body = await formBody([
    ["files", a],
    ["files", b],
  ]);
  const r = await upload(page.id, body);
  expect(r.statusCode).toBe(204);
  const got = fills()[0]?.args as [
    string,
    string,
    { name: string; buffer: Buffer }[],
    number,
  ];
  expect(got[0]).toBe(page.id);
  expect(got[1]).toBe("u1");
  expect(got[2].map((f) => f.name)).toEqual(["报告.txt", "b.bin"]);
  expect(got[2][0]?.buffer.equals(Buffer.from("第一份内容"))).toBe(true);
  expect([...(got[2][1]?.buffer ?? [])]).toEqual([0, 1, 255]);
  // 单文件上限每次请求现取
  expect(got[3]).toBe(1000);
});

test("不是 multipart：400 bad_form", async () => {
  const page = await userPage();
  const r = await app.inject({
    method: "POST",
    url: `/api/v1${uploadUrl(page.id)}`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ files: [] }),
  });
  expect(r.statusCode).toBe(400);
  expect(r.json()).toMatchObject({ error: "bad_form" });
  expect(fills()).toEqual([]);
});

test("没有 files 字段（或字段名不对）：解析成空清单交给 fill，它的 bad_files 原样透出", async () => {
  const page = await userPage();
  // 表单本身合法，只是没有 files：解析出来是空清单，交给 fill 由它报 400（真实现就是这么判的）。
  const empty = await upload(page.id, await formBody([]));
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toMatchObject({ error: "bad_files" });
  expect(fills()[0]?.args[2]).toEqual([]);

  // 字段名不对：同样没有 files
  const other = await formBody([
    ["file", new File([Buffer.from("x")], "x.txt")],
  ]);
  const wrong = await upload(page.id, other);
  expect(wrong.statusCode).toBe(400);
  expect(fills()[1]?.args[2]).toEqual([]);
});

test("请求体超过 50 MB + 1 MB 框架开销：413 too_large，不读进内存、不调 fill", async () => {
  const page = await userPage();
  const body = await formBody([
    ["files", new File([Buffer.alloc(FORM_OVER, 1)], "big.bin")],
  ]);
  expect(body.body.length).toBeGreaterThan(FORM_OVER);
  const r = await upload(page.id, body);
  expect(r.statusCode).toBe(413);
  expect(await r.json()).toEqual({
    error: "too_large",
    message: "文件合计超过 50 MB，浏览器一次接收不了",
  });
  expect(fills()).toEqual([]);
});

test("fill 抛的 HttpError 状态与消息原样透传", async () => {
  const page = await userPage();
  uploadError = new HttpError("too_many", "这个上传入口只接受一个文件", 400);
  const body = await formBody([
    ["files", new File([Buffer.from("x")], "a.txt")],
  ]);
  const r = await upload(page.id, body);
  expect(r.statusCode).toBe(400);
  expect(await r.json()).toEqual({
    error: "too_many",
    message: "这个上传入口只接受一个文件",
  });
});

test("取消：204；不存在 404", async () => {
  const page = await userPage();
  const r = await call("DELETE", uploadUrl(page.id));
  expect(r.status).toBe(204);
  expect(cancels()[0]?.args).toEqual([page.id, "u1"]);

  cancelResult = false;
  expect((await call("DELETE", uploadUrl(page.id, "u404"))).status).toBe(404);
});

test("两个路由：页面不属于该工作区都 404，且不调 pending", async () => {
  const page = await userPage();
  const body = await formBody([
    ["files", new File([Buffer.from("x")], "a.txt")],
  ]);
  expect((await upload(page.id, body, "u1", "w2")).statusCode).toBe(404);
  expect((await upload("pnope", body)).statusCode).toBe(404);
  expect((await call("DELETE", uploadUrl(page.id, "u1", "w2"))).status).toBe(
    404,
  );
  expect((await call("DELETE", uploadUrl("pnope"))).status).toBe(404);
  expect(calls).toEqual([]);
});

test("回答对话框：204；没有挂着的 409；参数错 400；别的工作区 / 不存在 404", async () => {
  const page = await agentPage();
  const url = `/workspaces/w1/browser/pages/${page.id}/dialog`;

  const none = await call("POST", url, { accept: true });
  expect(none.status).toBe(409);
  expect(((await none.json()) as Json).error).toBe("no_dialog");

  const fake = h.registry.peek(page.id) as unknown as ToolPage;
  fake.emitDialog({ type: "prompt", message: "名字？", defaultValue: "x" });

  expect((await call("POST", url, {})).status).toBe(400);
  expect((await call("POST", url, { accept: "yes" })).status).toBe(400);
  expect((await call("POST", url, { accept: true, text: 3 })).status).toBe(400);
  expect(
    (await call("POST", url, { accept: true, text: "x".repeat(10001) })).status,
  ).toBe(400);

  expect((await call("POST", url, { accept: true, text: "小红" })).status).toBe(
    204,
  );
  expect(fake.calls).toContain("answerDialog accept 小红");
  // 已经回答过：再答就是 409
  expect((await call("POST", url, { accept: false })).status).toBe(409);

  expect(
    (
      await call("POST", `/workspaces/w2/browser/pages/${page.id}/dialog`, {
        accept: true,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call("POST", "/workspaces/w1/browser/pages/pnope/dialog", {
        accept: true,
      })
    ).status,
  ).toBe(404);
});
