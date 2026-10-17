import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Config } from "./config.js";
import {
  createServer,
  hideServerErrorDetails,
  isLoopbackHost,
  type YuanshuServer,
} from "./server.js";

const VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

let base: string;
let webRoot: string;
const running: YuanshuServer[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-server-"));
  webRoot = path.join(base, "web");
  await mkdir(path.join(webRoot, "sub"), { recursive: true });
  await mkdir(path.join(webRoot, ".hidden"));
  await writeFile(
    path.join(webRoot, "index.html"),
    "<!doctype html><title>PLACEHOLDER-INDEX</title>",
  );
  await writeFile(path.join(webRoot, ".secret"), "DOTFILE-SECRET");
  await writeFile(path.join(webRoot, ".hidden", "x.txt"), "HIDDEN-DIR-SECRET");
  // 与 web 目录同级，位于目录外：穿越成功就能读到。
  await writeFile(path.join(base, "secret.txt"), "TOP-SECRET");
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop().catch(() => {})));
  await rm(base, { recursive: true, force: true });
});

function memoryLog() {
  const chunks: string[] = [];
  return {
    stream: { write: (msg: string) => void chunks.push(msg) },
    records: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { level: number; msg?: string }),
  };
}

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: path.join(base, "data"),
    allowCidrs: [],
    ...over,
  };
}

async function launch(config: Config = cfg(), opts: { webRoot?: string } = {}) {
  const log = memoryLog();
  const server = createServer(config, {
    webRoot,
    logStream: log.stream,
    ...opts,
  });
  running.push(server);
  const addr = await server.start();
  return { server, addr, log, url: `http://127.0.0.1:${addr.port}` };
}

// 原样发送路径：fetch 与 inject 都会先规范化 /../，这里要测的恰恰是没被规范化的情形。
function rawGet(port: number, rawPath: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: rawPath, method: "GET" },
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
}

