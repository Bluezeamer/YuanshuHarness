// 设备接口：配码、换令牌、列出、撤销、whoami；以及撤销后的断连。起带令牌的真 Server 跑。
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-devices-api-"));
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
  };
}

type S = Awaited<ReturnType<typeof launch>>;

const bearer = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

const post = (s: S, p: string, body: unknown, token = TOKEN) =>
  fetch(s.http + p, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (s: S, p: string, token?: string) =>
  fetch(s.http + p, {
    method: "DELETE",
    headers: token === undefined ? {} : bearer(token),
  });

/** 全局令牌开配对码，再用公开接口换设备令牌。 */
async function pairDevice(s: S, name = "我的手机") {
  const r = await post(s, "/api/v1/devices/pairing", {}, TOKEN);
  const { code } = (await r.json()) as { code: string };
  const paired = await fetch(`${s.http}/api/v1/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  expect(paired.status).toBe(201);
  return (await paired.json()) as {
    token: string;
    device: {
      id: string;
      name: string;
      createdAt: string;
      lastUsedAt: string | null;
    };
  };
}

describe("配对与设备令牌", () => {
  test("全局令牌建码 → 公开接口换令牌 → 设备令牌能访问普通接口；同一个码不能用第二次", async () => {
    const s = await launch();
    const { code } = (await post(s, "/api/v1/devices/pairing", {}).then((r) =>
      r.json(),
    )) as { code: string };

    const first = await fetch(`${s.http}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "  我的手机  " }),
    });
    expect(first.status).toBe(201);
    const body = (await first.json()) as {
      token: string;
      device: { name: string; lastUsedAt: string | null };
    };
    expect(body.token).toMatch(/^[A-Za-z0-9._~-]{32,}$/);
    expect(body.device.name).toBe("我的手机");
    expect(body.device.lastUsedAt).toBeNull();

    expect(
      (
        await fetch(`${s.http}/api/v1/sessions`, {
          headers: bearer(body.token),
        })
      ).status,
    ).toBe(200);

    const again = await fetch(`${s.http}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "另一台" }),
    });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "invalid_code" });
  });

  test("设备名不合法是 400，且不消耗配对码", async () => {
    const s = await launch();
    const { code } = (await post(s, "/api/v1/devices/pairing", {}).then((r) =>
      r.json(),
    )) as { code: string };
    const pair = (name: unknown) =>
      fetch(`${s.http}/api/v1/devices/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name }),
      });

    for (const name of ["", "   ", "x".repeat(41), "换\n行"])
      expect((await pair(name)).status, JSON.stringify(name)).toBe(400);
    const ok = await pair("手机");
    expect(ok.status).toBe(201);
  });

  test("设备令牌管不了设备：pairing / 列表 / 撤销都是 403；无令牌是 401", async () => {
    const s = await launch();
    const { token, device } = await pairDevice(s);
    for (const [p, method] of [
      ["/api/v1/devices/pairing", "POST"],
      ["/api/v1/devices", "GET"],
      ["/api/v1/devices/other", "DELETE"],
      [`/api/v1/devices/${device.id}`, "DELETE"],
    ] as const) {
      const withDevice = await fetch(s.http + p, {
        method,
        headers: bearer(token),
      });
      expect(withDevice.status, `${method} ${p} 设备令牌`).toBe(403);
      expect(await withDevice.json(), `${method} ${p}`).toEqual({
        error: "forbidden",
      });
      expect(
        (await fetch(s.http + p, { method })).status,
        `${method} ${p} 无令牌`,
      ).toBe(401);
    }
    // 403 之后设备还在
    expect(
      (
        (await (
          await fetch(`${s.http}/api/v1/devices`, { headers: bearer() })
        ).json()) as {
          devices: unknown[];
        }
      ).devices,
    ).toHaveLength(1);
  });

  test("列表按创建时间：带 name / createdAt / lastUsedAt，绝不带令牌哈希", async () => {
    const s = await launch();
    const a = await pairDevice(s, "先");
    const b = await pairDevice(s, "后");
    const r = await fetch(`${s.http}/api/v1/devices`, { headers: bearer() });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({
      devices: [a.device, b.device],
    });
    expect(body).not.toContain(a.token);
    expect(body).not.toContain("token_hash");
    expect(body).not.toContain("tokenHash");
  });
});

