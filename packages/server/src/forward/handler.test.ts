// 转发出口的行为：授权、头改写、流式响应、502、WebSocket 升级，以及一条真 sshd 通道。
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { hasSshd, startSshd } from "../../test/support/sshd.js";
import { LocalEnv } from "../env/local.js";
import { SshEnv } from "../env/ssh.js";
import type { ExecEnv } from "../env/types.js";
import { SshConnection } from "../ssh/connection.js";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import {
  createForwardHandler,
  type ForwardHandler,
  type ForwardTarget,
} from "./handler.js";

const YS = "ys_session";

/** 监听 127.0.0.1 的临时端口，listen 后返回端口与关闭函数。 */
async function listen(
  server: http.Server | net.Server,
): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((ok) => {
        (server as http.Server).closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}

/** 一个空闲的端口（拿了就放）：用来造「端口没服务」。 */
async function freePort(): Promise<number> {
  const { port, close } = await listen(net.createServer());
  await close();
  return port;
}

function fakeEnv(openTcp: ((port: number) => Promise<net.Socket>) | undefined) {
  return openTcp === undefined
    ? ({ id: "e1", kind: "virtual" } as unknown as ExecEnv)
    : ({ id: "e1", kind: "local", openTcp } as unknown as ExecEnv);
}

interface Client {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** 起一个把 handler 接到真实监听上的出口，target 由调用方控制。 */
function startForward(opts: {
  env: (id: string) => ExecEnv | null;
  authorize?: (headers: http.IncomingHttpHeaders) => boolean;
  target: ForwardTarget;
}) {
  const handler: ForwardHandler = createForwardHandler({
    env: opts.env,
    authorize: opts.authorize ?? (() => true),
  });
  const server = http.createServer((req, res) =>
    handler.request(req, res, opts.target),
  );
  server.on("upgrade", (req, socket, head) =>
    handler.upgrade(req, socket, head, opts.target),
  );
  return { handler, server };
}

const request = (
  port: number,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  new Promise<Client>((ok, fail) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: opts.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () =>
          ok({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", fail);
    req.end();
  });

let backend: http.Server;
let backendPort: number;
let backendHits = 0;

beforeAll(async () => {
  backend = http.createServer((req, res) => {
    backendHits += 1;
    const url = req.url ?? "/";
    if (url === "/redirect") {
      res.writeHead(302, {
        location: `http://localhost:${backendPort}/target`,
        "set-cookie": ["s=1; Domain=localhost; Path=/"],
      });
      res.end();
      return;
    }
    if (url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write("first\n");
      // 第一块先到，后面的过一会再写：验证响应是流过去而不是攒完再发
      setTimeout(() => res.end("second\n"), 60);
      return;
    }
    if (url === "/sse") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 60);
      return;
    }
    if (url === "/echo-body") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => res.end(`body:${body}`));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        url,
        host: req.headers.host,
        origin: req.headers.origin ?? null,
        referer: req.headers.referer ?? null,
        cookie: req.headers.cookie ?? null,
        upgrade: req.headers.upgrade ?? null,
      }),
    );
  });
  await new Promise<void>((ok) => backend.listen(0, "127.0.0.1", ok));
  backendPort = (backend.address() as net.AddressInfo).port;
});

afterAll(() => {
  backend.closeAllConnections();
  backend.close();
});

beforeEach(() => {
  backendHits = 0;
});

const target = (): ForwardTarget => ({ envId: "e1", port: backendPort });
const localTcp = (port: number) => new LocalEnv().openTcp(port);

async function withForward(
  opts: Parameters<typeof startForward>[0],
  run: (port: number) => Promise<void>,
) {
  const { server } = startForward(opts);
  const { port, close } = await listen(server);
  try {
    await run(port);
  } finally {
    await close();
  }
}