describe("GET /healthz（R5）", () => {
  test("200、JSON、恰好两个字段", async () => {
    const { url } = await launch();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const text = await res.text();
    expect(text).toBe(`{"status":"ok","version":"${VERSION}"}`);
  });

  test("HEAD 返回 200 且无响应体", async () => {
    const { url } = await launch();
    const res = await fetch(`${url}/healthz`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("web 目录里有名为 healthz 的文件也遮蔽不了它", async () => {
    await writeFile(path.join(webRoot, "healthz"), "SHADOW");
    const { url } = await launch();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: VERSION });
  });
});

describe("静态托管（R6）", () => {
  test("GET / 返回 index.html", async () => {
    const { url } = await launch();
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("PLACEHOLDER-INDEX");
  });

  test("不存在的路径是 404，不回退到 index.html", async () => {
    const { url } = await launch();
    const res = await fetch(`${url}/no/such/page`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("PLACEHOLDER-INDEX");
  });

  test.each([
    ["点文件", "/.secret", "DOTFILE-SECRET"],
    ["隐藏目录里的文件", "/.hidden/x.txt", "HIDDEN-DIR-SECRET"],
  ])("%s 得到 4xx，且不泄露内容", async (_n, p, secret) => {
    const { addr } = await launch();
    const res = await rawGet(addr.port, p);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain(secret);
  });

  test.each(["/sub/", "/sub"])(
    "没有 index 的目录 %s 不给目录列表",
    async (p) => {
      await writeFile(path.join(webRoot, "sub", "listed.txt"), "x");
      const { addr } = await launch();
      const res = await rawGet(addr.port, p);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body).not.toContain("listed.txt");
    },
  );

  test.each([
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/..%2fsecret.txt",
    "/..%5csecret.txt",
    "/%2e%2e%5csecret.txt",
    "/./../secret.txt",
    "/sub/../../secret.txt",
    "/..",
    "/../",
  ])("目录穿越 %s 得到 4xx，且读不到目录外内容", async (p) => {
    const { addr } = await launch();
    const res = await rawGet(addr.port, p);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain("TOP-SECRET");
  });

  test.each([
    ["指向目录外文件的符号链接", "/link.txt"],
    ["指向目录外目录的符号链接", "/outdir/secret.txt"],
  ])("%s 得到 4xx，且读不到目录外内容", async (_n, p) => {
    await symlink(
      path.join(base, "secret.txt"),
      path.join(webRoot, "link.txt"),
    );
    await symlink(base, path.join(webRoot, "outdir"));
    const { addr } = await launch();
    const res = await rawGet(addr.port, p);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain("TOP-SECRET");
  });

  // 请求路径本身在根内，库随后才拼上 index.html 去读：index.html 是指向目录外的链接时也必须拒绝。
  test.each([
    ["子目录", "/idx/"],
    ["子目录（不带斜杠）", "/idx"],
  ])("%s 的 index.html 是指向目录外的链接时得到 4xx", async (_n, p) => {
    await mkdir(path.join(webRoot, "idx"));
    await symlink(
      path.join(base, "secret.txt"),
      path.join(webRoot, "idx", "index.html"),
    );
    const { addr } = await launch();
    const res = await rawGet(addr.port, p);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain("TOP-SECRET");
  });

  test("根目录的 index.html 是指向目录外的链接时启动失败，并说明原因", async () => {
    await rm(path.join(webRoot, "index.html"));
    await symlink(
      path.join(base, "secret.txt"),
      path.join(webRoot, "index.html"),
    );
    const server = createServer(cfg(), {
      webRoot,
      logStream: memoryLog().stream,
    });
    await expect(server.start()).rejects.toThrow("指向 web 目录之外");
  });

  test("子目录没有搜索权限时得到 4xx，响应不含服务器路径", async () => {
    if (process.getuid?.() === 0) throw new Error("权限类测试不能以 root 运行");
    await mkdir(path.join(webRoot, "priv"));
    await writeFile(path.join(webRoot, "priv", "index.html"), "P");
    await chmod(path.join(webRoot, "priv"), 0o000);
    try {
      const { addr } = await launch();
      const res = await rawGet(addr.port, "/priv/");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body).not.toContain(base);
    } finally {
      await chmod(path.join(webRoot, "priv"), 0o755);
    }
  });

  // 不存在的路径必须得到 404，而不是守卫里抛出的 500。注意 allowedPath 拒绝时库也是回 404（callNotFound），所以这里区分不了「放行后 404」与「被拒后 404」，只能防止 500。
  test.each([
    ["不存在的文件", "/nope.txt"],
    ["不存在的目录下的文件", "/nope/x.txt"],
    ["把文件当目录", "/index.html/foo"],
    ["没有 index.html 的目录", "/sub/"],
  ])("%s 得到 404（不是 500）", async (_n, p) => {
    const { addr } = await launch();
    expect((await rawGet(addr.port, p)).status).toBe(404);
  });

  test("符号链接环得到 4xx，响应不含服务器路径", async () => {
    await symlink(path.join(webRoot, "loop2"), path.join(webRoot, "loop1"));
    await symlink(path.join(webRoot, "loop1"), path.join(webRoot, "loop2"));
    const { addr } = await launch();
    const res = await rawGet(addr.port, "/loop1");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain(base);
  });

  test("指向目录内部的符号链接仍可访问", async () => {
    await writeFile(path.join(webRoot, "real.txt"), "INSIDE");
    await symlink(
      path.join(webRoot, "real.txt"),
      path.join(webRoot, "alias.txt"),
    );
    const { addr } = await launch();
    const res = await rawGet(addr.port, "/alias.txt");
    expect(res.status).toBe(200);
    expect(res.body).toBe("INSIDE");
  });

  test("web 目录不存在时启动失败，且不创建数据目录、不监听", async () => {
    const port = await freePort();
    const server = createServer(cfg({ port }), {
      webRoot: path.join(base, "missing"),
      logStream: memoryLog().stream,
    });
    await expect(server.start()).rejects.toThrow(path.join(base, "missing"));
    await expect(stat(path.join(base, "data"))).rejects.toThrow();
    await expect(rawGet(port, "/healthz")).rejects.toThrow(/ECONNREFUSED/);
  });

  test("web 目录里没有 index.html 时启动失败", async () => {
    const empty = path.join(base, "empty-web");
    await mkdir(empty);
    const server = createServer(cfg(), {
      webRoot: empty,
      logStream: memoryLog().stream,
    });
    await expect(server.start()).rejects.toThrow(empty);
    await expect(stat(path.join(base, "data"))).rejects.toThrow();
  });
});

