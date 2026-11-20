// 推送接口：只认设备令牌、订阅增删、偏好校验、测试推送走注入的假发送器。起真 Server 跑。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import type { PushPayload } from "../push/payload.js";
import type { PushSender, SendResult } from "../push/sender.js";
import { createServer, type YuanshuServer } from "../server.js";

const TOKEN = "k".repeat(40);
const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base: string;
let seq = 0;
const servers: YuanshuServer[] = [];
const clients: TestClient[] = [];
let sent: { endpoint: string; payload: PushPayload }[];
let reply: (endpoint: string) => SendResult;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-push-api-"));
  await mkdir(path.join(base, "web"), { recursive: true });
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
  sent = [];
  reply = () => ({ ok: true });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.stop().catch(() => {});
  await rm(base, { recursive: true, force: true });
});

const fakeSender: PushSender = async (target, payload) => {
  sent.push({ endpoint: target.endpoint, payload });
  return reply(target.endpoint);
};

async function launch() {
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, `data${seq++}`),
      token: TOKEN,
      allowCidrs: [],
    },
    {
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub),
      pushSender: fakeSender,
    },
  );
  const addr = await server.start();
  servers.push(server);
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
  };
}

type S = Awaited<ReturnType<typeof launch>>;

const bearer = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

const call = (
  s: S,
  method: string,
  p: string,
  token?: string,
  body?: unknown,
) =>
  fetch(s.http + p, {
    method,
    headers: {
      ...(token === undefined ? {} : bearer(token)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** 全局令牌开配对码、公开接口换设备令牌。 */
async function pairDevice(s: S, name = "手机") {
  const r = await call(s, "POST", "/api/v1/devices/pairing", TOKEN, {});
  const { code } = (await r.json()) as { code: string };
  const paired = await fetch(`${s.http}/api/v1/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  expect(paired.status).toBe(201);
  return (await paired.json()) as {
    token: string;
    device: { id: string; name: string };
  };
}

const SUB = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "p".repeat(20), auth: "a".repeat(16) },
};

const subscribe = (s: S, token: string, body: unknown = SUB) =>
  call(s, "PUT", "/api/v1/push/subscription", token, body);

const prefs = (s: S, token: string) =>
  call(s, "GET", "/api/v1/push", token).then((r) => r.json());

describe("只认设备令牌", () => {
  test("全局令牌调每个路由都是 403，无令牌 401", async () => {
    const s = await launch();
    const routes = [
      ["GET", "/api/v1/push"],
      ["PUT", "/api/v1/push/subscription"],
      ["DELETE", "/api/v1/push/subscription"],
      ["PATCH", "/api/v1/push/prefs"],
      ["POST", "/api/v1/push/test"],
    ] as const;
    for (const [method, p] of routes) {
      const g = await call(
        s,
        method,
        p,
        TOKEN,
        method === "GET" ? undefined : {},
      );
      expect(g.status, `${method} ${p} 全局令牌`).toBe(403);
      expect(await g.json()).toEqual({ error: "forbidden" });
      expect((await call(s, method, p)).status, `${method} ${p} 无令牌`).toBe(
        401,
      );
    }
  });
});

describe("订阅", () => {
  test("订阅后 GET 看到 subscribed 与默认偏好；重订阅保留偏好", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);

    const before = await call(s, "GET", "/api/v1/push", token);
    expect(before.status).toBe(200);
    const shown = (await before.json()) as { publicKey: string };
    expect(shown.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);

    expect((await subscribe(s, token)).status).toBe(204);
    expect(await prefs(s, token)).toEqual({
      publicKey: shown.publicKey,
      subscribed: true,
      prefs: {
        blocked: true,
        error: true,
        done: false,
        policy: "unwatched",
        delaySec: 30,
      },
    });

    expect(
      (
        await call(s, "PATCH", "/api/v1/push/prefs", token, {
          done: true,
          policy: "delay",
          delaySec: 60,
        })
      ).status,
    ).toBe(200);
    await subscribe(s, token, {
      endpoint: "https://push.example/other",
      keys: { p256dh: "q", auth: "b" },
    });
    const after = (await prefs(s, token)) as { prefs: { policy: string } };
    expect(after.prefs).toMatchObject({
      done: true,
      policy: "delay",
      delaySec: 60,
    });
  });

  test("DELETE 之后 subscribed 为 false、prefs 为 null；重复删也是 204", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    await subscribe(s, token);
    expect(
      (await call(s, "DELETE", "/api/v1/push/subscription", token)).status,
    ).toBe(204);
    expect(await prefs(s, token)).toMatchObject({
      subscribed: false,
      prefs: null,
    });
    expect(
      (await call(s, "DELETE", "/api/v1/push/subscription", token)).status,
    ).toBe(204);
  });

  test("endpoint / keys 各种非法输入都是 400", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    const cases: unknown[] = [
      {},
      { endpoint: "", keys: SUB.keys },
      { endpoint: 42, keys: SUB.keys },
      { endpoint: "not a url", keys: SUB.keys },
      { endpoint: "ftp://push.example/x", keys: SUB.keys },
      { endpoint: `https://push.example/${"x".repeat(2048)}`, keys: SUB.keys },
      { endpoint: SUB.endpoint },
      { endpoint: SUB.endpoint, keys: { p256dh: "", auth: "a" } },
      { endpoint: SUB.endpoint, keys: { p256dh: "p", auth: "" } },
      { endpoint: SUB.endpoint, keys: { p256dh: 1, auth: "a" } },
      { endpoint: SUB.endpoint, keys: { p256dh: "p", auth: "a".repeat(201) } },
      { endpoint: SUB.endpoint, keys: [] },
      "不是对象",
    ];
    for (const body of cases) {
      const r = await subscribe(s, token, body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect((await r.json()) as { error: string }).toMatchObject({
        error: "bad_request",
      });
    }
    // http 放行（本地假推送端点）
    expect(
      (await subscribe(s, token, { ...SUB, endpoint: "http://127.0.0.1:9/x" }))
        .status,
    ).toBe(204);
  });
});

describe("偏好", () => {
  test("没订阅时 PATCH 是 404，GET 的 prefs 是 null", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    expect(
      (await call(s, "PATCH", "/api/v1/push/prefs", token, { done: true }))
        .status,
    ).toBe(404);
    expect(await prefs(s, token)).toMatchObject({ subscribed: false });
  });

  test("部分更新返回完整偏好", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    await subscribe(s, token);
    const r = await call(s, "PATCH", "/api/v1/push/prefs", token, {
      blocked: false,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      blocked: false,
      error: true,
      done: false,
      policy: "unwatched",
      delaySec: 30,
    });
  });

  test("非法输入 400：类型不对、未知策略、延迟越界、空 body", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    await subscribe(s, token);
    const cases: unknown[] = [
      {},
      { blocked: "yes" },
      { done: 1 },
      { error: null },
      { policy: "sometimes" },
      { delaySec: 4 },
      { delaySec: 601 },
      { delaySec: 30.5 },
      { delaySec: "30" },
      { unknown: true },
    ];
    for (const body of cases) {
      const r = await call(s, "PATCH", "/api/v1/push/prefs", token, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // 边界值合法
    for (const delaySec of [5, 600])
      expect(
        (
          await call(s, "PATCH", "/api/v1/push/prefs", token, {
            delaySec,
            policy: "always",
          })
        ).status,
      ).toBe(200);
  });
});

describe("测试推送", () => {
  test("没订阅 404；有订阅走注入的发送器，204", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    expect((await call(s, "POST", "/api/v1/push/test", token)).status).toBe(
      404,
    );

    await subscribe(s, token);
    expect((await call(s, "POST", "/api/v1/push/test", token)).status).toBe(
      204,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.endpoint).toBe(SUB.endpoint);
    expect(sent[0]?.payload).toMatchObject({ kind: "test", tag: "test" });
  });

  test("发送失败 502 push_failed；gone 时订阅被清掉", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    await subscribe(s, token);

    reply = () => ({
      ok: false,
      gone: false,
      status: 500,
      error: "500 端点说不",
    });
    const failed = await call(s, "POST", "/api/v1/push/test", token);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: "push_failed",
      message: "500 端点说不",
    });
    expect(
      ((await prefs(s, token)) as { subscribed: boolean }).subscribed,
    ).toBe(true);

    reply = () => ({ ok: false, gone: true, status: 410, error: "410 gone" });
    expect((await call(s, "POST", "/api/v1/push/test", token)).status).toBe(
      502,
    );
    expect(
      ((await prefs(s, token)) as { subscribed: boolean }).subscribed,
    ).toBe(false);
  });
});