describe("普通 HTTP", () => {
  test("未授权：401 中文说明页，上游一个请求都没收到", async () => {
    await withForward(
      {
        env: () => fakeEnv(localTcp),
        authorize: () => false,
        target: target(),
      },
      async (port) => {
        const r = await request(port);
        expect(r.status).toBe(401);
        expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(r.body).toContain("请先在 Server 的页面里登录，再刷新这里");
        // 不泄露环境、端口、令牌之类的东西
        expect(r.body).not.toContain("e1");
        expect(r.body).not.toContain(String(backendPort));
        expect(backendHits).toBe(0);
      },
    );
  });

  test("授权后：Host / Origin / Referer / Cookie 都按上游视角改写", async () => {
    await withForward(
      { env: () => fakeEnv(localTcp), target: target() },
      async (port) => {
        const r = await request(port, {
          path: "/echo",
          headers: {
            host: "ys.test:7500",
            origin: "http://ys.test:7500",
            referer: "http://ys.test:7500/a?b=1",
            cookie: `keep=1; ${YS}=${"t".repeat(32)}; other=2`,
          },
        });
        expect(r.status).toBe(200);
        const seen = JSON.parse(r.body) as Record<string, string | null>;
        expect(seen.host).toBe(`localhost:${backendPort}`);
        expect(seen.origin).toBe(`http://localhost:${backendPort}`);
        expect(seen.referer).toBe(`http://localhost:${backendPort}/a?b=1`);
        expect(seen.cookie).toBe("keep=1; other=2");
      },
    );
  });

  test("上游的 Location 与 Set-Cookie 改回转发出口", async () => {
    await withForward(
      { env: () => fakeEnv(localTcp), target: target() },
      async (port) => {
        const r = await request(port, {
          path: "/redirect",
          headers: { host: "ys.test:7500" },
        });
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe("http://ys.test:7500/target");
        expect(r.headers["set-cookie"]).toEqual(["s=1; Path=/"]);
      },
    );
  });

  test("分块响应流式到达：先收到第一块，再收到后面的", async () => {
    await withForward(
      { env: () => fakeEnv(localTcp), target: target() },
      async (port) => {
        const first = await new Promise<string>((ok, fail) => {
          const req = http.get(
            { host: "127.0.0.1", port, path: "/stream" },
            (res) => {
              res.setEncoding("utf8");
              res.once("data", (c: string) => ok(c));
            },
          );
          req.on("error", fail);
        });
        expect(first).toBe("first\n");
        // 第一块到达时上游还没写第二块——上面拿到 first 就说明没有攒完再发
        expect(backendHits).toBe(1);
      },
    );
  });

  test("SSE：事件流原样透传", async () => {
    await withForward(
      { env: () => fakeEnv(localTcp), target: target() },
      async (port) => {
        const chunks: string[] = [];
        await new Promise<void>((ok, fail) => {
          const req = http.get(
            { host: "127.0.0.1", port, path: "/sse" },
            (res) => {
              expect(res.headers["content-type"]).toBe("text/event-stream");
              res.setEncoding("utf8");
              res.on("data", (c: string) => chunks.push(c));
              res.on("end", () => ok());
            },
          );
          req.on("error", fail);
        });
        expect(chunks.join("")).toBe("data: one\n\ndata: two\n\n");
      },
    );
  });

  test("POST 带体：请求体完整到上游", async () => {
    await withForward(
      { env: () => fakeEnv(localTcp), target: target() },
      async (port) => {
        const r = await new Promise<Client>((ok, fail) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/echo-body",
              headers: { "content-type": "text/plain" },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (c) => {
                body += c;
              });
              res.on("end", () =>
                ok({ status: res.statusCode ?? 0, headers: res.headers, body }),
              );
            },
          );
          req.on("error", fail);
          req.end("你好，world");
        });
        expect(r.body).toBe("body:你好，world");
      },
    );
  });

  test("环境不存在 / 没有 openTcp：502 中文说明", async () => {
    await withForward({ env: () => null, target: target() }, async (port) => {
      const r = await request(port);
      expect(r.status).toBe(502);
      expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(r.body).toBe("这个环境现在连不上，或不支持转发");
    });
    await withForward(
      { env: () => fakeEnv(undefined), target: target() },
      async (port) => {
        const r = await request(port);
        expect(r.status).toBe(502);
        expect(r.body).toBe("这个环境现在连不上，或不支持转发");
      },
    );
  });

  test("端口上没有服务：502，正文写明连接失败的原因", async () => {
    const closed = await freePort();
    await withForward(
      { env: () => fakeEnv(localTcp), target: { envId: "e1", port: closed } },
      async (port) => {
        const r = await request(port);
        expect(r.status).toBe(502);
        expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
        expect(r.body).toBe("连接上游失败：ECONNREFUSED");
      },
    );
  });
});

