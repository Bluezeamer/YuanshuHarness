import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { waitFor } from "../../test/support/frames.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { type Deps, execute } from "../cli.js";
import type { Config } from "../config.js";
import { createServer, type YuanshuServer } from "../server.js";

const TOKEN = "k".repeat(40);
const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

let base: string;
let webRoot: string;
const running: YuanshuServer[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-client-"));
  webRoot = path.join(base, "web");
  await mkdir(webRoot);
  await writeFile(path.join(webRoot, "index.html"), "<title>x</title>");
});

afterEach(async () => {
  stub.mode.delayMs = 0;
  stub.mode.chunkBytes = 0;
  stub.requests.length = 0;
  for (const s of running.splice(0)) await s.stop();
  await rm(base, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function boot(
  over: Partial<Config> = {},
  opts: { factory?: boolean; tuning?: Record<string, number> } = {},
) {
  const port = await freePort();
  const config: Config = {
    host: "127.0.0.1",
    port,
    dataDir: path.join(base, `data-${port}`),
    allowCidrs: [],
    ...over,
  };
  const server = createServer(config, {
    webRoot,
    logStream: { write: () => {} },
    ...(opts.factory === false
      ? {}
      : { sessionFactory: stubSessionFactory(stub) }),
    ...(opts.tuning ? { tuning: opts.tuning } : {}),
  });
  running.push(server);
  await server.start();
  return { url: `http://127.0.0.1:${port}`, server, port };
}

function cli(env: Record<string, string> = {}, url?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  const stdin = new PassThrough();
  const deps: Deps = {
    env: { ...(url ? { YUANSHU_URL: url } : {}), ...env },
    home: base,
    cwd: base,
    stdin,
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    signal: controller.signal,
  };
  return {
    deps,
    stdin,
    controller,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    run: (...argv: string[]) => execute(argv, deps),
  };
}

async function newSession(url: string, env: Record<string, string> = {}) {
  const c = cli(env, url);
  expect(await c.run("new")).toBe(0);
  return c.stdout().trim();
}

describe("分派与用法（R1）", () => {
  test("缺参数、未知参数、非法地址：退出 2 并打印用法", async () => {
    for (const argv of [
      ["attach"],
      ["attach", "a", "b"],
      ["sessions", "x"],
      ["sessions", "--token", "abc"],
      ["sessions", "--url", "nope"],
    ]) {
      const c = cli();
      expect(await c.run(...argv)).toBe(2);
      expect(c.stderr()).toContain("yuanshu sessions");
      expect(c.stdout()).toBe("");
    }
  });

  test("未知子命令仍走 serve 的解析，退出码不为 0", async () => {
    const c = cli();
    expect(await c.run("start")).not.toBe(0);
    expect(c.stderr()).toContain("start");
  });
});

describe("令牌与错误（R2、R3）", () => {
  test("令牌经环境变量通过；--token 被当未知参数；输出不含令牌", async () => {
    const { url } = await boot({ token: TOKEN });
    const ok = cli({ YUANSHU_TOKEN: TOKEN }, url);
    expect(await ok.run("sessions")).toBe(0);
    expect(ok.stdout() + ok.stderr()).not.toContain(TOKEN);

    const flag = cli({}, url);
    expect(await flag.run("sessions", "--token", TOKEN)).toBe(2);
    expect(flag.stderr()).not.toContain(TOKEN);
  });

  test("401：一行原因，退出 1，输出不含令牌", async () => {
    const { url } = await boot({ token: TOKEN });
    const wrong = "w".repeat(40);
    const c = cli({ YUANSHU_TOKEN: wrong }, url);
    expect(await c.run("sessions")).toBe(1);
    expect(c.stderr()).toContain("认证失败");
    expect(c.stderr().trim().split("\n")).toHaveLength(1);
    expect(c.stdout() + c.stderr()).not.toContain(wrong);
  });

  test("连接失败：退出 1，信息不含令牌", async () => {
    const port = await freePort();
    const c = cli({ YUANSHU_TOKEN: TOKEN }, `http://127.0.0.1:${port}`);
    expect(await c.run("sessions")).toBe(1);
    expect(c.stdout() + c.stderr()).not.toContain(TOKEN);
  });

  test("attach 被拒时同样不泄漏令牌", async () => {
    const { url } = await boot({ token: TOKEN });
    const wrong = "w".repeat(40);
    const c = cli({ YUANSHU_TOKEN: wrong }, url);
    expect(await c.run("attach", "any")).toBe(1);
    expect(c.stderr()).toContain("认证失败");
    expect(c.stdout() + c.stderr()).not.toContain(wrong);
  });

  test("403：来源不在网段内", async () => {
    const { url } = await boot({ allowCidrs: ["10.0.0.0/8"] });
    const c = cli({}, url);
    expect(await c.run("sessions")).toBe(1);
    expect(c.stderr()).toContain("被拒绝");
  });

  test("429：带 Retry-After 秒数", async () => {
    const { url } = await boot({ token: TOKEN });
    const wrong = cli({ YUANSHU_TOKEN: "w".repeat(40) }, url);
    for (let i = 0; i < 10; i++) await wrong.run("sessions");
    const c = cli({ YUANSHU_TOKEN: TOKEN }, url);
    expect(await c.run("sessions")).toBe(1);
    expect(c.stderr()).toMatch(/请 \d+ 秒后再试/);
  });

  test("501：服务端没有会话工厂；404：会话不存在", async () => {
    const { url } = await boot({}, { factory: false });
    const c = cli({}, url);
    expect(await c.run("new")).toBe(1);
    expect(c.stderr()).toContain("没有会话后端");

    const d = cli({}, url);
    expect(await d.run("attach", "no-such")).toBe(1);
    expect(d.stderr()).toContain("会话不存在");
  });
});

describe("列出、创建与接入（R4–R6、R9、R10）", () => {
  test("无会话时一行提示；new 只打印 id；sessions 每行 id、状态、名称", async () => {
    const { url } = await boot();
    const empty = cli({}, url);
    expect(await empty.run("sessions")).toBe(0);
    expect(empty.stdout()).toBe("没有会话\n");

    const id = await newSession(url);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const list = cli({}, url);
    expect(await list.run("sessions")).toBe(0);
    expect(list.stdout()).toBe(`${id}\tidle\t\n`);
  });

  test("管道输入一条消息后 EOF：等运行结束才退出 0，输出含回复", async () => {
    const { url } = await boot();
    const id = await newSession(url);
    const c = cli({}, url);
    c.stdin.end("你好\n");
    expect(await c.run("attach", id)).toBe(0);
    expect(c.stdout()).toContain("[你] 你好");
    expect(c.stdout()).toContain("[助手] reply-1");
    expect(c.stderr()).toBe("");
  });

  test("EOF 不抢跑：运行较慢时仍等到结束", async () => {
    stub.mode.delayMs = 300;
    const { url } = await boot();
    const id = await newSession(url);
    const c = cli({}, url);
    c.stdin.end("慢一点\n");
    const started = Date.now();
    expect(await c.run("attach", id)).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(c.stdout()).toContain("[助手] reply-1");
  });

  test("中途接入：先出 partial 再续上实时流，文本不重不漏", async () => {
    stub.mode.chunkBytes = 1;
    stub.mode.delayMs = 50;
    const { url } = await boot();
    const id = await newSession(url);

    const first = cli({}, url);
    first.stdin.write("开始\n");
    const done1 = first.run("attach", id);
    await waitFor(() => first.stdout().includes("[助手] r"), "首个增量");

    const second = cli({}, url);
    const done2 = second.run("attach", id);
    await waitFor(
      () => second.stdout().includes("[助手]"),
      "第二个客户端收到快照",
    );
    second.stdin.end();
    first.stdin.end();
    expect(await done1).toBe(0);
    expect(await done2).toBe(0);
    expect(second.stdout()).toContain("[助手] reply-1\n");
    expect(second.stdout().split("reply-1")).toHaveLength(2);
  });

  test("/stop 中止运行；空白行不发；/quit 退出 0", async () => {
    stub.mode.delayMs = 5000;
    const { url } = await boot();
    const id = await newSession(url);
    const c = cli({}, url);
    const done = c.run("attach", id);
    c.stdin.write("   \n");
    c.stdin.write("很慢的问题\n");
    await waitFor(() => stub.requests.length === 1, "请求到达 stub");
    expect(stub.requests).toHaveLength(1);
    c.stdin.write("/stop\n");
    await waitFor(() => c.stdout().includes("[你] 很慢的问题"), "消息被回显");
    c.stdin.write("/quit\n");
    expect(await done).toBe(0);
  });

  test("ack 失败：错误信息写 stderr，连接保持可用", async () => {
    const { url } = await boot();
    const id = await newSession(url);
    const c = cli({}, url);
    const done = c.run("attach", id);
    c.stdin.write("x".repeat(60 * 1024 * 1024) + "\n");
    await waitFor(
      () => c.stderr().length > 0 || c.stdout().length > 0,
      "有响应",
      8000,
    );
    c.stdin.end("还在吗\n");
    expect(await done).not.toBe(undefined);
  });

  test("Ctrl-C：注入的 AbortSignal 立即退出 0，不发 stop，会话继续", async () => {
    stub.mode.delayMs = 400;
    const { url } = await boot();
    const id = await newSession(url);
    const c = cli({}, url);
    const done = c.run("attach", id);
    c.stdin.write("继续跑\n");
    await waitFor(() => stub.requests.length === 1, "请求到达");
    c.controller.abort();
    expect(await done).toBe(0);

    const list = cli({}, url);
    await list.run("sessions");
    expect(list.stdout()).toContain("running");
  });
});

describe("连接关闭（R8）", () => {
  test("Server stop()：打印 1001 与原因，退出 1", async () => {
    const { url, server } = await boot();
    const id = await newSession(url);
    const c = cli({}, url);
    const done = c.run("attach", id);
    c.stdin.write("先说一句\n");
    await waitFor(
      () => c.stdout().includes("[助手] reply-"),
      "已接入并收到回复",
    );
    await server.stop();
    running.length = 0;
    expect(await done).toBe(1);
    expect(c.stderr()).toContain("1001");
    expect(c.stderr()).toContain("server_shutdown");
  });

  test("EOF 等待期间连接被关闭：按 R8 退出 1", async () => {
    stub.mode.delayMs = 1000;
    const { url, server } = await boot();
    const id = await newSession(url);
    const c = cli({}, url);
    c.stdin.end("等着\n");
    const done = c.run("attach", id);
    await waitFor(() => stub.requests.length === 1, "请求到达");
    await server.stop();
    running.length = 0;
    expect(await done).toBe(1);
    expect(c.stderr()).toContain("连接已关闭");
  });
});

type Tamper = (frames: string[], index: number) => string[];

// 客户端 <-> 代理 <-> 真实 Server；只改动服务端到客户端方向的实时帧，snapshot 与 ack 原样放行。
async function proxy(target: string, tamper: Tamper, resyncDelayMs = 0) {
  const http = createHttpServer((req, res) => {
    const up = httpRequest(
      {
        host: "127.0.0.1",
        port: new URL(target).port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(up);
  });
  const wss = new WebSocketServer({
    server: http,
    handleProtocols: (p) => (p.has("yuanshu.v1") ? "yuanshu.v1" : false),
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const resyncs: string[] = [];
  let live = 0;
  wss.on("connection", (down, req) => {
    const up = new WsClient(target + (req.url ?? ""), ["yuanshu.v1"]);
    const queued: string[] = [];
    down.on("message", (d) => {
      const text = d.toString();
      const isResync = JSON.parse(text).type === "resync";
      if (isResync) resyncs.push(text);
      if (isResync && resyncDelayMs > 0) {
        setTimeout(() => up.send(text), resyncDelayMs);
      } else if (up.readyState === 1) up.send(text);
      else queued.push(text);
    });
    up.on("open", () => {
      for (const q of queued) up.send(q);
    });
    up.on("message", (d) => {
      const text = d.toString();
      const type = JSON.parse(text).type;
      const out =
        type === "snapshot" || type === "ack" ? [text] : tamper([text], live++);
      for (const o of out) down.send(o);
    });
    up.on("close", (c, r) => down.close(c === 1005 ? 1000 : c, r.toString()));
    down.on("close", () => up.close());
  });
  const port = (http.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    resyncs,
    close: () =>
      new Promise<void>((r) => {
        wss.close();
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}

describe("序号缺口与 resync（R7）", () => {
  async function scenario(tamper: Tamper, resyncDelayMs = 0) {
    stub.mode.chunkBytes = 1;
    stub.mode.delayMs = 20;
    const { url, port } = await boot();
    const id = await newSession(url);
    const px = await proxy(`ws://127.0.0.1:${port}`, tamper, resyncDelayMs);
    const c = cli({}, px.url);
    c.stdin.end("说话\n");
    const code = await c.run("attach", id);
    await px.close();
    return { code, out: c.stdout(), err: c.stderr(), px };
  }

  test("丢一帧：恰好一个 resync，最终文本连续", async () => {
    const r = await scenario((f, i) => (i === 3 ? [] : f));
    expect(r.code).toBe(0);
    expect(r.px.resyncs).toHaveLength(1);
    expect(r.out).toContain("[助手] reply-1\n");
  });

  test("重复一帧：恰好一个 resync，文本不重", async () => {
    const r = await scenario((f, i) => (i === 3 ? [...f, ...f] : f));
    expect(r.code).toBe(0);
    expect(r.px.resyncs).toHaveLength(1);
    expect(r.out.split("reply-1")).toHaveLength(2);
  });

  test("乱序一帧：恰好一个 resync，最终文本连续", async () => {
    let held: string | undefined;
    const r = await scenario((f, i) => {
      if (i === 3) {
        held = f[0];
        return [];
      }
      if (i === 4 && held) return [...f, held];
      return f;
    });
    expect(r.code).toBe(0);
    expect(r.px.resyncs).toHaveLength(1);
    expect(r.out.split("reply-1")).toHaveLength(2);
  });

  test("等新快照期间实时帧继续到达：不重复发 resync", async () => {
    // resync 延迟 400ms 才到 Server：这段时间 Server 还在推实时帧，它们先于新快照到达客户端。
    const r = await scenario((f, i) => (i === 3 ? [] : f), 400);
    expect(r.code).toBe(0);
    expect(r.px.resyncs).toHaveLength(1);
    expect(r.out.split("reply-1")).toHaveLength(2);
  });

  test("缺口期间整轮运行已结束：新快照显示空闲，EOF 仍能退出", async () => {
    // 丢一帧触发 resync，resync 延迟 1s 才到 Server，此时运行早已结束，owed 没有机会被事件减掉。
    const r = await scenario((f, i) => (i < 2 ? [] : f), 1000);
    expect(r.code).toBe(0);
    expect(r.px.resyncs).toHaveLength(1);
    expect(r.out).toContain("reply-1");
  });
});