describe("撤销设备", () => {
  test("撤销设备后订阅跟着没了（外键级联）", async () => {
    const s = await launch();
    const { token, device } = await pairDevice(s);
    await subscribe(s, token);
    expect(
      ((await prefs(s, token)) as { subscribed: boolean }).subscribed,
    ).toBe(true);

    expect(
      (await call(s, "DELETE", `/api/v1/devices/${device.id}`, TOKEN)).status,
    ).toBe(204);
    // 设备没了，令牌也失效
    expect((await call(s, "GET", "/api/v1/push", token)).status).toBe(401);

    // 重新配对一台同名设备：拿不到旧订阅（它是按设备 id 绑的）
    const again = await pairDevice(s, "手机");
    expect(
      ((await prefs(s, again.token)) as { subscribed: boolean }).subscribed,
    ).toBe(false);
  });
});

describe("接线：一轮结束即推送", () => {
  test("设备订阅 done 后，一轮正常结束会收到推送（标题取会话标题）", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    await subscribe(s, token);
    expect(
      (
        await call(s, "PATCH", "/api/v1/push/prefs", token, {
          policy: "always",
          done: true,
        })
      ).status,
    ).toBe(200);

    const created = await call(s, "POST", "/api/v1/sessions", TOKEN);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const client = await TestClient.connect(
      `${s.ws}/api/v1/sessions/${id}/stream`,
      { token: TOKEN },
    );
    clients.push(client);
    await expect.poll(() => client.types()).toContain("snapshot");
    await client.command("send_message", { text: "跑一轮" });
    await expect
      .poll(() => client.types().filter((t) => t === "run.ended").length)
      .toBe(1);

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.payload).toMatchObject({
      kind: "done",
      sid: id,
      tag: `s:${id}`,
      v: 1,
    });
  });
});

describe("偏好只收认识的字段", () => {
  test("body 里混了别的键不报错，也不进库、不回显", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);
    await subscribe(s, token);
    const r = await call(s, "PATCH", "/api/v1/push/prefs", token, {
      done: true,
      sid: "x",
      endpoint: "https://evil.example",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      blocked: true,
      error: true,
      done: true,
      policy: "unwatched",
      delaySec: 30,
    });
  });
});
