import { once } from "node:events";
import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { LocalEnv } from "../../env/local.js";
import type { ExecEnv } from "../../env/types.js";
import { serviceHost } from "./hostnames.js";
import {
  type DenyCode,
  // biome-ignore lint/suspicious/noShadowRestrictedNames: 代理接口就叫 Proxy，与全局 Proxy 无关
  type Proxy,
  type ProxyContext,
  startProxy,
} from "./proxy.js";

const LOCAL = "local";

let backend: http.Server;
let wss: WebSocketServer;
let backendPort: number;
let workDir: string;
// 后端响应被提前关闭的次数
let closedEarly = 0;
// 后端收到的请求数：用来断言「被拒绝的目标根本没被连上」
let backendHits = 0;
// 后端最后收到的请求头：用来断言逐跳头没有被转发
let lastHeaders: http.IncomingHttpHeaders = {};

beforeEach(async () => {
  closedEarly = 0;
  workDir = makeTmpDir("yuanshu-proxy-");
  writeFileSync(path.join(workDir, "page.html"), "<h1>file</h1>");
  backendHits = 0;
  lastHeaders = {};
  backend = http.createServer((req, res) => {
    backendHits += 1;
    lastHeaders = req.headers;
    // 客户端断开时后端应收到 close（代理要中止上游）
    res.on("close", () => {
      closedEarly += 1;
    });
    if (req.url === "/post") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => res.end(`got ${Buffer.concat(chunks).toString()}`));
      return;
    }
    if (req.url === "/slow") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("part1");
      return; // 故意不结束：用来验证流式转发
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`backend ${req.method} ${req.url} host=${req.headers.host}`);
  });
  wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (s) => s.on("message", (m) => s.send(`echo:${m}`)));
  backend.on("upgrade", (req, sock, head) =>
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req)),
  );
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  backendPort = (backend.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of wss.clients) client.terminate();
  backend.closeAllConnections();
  await new Promise<void>((ok) => backend.close(() => ok()));
});

const envs = new Map<string, ExecEnv>();

type Deps = Omit<Parameters<typeof startProxy>[0], "env" | "onDeny">;

function makeProxy(
  overrides: Partial<ProxyContext> = {},
  deps: Deps = {},
): Promise<{ proxy: Proxy; token: string; denies: DenyCode[] }> {
  const denies: DenyCode[] = [];
  return startProxy({
    env: (id) => envs.get(id) ?? null,
    onDeny: (info) => denies.push(info.code),
    ...deps,
  }).then((proxy) => {
    const reg = proxy.register({
      loopbackEnvId: LOCAL,
      allowService: () => true,
      allowFile: () => true,
      ...overrides,
    });
    return { proxy, token: reg.token, denies };
  });
}

const auth = (token: string) => ({
  "Proxy-Authorization": `Basic ${Buffer.from(`${token}:x`).toString("base64")}`,
});

// 经代理发普通 HTTP 请求（absolute-form，与 Chromium 一致）
function viaProxy(
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((ok, fail) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method,
        // 直接写绝对地址：http 模块见到 absolute-form 的 path 会原样发出
        path: url,
        headers: { host: new URL(url).host, ...headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString()));
        res.on("end", () =>
          ok({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", fail);
    req.end();
  });
}

// 经代理 CONNECT 到 authority，返回隧道里的原始 socket
async function tunnel(
  proxyPort: number,
  authority: string,
  headers: Record<string, string> = {},
): Promise<{ socket: net.Socket; status: number; head: string }> {
  const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
  await once(socket, "connect");
  socket.write(
    [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "",
      "",
    ].join("\r\n"),
  );
  let head = "";
  while (!head.includes("\r\n\r\n")) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    head += chunk.toString("latin1");
  }
  return { socket, status: Number(head.split(" ")[1]), head };
}

