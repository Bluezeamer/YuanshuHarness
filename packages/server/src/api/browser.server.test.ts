// 浏览器接口接进真实 Server 之后的几条：路由挂上了、工作区校验用的是真库、引擎起不来时给出可读的失败。
// 不装也不起真浏览器：关掉自动下载，引擎只会报「没装好」。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { BrowserPageStore } from "../store/browser-pages.js";
import { openDatabase } from "../store/db.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

const TOKEN = "t".repeat(40);
const AUTO_INSTALL = "YUANSHU_BROWSER_AUTO_INSTALL";
const BROWSER = "YUANSHU_BROWSER";
let base: string;
let saved: [string | undefined, string | undefined];
const servers: YuanshuServer[] = [];

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-browser-api-"));
  mkdirSync(path.join(base, "web"));
  writeFileSync(path.join(base, "web", "index.html"), "<!doctype html>");
  saved = [process.env[AUTO_INSTALL], process.env[BROWSER]];
  process.env[AUTO_INSTALL] = "0";
  delete process.env[BROWSER];
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  rmSync(base, { recursive: true, force: true });
  for (const [i, key] of [AUTO_INSTALL, BROWSER].entries()) {
    const v = saved[i];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

async function launch() {
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, "data"),
      token: TOKEN,
      allowCidrs: [],
    },
    {
      startDir: path.join(base, "start"),
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub),
    },
  );
  mkdirSync(path.join(base, "start"), { recursive: true });
  const addr = await server.start();
  servers.push(server);
  const call = (method: string, p: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${addr.port}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, port: addr.port };
}

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

async function workspace(call: Awaited<ReturnType<typeof launch>>["call"]) {
  const dir = path.join(base, "proj");
  mkdirSync(dir, { recursive: true });
  const r = await call("POST", "/api/v1/workspaces", {
    directories: [{ path: dir }],
  });
  return (await json<{ id: string }>(r)).id;
}

test("没有 token 的请求被认证拦下；不存在的工作区 404，存在的给总览", async () => {
  const { call, port } = await launch();
  const anonymous = await fetch(
    `http://127.0.0.1:${port}/api/v1/workspaces/x/browser`,
  );
  expect(anonymous.status).toBe(401);

  expect((await call("GET", "/api/v1/workspaces/nope/browser")).status).toBe(
    404,
  );
  const id = await workspace(call);
  const r = await call("GET", `/api/v1/workspaces/${id}/browser`);
  expect(r.status).toBe(200);
  const body = await json<{ engine: { status: string }; pages: unknown[] }>(r);
  expect(body.engine.status).toBe("idle");
  expect(body.pages).toEqual([]);
});

test("没装浏览器：开页面 502 并给出可读的原因，引擎状态变 failed 且事件流收得到", async () => {
  const { call, port } = await launch();
  const id = await workspace(call);
  const events = await TestClient.connect(
    `ws://127.0.0.1:${port}/api/v1/workspaces/${id}/browser/events`,
    { token: TOKEN },
  );
  await waitFor(() => events.frames.length >= 1, "快照");
  expect(events.frames[0]?.type).toBe("snapshot");

  const r = await call("POST", `/api/v1/workspaces/${id}/browser/pages`, {
    target: "https://example.com/",
  });
  expect(r.status).toBe(502);
  expect((await json<{ error: string }>(r)).error).toBe("context_failed");

  await waitFor(
    () => events.frames.some((f) => f.type === "engine"),
    "引擎状态事件",
  );
  const state = await json<{
    engine: { status: string; problem: { code: string } };
  }>(await call("GET", `/api/v1/workspaces/${id}/browser`));
  expect(state.engine.status).toBe("failed");
  expect(state.engine.problem.code).toBe("not_installed");
  events.close();
});

test("删除工作区：浏览器的清理接在里面，不影响删除", async () => {
  const { call } = await launch();
  const id = await workspace(call);
  expect((await call("DELETE", `/api/v1/workspaces/${id}`)).status).toBe(204);
  expect((await call("GET", `/api/v1/workspaces/${id}/browser`)).status).toBe(
    404,
  );
});

test("重启后库里的页面以休眠态回到总览；删工作区时它们被清掉", async () => {
  const first = await launch();
  const id = await workspace(first.call);
  await servers.pop()?.stop();

  // 模拟上一进程留下的页面记录
  const dataDir = path.join(base, "data");
  const db = openDatabase(dataDir);
  const at = new Date().toISOString();
  new BrowserPageStore(db).insert(
    {
      id: "pabcde",
      workspaceKey: id,
      url: "https://example.com/",
      title: "示例",
      userOpened: true,
      controller: "user",
      state: "active",
      epoch: 0,
      createdAt: at,
      lastUsedAt: at,
    },
    [],
  );
  db.close();

  const second = await launch();
  const view = await json<{ pages: { id: string; state: string }[] }>(
    await second.call("GET", `/api/v1/workspaces/${id}/browser`),
  );
  expect(view.pages).toMatchObject([{ id: "pabcde", state: "sleeping" }]);

  expect((await second.call("DELETE", `/api/v1/workspaces/${id}`)).status).toBe(
    204,
  );
  await servers.pop()?.stop();
  const check = openDatabase(dataDir);
  expect(new BrowserPageStore(check).list()).toEqual([]);
  check.close();
});