describe("公开的 pair 与限流", () => {
  test("不带令牌也能到达；连续 10 次错误码后第 11 次 429", async () => {
    const clock = { t: 1_000_000 };
    const s = await launch({ clock });
    const bad = () =>
      fetch(`${s.http}/api/v1/devices/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ZZZZZZZZ", name: "手机" }),
      });
    for (let i = 0; i < 10; i++) expect((await bad()).status).toBe(401);
    const blocked = await bad();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });

  test("配对失败与令牌失败共用一个来源的失败计数", async () => {
    const clock = { t: 1_000_000 };
    const s = await launch({ clock });
    for (let i = 0; i < 6; i++)
      await fetch(`${s.http}/api/v1/devices/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ZZZZZZZZ", name: "手机" }),
      });
    for (let i = 0; i < 3; i++)
      expect(
        (await fetch(`${s.http}/api/v1/sessions`, { headers: bearer("bad") }))
          .status,
      ).toBe(401);
    // 第 10 次失败落在令牌上，随后封禁
    expect(
      (await fetch(`${s.http}/api/v1/sessions`, { headers: bearer("bad") }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${s.http}/api/v1/devices/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "ZZZZZZZZ", name: "手机" }),
        })
      ).status,
    ).toBe(429);
  });

  test("被来源网段拒绝时 pair 也是 403", async () => {
    const s = await launch({ allowCidrs: ["10.0.0.0/8"] });
    const r = await post(s, "/api/v1/devices/pair", {
      code: "ZZZZZZZZ",
      name: "手机",
    });
    expect(r.status).toBe(403);
  });
});

describe("撤销", () => {
  test("撤销后设备令牌立刻 401，已开的 WebSocket 被服务端断开、重连也 401", async () => {
    const s = await launch();
    const { token, device } = await pairDevice(s);

    expect(
      (await fetch(`${s.http}/api/v1/sessions`, { headers: bearer(token) }))
        .status,
    ).toBe(200);

    const session = (await (
      await fetch(`${s.http}/api/v1/sessions`, {
        method: "POST",
        headers: bearer(),
      })
    ).json()) as { id: string };
    const client = await TestClient.connect(
      `${s.ws}/api/v1/sessions/${session.id}/stream`,
      { token },
    );
    clients.push(client);
    await expect.poll(() => client.types()).toContain("snapshot");

    const revoked = await del(s, `/api/v1/devices/${device.id}`, TOKEN);
    expect(revoked.status).toBe(204);
    await expect.poll(() => client.closed).not.toBeNull();

    expect(
      (await fetch(`${s.http}/api/v1/sessions`, { headers: bearer(token) }))
        .status,
    ).toBe(401);
    await expect(
      TestClient.connect(`${s.ws}/api/v1/sessions/${session.id}/stream`, {
        token,
      }),
    ).rejects.toThrow("HTTP 401");

    // 已经没了
    expect((await del(s, `/api/v1/devices/${device.id}`, TOKEN)).status).toBe(
      404,
    );
  });

  test("whoami：全局与设备各自的身份", async () => {
    const s = await launch();
    const { token, device } = await pairDevice(s);

    const g = await fetch(`${s.http}/api/v1/auth/whoami`, {
      headers: bearer(),
    });
    expect(await g.json()).toEqual({ kind: "global" });

    const d = await fetch(`${s.http}/api/v1/auth/whoami`, {
      headers: bearer(token),
    });
    expect(await d.json()).toEqual({
      kind: "device",
      device: { ...device, lastUsedAt: expect.any(String) },
    });
  });

  test("设备删自己：204，之后 401；全局令牌调它是 403", async () => {
    const s = await launch();
    const { token } = await pairDevice(s);

    expect((await del(s, "/api/v1/devices/self", TOKEN)).status).toBe(403);
    expect((await del(s, "/api/v1/devices/self", token)).status).toBe(204);
    expect(
      (await fetch(`${s.http}/api/v1/sessions`, { headers: bearer(token) }))
        .status,
    ).toBe(401);
    expect(
      (
        (await (
          await fetch(`${s.http}/api/v1/devices`, { headers: bearer() })
        ).json()) as {
          devices: unknown[];
        }
      ).devices,
    ).toEqual([]);
  });
});