// 通过隧道读一次 HTTP 响应（响应可能跨多个 chunk）
async function readHttp(socket: net.Socket): Promise<string> {
  let buf = "";
  while (!buf.includes("backend")) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    buf += chunk.toString();
  }
  return buf;
}

describe("认证", () => {
  test("缺凭据与错令牌都是 407，带 Basic 质询", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, denies } = await makeProxy();
    try {
      const noAuth = await viaProxy(
        proxy.port,
        `http://${serviceHost(LOCAL, backendPort)}/x`,
      );
      expect(noAuth.status).toBe(407);
      expect(noAuth.headers["proxy-authenticate"]).toBe(
        'Basic realm="yuanshu"',
      );
      expect(noAuth.headers["x-yuanshu-deny"]).toBe("auth");

      const wrong = await viaProxy(
        proxy.port,
        `http://${serviceHost(LOCAL, backendPort)}/x`,
        auth("nope"),
      );
      expect(wrong.status).toBe(407);
      expect(denies).toEqual(["auth", "auth"]);
    } finally {
      await proxy.close();
    }
  });

  test("CONNECT 也要认证", async () => {
    const { proxy, denies } = await makeProxy();
    try {
      const r = await tunnel(proxy.port, `${serviceHost(LOCAL, backendPort)}`);
      expect(r.status).toBe(407);
      expect(r.head).toContain("X-Yuanshu-Deny: auth");
      expect(denies).toEqual(["auth"]);
      r.socket.destroy();
    } finally {
      await proxy.close();
    }
  });
});