describe("WebSocket", () => {
  let wss: WebSocketServer;
  let wsBackend: Awaited<ReturnType<typeof listen>>;
  let upgrades: http.IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    const server = http.createServer();
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws, req) => {
      upgrades.push(req.headers);
      ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
    });
    wsBackend = await listen(server);
  });

  afterAll(async () => {
    wss.close();
    await wsBackend.close();
  });

  beforeEach(() => {
    upgrades = [];
  });

  test("经转发建立连接、收发文本、关闭；上游看不到会话 Cookie", async () => {
    await withForward(
      {
        env: () => fakeEnv(localTcp),
        target: { envId: "e1", port: wsBackend.port },
      },
      async (port) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, {
          headers: { cookie: `keep=1; ${YS}=${"t".repeat(32)}` },
        });
        await once(ws, "open");
        ws.send("hello");
        const [data] = (await once(ws, "message")) as [Buffer];
        expect(data.toString()).toBe("echo:hello");
        ws.close();
        const [code] = (await once(ws, "close")) as [number];
        expect(code).toBe(1005);
        // 升级请求真的被改写后写给上游了：Host 是上游自己，令牌没漏过去
        const seen = upgrades[0] as http.IncomingHttpHeaders;
        expect(seen.host).toBe(`localhost:${wsBackend.port}`);
        expect(seen.connection).toBe("Upgrade");
        expect(seen.upgrade).toBe("websocket");
        expect(seen.cookie).toBe("keep=1");
      },
    );
  });

  test("未授权的升级：401，上游没有连接进来", async () => {
    await withForward(
      {
        env: () => fakeEnv(localTcp),
        authorize: () => false,
        target: { envId: "e1", port: wsBackend.port },
      },
      async (port) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`);
        const [err] = (await once(ws, "error")) as [Error];
        expect(err.message).toContain("401");
        expect(upgrades).toEqual([]);
      },
    );
  });

  test("升级时客户端已读到的字节（head）也写给上游", async () => {
    // 客户端把握手与一条消息写在同一个包里：服务端 upgrade 事件拿到的 head 里就有消息体
    const targetPort = wsBackend.port;
    const { server } = startForward({
      env: () => fakeEnv(localTcp),
      target: { envId: "e1", port: targetPort },
    });
    const { port, close } = await listen(server);
    try {
      const socket = net.connect({ host: "127.0.0.1", port });
      await once(socket, "connect");
      const payload = Buffer.from("early", "utf8");
      // 客户端帧必须带掩码
      const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
      const masked = Buffer.from(
        payload.map((b, i) => b ^ (mask[i % 4] as number)),
      );
      socket.write(
        Buffer.concat([
          Buffer.from(
            [
              "GET /socket HTTP/1.1",
              `Host: 127.0.0.1:${port}`,
              "Upgrade: websocket",
              // 真实浏览器给的是一条列表；转发后上游应该只看到 Upgrade
              "Connection: keep-alive, Upgrade",
              `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}`,
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n"),
          ),
          Buffer.from([0x81, 0x80 | payload.length]),
          mask,
          masked,
        ]),
      );
      let back = Buffer.alloc(0);
      const echo = await new Promise<string>((ok) => {
        socket.on("data", (c) => {
          back = Buffer.concat([back, c]);
          // 先跳过服务端的 101 响应头，再看后面的数据帧
          const at = back.indexOf("\r\n\r\n");
          if (at < 0) return;
          const payload = back.subarray(at + 4);
          if (payload.length < 2) return;
          ok(payload.subarray(2, 2 + (payload[1] as number)).toString("utf8"));
        });
      });
      // 消息与握手同一个包到，但上游照样收到并被回应
      expect(echo).toBe("echo:early");
      socket.destroy();
      const seen = upgrades.at(-1) as http.IncomingHttpHeaders;
      expect(seen.upgrade).toBe("websocket");
      expect(seen.connection).toBe("Upgrade");
    } finally {
      await close();
    }
  });

  test("上游连不上：502 后关掉连接", async () => {
    const closed = await freePort();
    await withForward(
      { env: () => fakeEnv(localTcp), target: { envId: "e1", port: closed } },
      async (port) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`);
        const [err] = (await once(ws, "error")) as [Error];
        expect(err.message).toContain("502");
      },
    );
  });
});

// 真 sshd + 真 SshEnv：转发经 direct-tcpip 通道到「远端」回环上的服务。
describe.skipIf(!hasSshd)("经真实 ssh 通道转发", () => {
  let dir: string;
  let db: Db;
  let sshd: Awaited<ReturnType<typeof startSshd>>;
  let env: SshEnv;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-forward-ssh-"));
    db = openDatabase(dir);
    sshd = await startSshd();
    const secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    env = new SshEnv(
      "ssh1",
      "posix",
      new SshConnection(
        {
          host: "127.0.0.1",
          port: sshd.port,
          username: sshd.user,
          secretId: key?.id ?? null,
        },
        secrets,
      ),
    );
    await env.connect();
  });

  afterAll(async () => {
    await env.close?.();
    await sshd.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("HTTP 经 ssh 通道到远端回环上的服务", async () => {
    await withForward(
      {
        env: (id) => (id === "ssh1" ? (env as ExecEnv) : null),
        target: { envId: "ssh1", port: backendPort },
      },
      async (port) => {
        const r = await request(port, {
          path: "/hello",
          headers: { host: "ys.test:7500" },
        });
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body) as Record<string, string>).toMatchObject({
          method: "GET",
          url: "/hello",
          host: `localhost:${backendPort}`,
        });
      },
    );
  });
});