describe("回环模式（未配令牌）", () => {
  test("pairing 可用（身份视为全局），pair 照常工作", async () => {
    const s = await launch({ token: null });
    const created = await post(s, "/api/v1/devices/pairing", {});
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };

    const paired = await fetch(`${s.http}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "手机" }),
    });
    expect(paired.status).toBe(201);
    const { token } = (await paired.json()) as { token: string };
    // 没配令牌时整个认证都不生效，这里也一样（设备令牌不被区分，一律当全局）
    const who = await fetch(`${s.http}/api/v1/auth/whoami`, {
      headers: bearer(token),
    });
    expect(await who.json()).toEqual({ kind: "global" });
    expect(
      (
        await fetch(`${s.http}/api/v1/devices/self`, {
          method: "DELETE",
          headers: bearer(token),
        })
      ).status,
    ).toBe(403);
  });
});

describe("/m 静态回退", () => {
  const MOBILE = "<!doctype html><title>PLACEHOLDER-MOBILE</title>";

  beforeEach(async () => {
    await mkdir(path.join(base, "web", "m"), { recursive: true });
    await writeFile(path.join(base, "web", "m", "index.html"), MOBILE);
    await writeFile(
      path.join(base, "web", "m", "manifest.webmanifest"),
      '{"name":"x"}',
    );
    await writeFile(path.join(base, "secret.txt"), "TOP-SECRET");
  });

  test("/m 与深链接回 m/index.html，/m/ 下的静态文件照发", async () => {
    const s = await launch();
    for (const p of ["/m", "/m/", "/m/s/abc"]) {
      const r = await fetch(s.http + p);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toBe(MOBILE);
    }
    const manifest = await fetch(`${s.http}/m/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe('{"name":"x"}');
  });

  test("/settings 仍回根 index.html", async () => {
    const s = await launch();
    const r = await fetch(`${s.http}/settings/providers`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<title>x</title>");
  });

  test("m/index.html 不存在时 /m 是 404", async () => {
    await rm(path.join(base, "web", "m", "index.html"));
    const s = await launch();
    expect((await fetch(`${s.http}/m`)).status).toBe(404);
  });

  test("/m/../ 这类穿越读不到 web 目录之外的文件", async () => {
    const s = await launch();
    // 原样发路径：fetch 会先规范化，这里要看没被规范化的情形
    const raw = (rawPath: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: Number(new URL(s.http).port),
            path: rawPath,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (d) => {
              body += d;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });

    // `..` 在到达路由前就被规范化，最终落到的还是 m/ 里的文件（这里就是回退页）；
    // 要点只是别把 web 目录外的文件交出去。
    for (const p of [
      "/m/../secret.txt",
      "/m/%2e%2e/secret.txt",
      "/m/..%2fsecret.txt",
      "/m/..%2f..%2fsecret.txt",
      "/m/sub/../../secret.txt",
    ]) {
      const r = await raw(p);
      expect(r.body, p).not.toContain("TOP-SECRET");
      expect(r.body, p).toBe(MOBILE);
    }

    // 指向目录外的符号链接：allowedPath 拦下，读不到内容
    await symlink(
      path.join(base, "secret.txt"),
      path.join(base, "web", "m", "link.txt"),
    );
    const link = await raw("/m/link.txt");
    expect(link.body).not.toContain("TOP-SECRET");
    expect(link.status).toBe(404);
  });
});