describe("服务转发", () => {
  test("普通 HTTP 经 openTcp 到本机回环，Host 头保持虚拟主机名", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const host = serviceHost(LOCAL, backendPort);
      const r = await viaProxy(
        proxy.port,
        `http://${host}/a/b?q=1`,
        auth(token),
      );
      expect(r.status).toBe(200);
      expect(r.body).toBe(`backend GET /a/b?q=1 host=${host}`);
    } finally {
      await proxy.close();
    }
  });

  test("请求体转给上游", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const host = serviceHost(LOCAL, backendPort);
      const body = await new Promise<string>((ok, fail) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            method: "POST",
            path: `http://${host}/post`,
            headers: { host, ...auth(token) },
            agent: false,
          },
          (res) => {
            let text = "";
            res.on("data", (c: Buffer) => (text += c.toString()));
            res.on("end", () => ok(text));
          },
        );
        req.on("error", fail);
        req.end("hello body");
      });
      expect(body).toBe("got hello body");
    } finally {
      await proxy.close();
    }
  });

  test("逐跳头（含 Connection 里点名的）不转给上游", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const host = serviceHost(LOCAL, backendPort);
      await viaProxy(proxy.port, `http://${host}/h`, {
        ...auth(token),
        Connection: "x-hop",
        "X-Hop": "1",
        "Keep-Alive": "timeout=5",
        "X-Keep": "yes",
      });
      expect(lastHeaders["x-hop"]).toBeUndefined();
      expect(lastHeaders["proxy-authorization"]).toBeUndefined();
      expect(lastHeaders["keep-alive"]).toBeUndefined();
      expect(lastHeaders["x-keep"]).toBe("yes");
    } finally {
      await proxy.close();
    }
  });

  test("客户端中途断开时中止上游", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const host = serviceHost(LOCAL, backendPort);
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: `http://${host}/slow`,
        headers: { host, ...auth(token) },
        agent: false,
      });
      req.on("error", () => {});
      req.end();
      // 等上游拿到请求，再掐断客户端
      while (backendHits === 0) await new Promise((r) => setTimeout(r, 10));
      req.destroy();
      const deadline = Date.now() + 2000;
      while (closedEarly === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      expect(closedEarly).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  test("响应流式转发：上游没结束时客户端已收到部分内容", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const host = serviceHost(LOCAL, backendPort);
      const first = await new Promise<string>((ok, fail) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            path: `http://${host}/slow`,
            headers: { host, ...auth(token) },
            agent: false,
          },
          (res) => res.once("data", (c: Buffer) => ok(c.toString())),
        );
        req.on("error", fail);
        req.end();
      });
      expect(first).toBe("part1");
    } finally {
      await proxy.close();
    }
  });

  test("CONNECT 双向字节：隧道里的原始 HTTP 能通", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const authority = serviceHost(LOCAL, backendPort);
      const { socket, status } = await tunnel(
        proxy.port,
        authority,
        auth(token),
      );
      expect(status).toBe(200);
      socket.write(`GET /raw HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      expect(await readHttp(socket)).toContain("backend GET /raw");
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  test("WebSocket 经 CONNECT 能收发", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const authority = serviceHost(LOCAL, backendPort);
      // 先手工建隧道，再让 ws 复用这条已升级的连接
      const { socket } = await tunnel(proxy.port, authority, auth(token));
      const ws = new WebSocket(`ws://${authority}/ws`, {
        createConnection: () => socket,
      });
      await once(ws, "open");
      ws.send("ping");
      const [data] = (await once(ws, "message")) as [Buffer];
      expect(data.toString()).toBe("echo:ping");
      ws.close();
    } finally {
      await proxy.close();
    }
  });

  test("allowService 为假 → 403 + 拒绝码", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token, denies } = await makeProxy({
      allowService: () => false,
    });
    try {
      const r = await viaProxy(
        proxy.port,
        `http://${serviceHost(LOCAL, backendPort)}/x`,
        auth(token),
      );
      expect(r.status).toBe(403);
      expect(r.headers["x-yuanshu-deny"]).toBe("service_denied");
      expect(r.body).toContain("不允许访问");

      // CONNECT 走同一套授权
      const tunneled = await tunnel(
        proxy.port,
        serviceHost(LOCAL, backendPort),
        auth(token),
      );
      expect(tunneled.status).toBe(403);
      expect(tunneled.head).toContain("X-Yuanshu-Deny: service_denied");
      tunneled.socket.destroy();
      expect(denies).toEqual(["service_denied", "service_denied"]);
    } finally {
      await proxy.close();
    }
  });

  test("环境不存在 → unknown_host；没有 openTcp → unsupported", async () => {
    const { proxy, token, denies } = await makeProxy();
    try {
      const missing = await viaProxy(
        proxy.port,
        `http://${serviceHost("nope", 3000)}/x`,
        auth(token),
      );
      expect(missing.headers["x-yuanshu-deny"]).toBe("unknown_host");

      envs.set("virt", { os: "posix" } as ExecEnv);
      const noTcp = await viaProxy(
        proxy.port,
        `http://${serviceHost("virt", 3000)}/x`,
        auth(token),
      );
      expect(noTcp.headers["x-yuanshu-deny"]).toBe("unsupported");
      expect(denies).toEqual(["unknown_host", "unsupported"]);
    } finally {
      await proxy.close();
    }
  });

  test("其他 *.localhost 标签 → unknown_host", async () => {
    const { proxy, token } = await makeProxy();
    try {
      const r = await viaProxy(
        proxy.port,
        "http://stranger.localhost:9/",
        auth(token),
      );
      expect(r.status).toBe(403);
      expect(r.headers["x-yuanshu-deny"]).toBe("unknown_host");
    } finally {
      await proxy.close();
    }
  });
});