describe("isLoopbackHost（R3）", () => {
  test.each(["127.0.0.1", "127.8.9.1", "127.255.255.254", "::1", "localhost"])(
    "%s 是回环",
    (h) => {
      expect(isLoopbackHost(h)).toBe(true);
    },
  );

  test.each([
    "0.0.0.0",
    "::",
    "::ffff:127.0.0.1",
    "192.0.2.1",
    "128.0.0.1",
    "126.255.255.255",
    "example.com",
    "127.0.0.1.example.com",
    "LOCALHOST",
    "",
  ])("%s 按非回环处理", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("非回环警告（R3）", () => {
  test("监听 0.0.0.0 时输出 warn 且仍启动成功", async () => {
    const { log, url } = await launch(cfg({ host: "0.0.0.0" }));
    const warns = log.records().filter((r) => r.level === 40);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((r) => r.msg?.includes("认证"))).toBe(true);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  test("监听回环地址时没有 warn 及以上的日志", async () => {
    const { log } = await launch(cfg({ host: "127.0.0.1" }));
    expect(log.records().filter((r) => r.level >= 40)).toEqual([]);
  });
});

describe("生命周期（R7）", () => {
  test("端口被占用时启动失败，错误含 host 与 port", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const { port } = blocker.address() as net.AddressInfo;
    try {
      const server = createServer(cfg({ port }), {
        webRoot,
        logStream: memoryLog().stream,
      });
      await expect(server.start()).rejects.toThrow(`127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  test("存在空闲 keep-alive 连接时 stop() 在 5 秒内完成，之后不再接收连接", async () => {
    const { server, addr } = await launch();
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          { host: "127.0.0.1", port: addr.port, path: "/healthz", agent },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        )
        .on("error", reject);
    });
    const started = Date.now();
    await server.stop();
    agent.destroy();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(rawGet(addr.port, "/healthz")).rejects.toThrow(/ECONNREFUSED/);
  });

  // 已连接但没发完请求的连接，不会被 Node 当作"空闲"关闭，必须由 stop() 强制断开。
  test.each([
    ["连上后什么都不发", ""],
    ["请求头只发一半", "GET /healthz HTTP/1.1\r\nHost: x\r\n"],
    [
      "请求体没发完",
      "POST /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab",
    ],
  ])(
    "存在半开连接（%s）时 stop() 仍在 5 秒内完成",
    async (_name, partial) => {
      const { server, addr } = await launch();
      const socket = net.connect(addr.port, "127.0.0.1");
      socket.on("error", () => {});
      await new Promise<void>((r) => socket.once("connect", () => r()));
      if (partial) socket.write(partial);
      await new Promise((r) => setTimeout(r, 100));

      const started = Date.now();
      await server.stop();
      socket.destroy();
      expect(Date.now() - started).toBeLessThan(5000);
    },
    15000,
  );
});

describe("数据目录（R4）", () => {
  test("启动并停止之后，数据目录里只有数据库与 sessions 目录", async () => {
    const dataDir = path.join(base, "data");
    const { server } = await launch(cfg({ dataDir }));
    await server.stop();
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dataDir)).toEqual(["sessions", "yuanshu.db"]);
  });
});

describe("无全局状态（R8）", () => {
  test("同一进程内两个不同配置的实例互不影响", async () => {
    const webB = path.join(base, "web-b");
    await mkdir(webB);
    await writeFile(path.join(webB, "index.html"), "BBB-INSTANCE");
    // 两个实例先都创建、再启动：若实现把配置存进模块级变量，后创建的会覆盖先创建的。
    const a = createServer(cfg({ dataDir: path.join(base, "data-a") }), {
      webRoot,
      logStream: memoryLog().stream,
    });
    const b = createServer(cfg({ dataDir: path.join(base, "data-b") }), {
      webRoot: webB,
      logStream: memoryLog().stream,
    });
    running.push(a, b);
    const addrA = await a.start();
    const addrB = await b.start();
    const urlA = `http://127.0.0.1:${addrA.port}`;
    const urlB = `http://127.0.0.1:${addrB.port}`;

    expect(addrA.port).not.toBe(addrB.port);
    // 每个实例准备的是自己的数据目录。
    await stat(path.join(base, "data-a"));
    await stat(path.join(base, "data-b"));
    expect(await (await fetch(`${urlA}/`)).text()).toContain(
      "PLACEHOLDER-INDEX",
    );
    expect(await (await fetch(`${urlB}/`)).text()).toBe("BBB-INSTANCE");

    await a.stop();
    expect((await fetch(`${urlB}/healthz`)).status).toBe(200);
    await expect(fetch(`${urlA}/healthz`)).rejects.toThrow();
  });
});

describe("5xx 不泄漏内部细节", () => {
  test("未处理异常只返回通用文案，详情进日志；4xx 保持原样", async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(hideServerErrorDetails);
    app.get("/boom", async () => {
      throw new Error("ENOENT: '/home/u/secret/x.jsonl'");
    });
    app.post("/j", async () => "ok");
    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(JSON.parse(boom.body)).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
    });
    const bad = await app.inject({
      method: "POST",
      url: "/j",
      payload: "{bad",
      headers: { "content-type": "application/json" },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
