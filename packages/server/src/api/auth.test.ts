import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
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
import { createServer, type YuanshuServer } from "../server.js";

const TOKEN = "k".repeat(40);
const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base: string;
let seq = 0;
const servers: YuanshuServer[] = [];
const clients: TestClient[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-auth-"));
  await mkdir(path.join(base, "web"), { recursive: true });
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.stop().catch(() => {});
  await rm(base, { recursive: true, force: true });
});

async function launch(
  over: {
    token?: string | null;
    allowCidrs?: string[];
    trustedOrigins?: string[];
    clock?: { t: number };
  } = {},
) {
  const token = over.token === null ? undefined : (over.token ?? TOKEN);
  const clock = over.clock;
  const server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(base, `data${seq++}`),
      ...(token === undefined ? {} : { token }),
      allowCidrs: over.allowCidrs ?? [],
      ...(over.trustedOrigins ? { trustedOrigins: over.trustedOrigins } : {}),
    },
    {
      webRoot: path.join(base, "web"),
      sessionFactory: stubSessionFactory(stub),
      ...(clock ? { authLimiter: { now: () => clock.t } } : {}),
    },
  );
  const addr = await server.start();
  servers.push(server);
  return {
    http: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}`,
    port: addr.port,
  };
}

function rawUpgrade(port: number, id: string, protocols: string) {
  return new Promise<{ status: number; protocol: string | undefined }>(
    (resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: `/api/v1/sessions/${id}/stream`,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": protocols,
        },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve({
          status: 101,
          protocol: res.headers["sec-websocket-protocol"] as string | undefined,
        });
      });
      req.on("response", (res) =>
        resolve({ status: res.statusCode ?? 0, protocol: undefined }),
      );
      req.on("error", reject);
      req.end();
    },
  );
}

async function createSession(url: string): Promise<string> {
  const r = await fetch(`${url}/api/v1/sessions`, {
    method: "POST",
    ...bearer(),
  });
  return ((await r.json()) as { id: string }).id;
}

const bearer = (t = TOKEN) => ({ headers: { authorization: `Bearer ${t}` } });

// 路由表：与 sessions.ts 里注册的路由一一对应，下面的覆盖用例会核对数量。
const ROUTES: [string, string][] = [
  ["POST", "/api/v1/sessions"],
  ["GET", "/api/v1/sessions"],
  ["GET", "/api/v1/sessions/x"],
  ["PATCH", "/api/v1/sessions/x"],
  ["DELETE", "/api/v1/sessions/x"],
  ["GET", "/api/v1/sessions/x/messages"],
  ["GET", "/api/v1/sessions/x/messages/0"],
  ["GET", "/api/v1/sessions/x/state"],
  ["GET", "/api/v1/sessions/x/context"],
  ["POST", "/api/v1/sessions/x/reload"],
];

describe("路由覆盖（R4）", () => {
  test("路由表与 sessions.ts 注册的 /api/v1 路由数量一致", async () => {
    const src = await readFile(
      new URL("./sessions.ts", import.meta.url),
      "utf8",
    );
    const count = (
      src.match(/app\.(get|post|patch|delete)(<[^(]*>)?\(\s*"\/api\/v1/g) ?? []
    ).length;
    expect(count).toBe(ROUTES.length + 1); // + stream
  });

  test.each(ROUTES)(
    "配令牌后 %s %s 无令牌得 401，带令牌放行",
    async (method, p) => {
      const s = await launch();
      const no = await fetch(s.http + p, { method });
      expect(no.status).toBe(401);
      expect(no.headers.get("www-authenticate")).toBe("Bearer");
      const ok = await fetch(s.http + p, { method, ...bearer() });
      expect(ok.status).not.toBe(401);
    },
  );

  test("stream 升级无令牌得 401，不建立 WebSocket", async () => {
    const s = await launch();
    await expect(
      TestClient.connect(`${s.ws}/api/v1/sessions/x/stream`),
    ).rejects.toThrow("HTTP 401");
  });

  test("/healthz 与静态资源免认证", async () => {
    const s = await launch();
    expect((await fetch(`${s.http}/healthz`)).status).toBe(200);
    expect((await fetch(`${s.http}/`)).status).toBe(200);
  });

  test("未配令牌（回环）时不检查令牌", async () => {
    const s = await launch({ token: null });
    expect((await fetch(`${s.http}/api/v1/sessions`)).status).toBe(200);
  });
});

describe("令牌（R8、R10）", () => {
  test("缺失、错误、空 Bearer 得到相同的 401 体", async () => {
    const s = await launch();
    const bodies = await Promise.all(
      [{}, bearer("wrong").headers, { authorization: "Bearer " }].map(
        async (h) => {
          const r = await fetch(`${s.http}/api/v1/sessions`, { headers: h });
          expect(r.status).toBe(401);
          return r.text();
        },
      ),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe('{"error":"unauthorized"}');
  });

  test("WebSocket 子协议携带令牌可连接，且响应头只含 yuanshu.v1（原始读取）", async () => {
    const s = await launch();
    const id = await createSession(s.http);
    const r = await rawUpgrade(s.port, id, `bearer.${TOKEN}, yuanshu.v1`);
    expect(r).toEqual({ status: 101, protocol: "yuanshu.v1" });
  });

  test("只给 bearer 项时升级成功，响应不带子协议头，不回显 bearer", async () => {
    const s = await launch();
    const id = await createSession(s.http);
    const r = await rawUpgrade(s.port, id, `bearer.${TOKEN}`);
    expect(r).toEqual({ status: 101, protocol: undefined });
  });

  test("TestClient 带令牌连接并收到快照（R13）", async () => {
    const s = await launch();
    const id = (
      (await (
        await fetch(`${s.http}/api/v1/sessions`, {
          method: "POST",
          ...bearer(),
        })
      ).json()) as { id: string }
    ).id;
    const c = await TestClient.connect(`${s.ws}/api/v1/sessions/${id}/stream`, {
      token: TOKEN,
    });
    clients.push(c);
    await expect.poll(() => c.types()).toContain("snapshot");
  });
});

describe("网段（R5、R7）", () => {
  test("网段外 + 错令牌得 403 而非 401（不计入失败见 auth.test.ts）", async () => {
    const s = await launch({ allowCidrs: ["10.0.0.0/8"] });
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${s.http}/api/v1/sessions`, bearer("wrong"));
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "forbidden_source" });
    }
  });

  test("网段内放行；回环 + 仅网段 + 无令牌时网段仍生效", async () => {
    const inside = await launch({ token: null, allowCidrs: ["127.0.0.0/8"] });
    expect((await fetch(`${inside.http}/api/v1/sessions`)).status).toBe(200);
    const outside = await launch({ token: null, allowCidrs: ["10.0.0.0/8"] });
    expect((await fetch(`${outside.http}/api/v1/sessions`)).status).toBe(403);
  });

  test("伪造 X-Forwarded-For 不影响判定", async () => {
    const s = await launch({ allowCidrs: ["10.0.0.0/8"] });
    const r = await fetch(`${s.http}/api/v1/sessions`, {
      headers: {
        "x-forwarded-for": "10.1.1.1",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(r.status).toBe(403);
    const t = await launch({ allowCidrs: ["127.0.0.0/8"] });
    const r2 = await fetch(`${t.http}/api/v1/sessions`, {
      headers: {
        "x-forwarded-for": "8.8.8.8",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(r2.status).toBe(200);
  });
});

describe("限流（R11）", () => {
  test("9 次失败仍 401，第 10 次起 429；封禁期内正确令牌也 429，不延长；到期恢复", async () => {
    const clock = { t: 1_000_000 };
    const s = await launch({ clock });
    const hit = (t: string) => fetch(`${s.http}/api/v1/sessions`, bearer(t));
    for (let i = 0; i < 9; i++) expect((await hit("bad")).status).toBe(401);
    expect((await hit("bad")).status).toBe(401); // 第 10 次失败本身仍是 401，随后封禁
    const blocked = await hit(TOKEN);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toEqual({ error: "too_many_attempts" });
    clock.t += 30_000;
    const again = await hit(TOKEN);
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("30");
    clock.t += 30_000;
    expect((await hit(TOKEN)).status).toBe(200);
  });

  test("成功认证清零连续失败计数", async () => {
    const clock = { t: 1_000_000 };
    const s = await launch({ clock });
    const hit = (t: string) => fetch(`${s.http}/api/v1/sessions`, bearer(t));
    for (let i = 0; i < 9; i++) await hit("bad");
    expect((await hit(TOKEN)).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await hit("bad")).status).toBe(401);
  });

  test("封禁对 WebSocket 升级同样生效", async () => {
    const clock = { t: 1_000_000 };
    const s = await launch({ clock });
    for (let i = 0; i < 10; i++)
      await fetch(`${s.http}/api/v1/sessions`, bearer("bad"));
    await expect(
      TestClient.connect(`${s.ws}/api/v1/sessions/x/stream`, { token: TOKEN }),
    ).rejects.toThrow("HTTP 429");
  });
});

describe("来源校验（Origin）", () => {
  const COOKIE = `ys_session=${TOKEN}`;
  /** 用 http.request 发：fetch 不让随便设 Origin / Host / X-Forwarded-Host。 */
  const get = (port: number, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/v1/sessions", headers },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  test("同主机别的端口上的页面带着会话 Cookie 打过来：403，不看令牌", async () => {
    const s = await launch();
    const r = await get(s.port, {
      cookie: COOKIE,
      origin: "http://127.0.0.1:7500",
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe("forbidden_origin");
    expect(JSON.parse(r.body).message).toContain("http://127.0.0.1:7500");
  });

  test("Origin 与 Host 一致放行；没有 Origin（命令行、同源 GET）放行", async () => {
    const s = await launch();
    expect(
      (
        await get(s.port, {
          cookie: COOKIE,
          origin: `http://127.0.0.1:${s.port}`,
        })
      ).status,
    ).toBe(200);
    expect((await get(s.port, { cookie: COOKIE })).status).toBe(200);
  });

  test("Origin: null（沙箱 iframe、file:）与解析不了的 Origin 都拒绝", async () => {
    const s = await launch();
    for (const origin of ["null", "not a url"])
      expect(
        (await get(s.port, { cookie: COOKIE, origin })).status,
        origin,
      ).toBe(403);
  });

  test("反代改写了 Host：看 X-Forwarded-Host，对得上就放行", async () => {
    const s = await launch();
    const behind = {
      cookie: COOKIE,
      origin: "https://ys.example.com",
      "x-forwarded-host": "ys.example.com",
    };
    expect((await get(s.port, behind)).status).toBe(200);
    expect(
      (await get(s.port, { ...behind, "x-forwarded-host": "other.example" }))
        .status,
    ).toBe(403);
  });

  test("受信来源清单里的 Origin 放行，清单外的仍拒绝", async () => {
    const s = await launch({ trustedOrigins: ["https://ys.example.com"] });
    const hit = (origin: string) => get(s.port, { cookie: COOKIE, origin });
    expect((await hit("https://ys.example.com")).status).toBe(200);
    expect((await hit("https://evil.example.com")).status).toBe(403);
  });

  test("WebSocket 升级同样查：Cookie 加不符的 Origin 得 403，符合的建立连接", async () => {
    const s = await launch();
    await expect(
      TestClient.connect(`${s.ws}/api/v1/sessions/x/stream`, {
        headers: { cookie: COOKIE },
        origin: "http://127.0.0.1:7500",
      }),
    ).rejects.toThrow("HTTP 403");
    const id = await createSession(s.http);
    const ok = await TestClient.connect(
      `${s.ws}/api/v1/sessions/${id}/stream`,
      {
        headers: { cookie: COOKIE },
        origin: `http://127.0.0.1:${s.port}`,
      },
    );
    clients.push(ok);
  });

  test("拒绝来源不算令牌失败：不触发限流", async () => {
    const s = await launch();
    for (let i = 0; i < 12; i++)
      await get(s.port, { cookie: COOKIE, origin: "http://evil.example" });
    expect(
      (await get(s.port, { authorization: `Bearer ${TOKEN}` })).status,
    ).toBe(200);
  });
});