describe("经非 Socket 的 Duplex 转发（ssh 通道就是这种）", () => {
  test("HTTP 与 CONNECT 都只靠读写语义转发", async () => {
    // 包一层只有读写语义的 Duplex，模拟 ssh2 的 ClientChannel（不是 net.Socket）
    const openTcp = async (port: number) => {
      const raw = await new LocalEnv().openTcp(port);
      const channel = new Duplex({
        read: () => raw.resume(),
        write: (chunk, _enc, cb) => raw.write(chunk, cb),
        final: (cb) => {
          raw.end();
          cb();
        },
        destroy: (err, cb) => {
          raw.destroy();
          cb(err);
        },
      });
      raw.on("data", (c) => channel.push(c));
      raw.on("end", () => channel.push(null));
      raw.on("error", (err) => channel.destroy(err));
      raw.on("close", () => channel.destroy());
      return channel;
    };
    envs.set("sshlike", { id: "sshlike", os: "posix", openTcp } as ExecEnv);
    const { proxy, token } = await makeProxy();
    try {
      const http_ = await viaProxy(
        proxy.port,
        `http://${serviceHost("sshlike", backendPort)}/chan`,
        auth(token),
      );
      expect(http_.status).toBe(200);
      expect(http_.body).toContain("backend GET /chan");

      const { socket, status } = await tunnel(
        proxy.port,
        serviceHost("sshlike", backendPort),
        auth(token),
      );
      expect(status).toBe(200);
      socket.write(`GET /chan2 HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(await readHttp(socket)).toContain("backend GET /chan2");
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });
});

describe("裸回环地址", () => {
  test("loopbackEnvId 为空时拒绝", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy({ loopbackEnvId: null });
    try {
      const r = await viaProxy(
        proxy.port,
        `http://127.0.0.1:${backendPort}/x`,
        auth(token),
      );
      expect(r.status).toBe(403);
      expect(r.headers["x-yuanshu-deny"]).toBe("blocked_address");
    } finally {
      await proxy.close();
    }
  });

  test("CONNECT 到回环在 loopbackEnvId 为空时也被拒", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy({ loopbackEnvId: null });
    try {
      const r = await tunnel(
        proxy.port,
        `127.0.0.1:${backendPort}`,
        auth(token),
      );
      expect(r.status).toBe(403);
      expect(r.head).toContain("X-Yuanshu-Deny: blocked_address");
      r.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  test("loopbackEnvId 非空时按该环境转发", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const r = await viaProxy(
        proxy.port,
        `http://127.0.0.1:${backendPort}/loop`,
        auth(token),
      );
      expect(r.body).toContain("backend GET /loop");
    } finally {
      await proxy.close();
    }
  });
});

describe("公网与 DNS 校验", () => {
  test("域名解析到内网地址 → blocked_address", async () => {
    const { proxy, token, denies } = await makeProxy(
      {},
      { lookup: async () => [{ address: "10.1.2.3", family: 4 }] },
    );
    try {
      const r = await viaProxy(
        proxy.port,
        "http://intranet.example/x",
        auth(token),
      );
      expect(r.status).toBe(403);
      expect(r.headers["x-yuanshu-deny"]).toBe("blocked_address");
      expect(denies).toEqual(["blocked_address"]);
    } finally {
      await proxy.close();
    }
  });

  // 被拦的地址要忽略而不是连：拨号接缝记下每次被要求拨的地址
  const dialsOf = (rows: { address: string; family: number }[]) => {
    const dials: string[] = [];
    return {
      dials,
      deps: {
        lookup: async () => rows,
        dial: (address: string) => {
          dials.push(address);
          return net.connect({ host: "127.0.0.1", port: 1 });
        },
      },
    };
  };

  test("解析结果里混了被拦的地址：忽略它，只连通过校验的那个（fake-ip DNS 的 AAAA 是 fc00::）", async () => {
    for (const rows of [
      [
        { address: "fc00::6", family: 6 },
        { address: "28.0.0.6", family: 4 },
      ],
      [
        { address: "169.254.169.254", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ],
    ]) {
      const d = dialsOf(rows);
      const { proxy, token } = await makeProxy({}, d.deps);
      try {
        await viaProxy(proxy.port, "http://mixed.example/x", auth(token)).catch(
          () => null,
        );
        expect(d.dials).toEqual([rows[1]?.address]);
      } finally {
        await proxy.close();
      }
    }
  });

  test("解析结果全是被拦的地址 → blocked_address，一个都不拨", async () => {
    const d = dialsOf([
      { address: "fc00::6", family: 6 },
      { address: "10.1.2.3", family: 4 },
    ]);
    const { proxy, token } = await makeProxy({}, d.deps);
    try {
      const r = await viaProxy(
        proxy.port,
        "http://allblocked.example/x",
        auth(token),
      );
      expect(r.headers["x-yuanshu-deny"]).toBe("blocked_address");
      expect(d.dials).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  test("IP 字面量直接过黑名单（公网 IP 放行、内网 IP 拒绝）", async () => {
    const { proxy, token, denies } = await makeProxy();
    try {
      const internal = await viaProxy(
        proxy.port,
        "http://192.168.1.1/x",
        auth(token),
      );
      expect(internal.headers["x-yuanshu-deny"]).toBe("blocked_address");
      const metadata = await viaProxy(
        proxy.port,
        "http://169.254.169.254/latest/meta-data/",
        auth(token),
      );
      expect(metadata.headers["x-yuanshu-deny"]).toBe("blocked_address");
      expect(denies).toEqual(["blocked_address", "blocked_address"]);
    } finally {
      await proxy.close();
    }
  });

  test("CONNECT 到内网地址 → blocked_address", async () => {
    const { proxy, token, denies } = await makeProxy();
    try {
      const r = await tunnel(proxy.port, "169.254.169.254:80", auth(token));
      expect(r.status).toBe(403);
      expect(r.head).toContain("X-Yuanshu-Deny: blocked_address");
      expect(denies).toEqual(["blocked_address"]);
      r.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  test("解析失败 → unresolvable", async () => {
    const { proxy, token } = await makeProxy(
      {},
      {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      },
    );
    try {
      const r = await viaProxy(proxy.port, "http://nx.example/x", auth(token));
      expect(r.headers["x-yuanshu-deny"]).toBe("unresolvable");
    } finally {
      await proxy.close();
    }
  });

  // DNS 重绑定：第二次解析给出回环地址，但连接必须仍用第一次校验过的公网 IP
  test("只解析一次，连接用已校验的 IP", async () => {
    let calls = 0;
    const { proxy, token } = await makeProxy(
      {},
      {
        lookup: async () => {
          calls += 1;
          return calls === 1
            ? [{ address: "203.0.113.7", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }];
        },
      },
    );
    try {
      // 端口用后端真实端口：真要落到第二次解析出的回环地址，后端就会收到请求
      const result = await Promise.race([
        viaProxy(
          proxy.port,
          `http://rebind.example:${backendPort}/x`,
          auth(token),
        ).catch(() => null),
        new Promise((ok) => setTimeout(() => ok("timeout"), 1500)),
      ]);
      if (result !== null && result !== "timeout")
        expect((result as { status: number }).status).not.toBe(200);
      expect(calls).toBe(1);
      expect(backendHits).toBe(0);
    } finally {
      await proxy.close();
    }
  });
});

describe("公网拨号只连已校验的 IP（防 DNS 重绑定）", () => {
  // 沙箱网络里「拨域名」和「拨 IP」都显示已连接，没法靠网络行为区分，所以断言被要求拨的地址本身。
  const rebind = () => {
    let calls = 0;
    return {
      lookup: async () => {
        calls += 1;
        return calls === 1
          ? [{ address: "203.0.113.7", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      calls: () => calls,
    };
  };

  test("普通 HTTP：拨的是第一次解析出的 IP，不是域名", async () => {
    const dials: string[] = [];
    const r = rebind();
    const { proxy, token } = await makeProxy(
      {},
      {
        lookup: r.lookup,
        dial: (address) => {
          dials.push(address);
          // 拨一个必定拒绝的本机端口：走标准的连接失败路径，请求随之结束
          return net.connect({ host: "127.0.0.1", port: 1 });
        },
      },
    );
    try {
      await viaProxy(
        proxy.port,
        "http://rebind.example:8080/x",
        auth(token),
      ).catch(() => null);
      expect(dials).toEqual(["203.0.113.7"]);
      expect(r.calls()).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  test("CONNECT：拨的是第一次解析出的 IP，不是域名", async () => {
    const dials: string[] = [];
    const r = rebind();
    const { proxy, token } = await makeProxy(
      {},
      {
        lookup: r.lookup,
        dial: (address) => {
          dials.push(address);
          // 拨一个必定拒绝的本机端口：走标准的连接失败路径，请求随之结束
          return net.connect({ host: "127.0.0.1", port: 1 });
        },
      },
    );
    try {
      await new Promise<void>((done) => {
        const req = http.request({
          host: "127.0.0.1",
          port: proxy.port,
          method: "CONNECT",
          path: "rebind.example:443",
          headers: auth(token),
        });
        req.on("connect", (_res, socket) => {
          socket.destroy();
          done();
        });
        req.on("error", () => done());
        req.end();
      });
      expect(dials).toEqual(["203.0.113.7"]);
      expect(r.calls()).toBe(1);
    } finally {
      await proxy.close();
    }
  });
});

describe("文件主机", () => {
  test("经代理读到工作区文件", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const r = await viaProxy(
        proxy.port,
        `http://server.files.localhost${workDir}/page.html`,
        auth(token),
      );
      expect(r.status).toBe(200);
      expect(r.body).toBe("<h1>file</h1>");
      expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    } finally {
      await proxy.close();
    }
  });

  test("allowFile 为假 → 403 file_denied", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token, denies } = await makeProxy({
      allowFile: () => false,
    });
    try {
      const r = await viaProxy(
        proxy.port,
        `http://server.files.localhost${workDir}/page.html`,
        auth(token),
      );
      expect(r.status).toBe(403);
      expect(r.headers["x-yuanshu-deny"]).toBe("file_denied");
      expect(denies).toEqual(["file_denied"]);
    } finally {
      await proxy.close();
    }
  });

  test("环境不存在 → unknown_host；CONNECT 到文件主机 → unsupported", async () => {
    const { proxy, token } = await makeProxy();
    try {
      const missing = await viaProxy(
        proxy.port,
        `http://nope.files.localhost/a.html`,
        auth(token),
      );
      expect(missing.headers["x-yuanshu-deny"]).toBe("unknown_host");

      const r = await tunnel(
        proxy.port,
        "server.files.localhost:80",
        auth(token),
      );
      expect(r.status).toBe(403);
      expect(r.head).toContain("X-Yuanshu-Deny: unsupported");
      r.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  test("非 GET 的文件请求被拒绝", async () => {
    envs.set(LOCAL, new LocalEnv());
    const { proxy, token } = await makeProxy();
    try {
      const r = await viaProxy(
        proxy.port,
        `http://server.files.localhost${workDir}/page.html`,
        auth(token),
        "POST",
      );
      expect(r.status).toBe(405);
    } finally {
      await proxy.close();
    }
  });
});

describe("生命周期", () => {
  test("unregister 后令牌失效；close 断开连接", async () => {
    envs.set(LOCAL, new LocalEnv());
    const proxy = await startProxy({ env: (id) => envs.get(id) ?? null });
    const reg = proxy.register({
      loopbackEnvId: LOCAL,
      allowService: () => true,
      allowFile: () => true,
    });
    const first = await viaProxy(
      proxy.port,
      `http://${serviceHost(LOCAL, backendPort)}/x`,
      auth(reg.token),
    );
    expect(first.status).toBe(200);
    reg.unregister();
    const after = await viaProxy(
      proxy.port,
      `http://${serviceHost(LOCAL, backendPort)}/x`,
      auth(reg.token),
    );
    expect(after.status).toBe(407);
    await proxy.close();
  });
});
