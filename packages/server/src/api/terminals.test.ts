import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import WebSocket from "ws";
import { waitFor } from "../../test/support/frames.js";
import { hasSshd, startSshd, type TestSshd } from "../../test/support/sshd.js";
import { createServer, type YuanshuServer } from "../server.js";
import type { TerminalOptions, TerminalStatus } from "../terminal/manager.js";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

// 终端流客户端：文本帧是控制消息，二进制帧是终端原始输出。
class TermClient {
  readonly controls: Array<Record<string, unknown>> = [];
  output = "";
  closed: number | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) this.output += raw.toString("utf8");
      else this.controls.push(JSON.parse(raw.toString()));
    });
    ws.on("close", (code) => {
      this.closed = code;
    });
  }

  static async connect(url: string, protocols?: string[]): Promise<TermClient> {
    const ws = new WebSocket(url, protocols);
    const c = new TermClient(ws);
    await new Promise<void>((ok, fail) => {
      ws.once("open", () => ok());
      ws.once("error", fail);
      ws.once("unexpected-response", (_q, res) =>
        fail(new Error(`HTTP ${res.statusCode}`)),
      );
    });
    return c;
  }

  input(data: string) {
    this.ws.send(JSON.stringify({ type: "input", data }));
  }
  resize(cols: number, rows: number) {
    this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
  // 超时时带上终端输出的末尾：CI 上失败时看不到现场，只有「等待超时」没法判断是慢还是内容不对
  async seen(re: RegExp, label: string) {
    try {
      await waitFor(() => re.test(this.output), label, 10_000);
    } catch (err) {
      const tail = JSON.stringify(this.output.slice(-400));
      throw new Error(`${(err as Error).message}（输出末尾 ${tail}）`);
    }
  }
  close() {
    this.ws.terminate();
  }
}

let sshd: TestSshd | null = null;
beforeAll(async () => {
  if (hasSshd) sshd = await startSshd();
});
afterAll(() => sshd?.close());

describe.each([
  ["local", true],
  ["ssh", hasSshd],
])("终端（%s 环境）", (kind, enabled) => {
  let base: string;
  let work: string;
  let server: YuanshuServer;
  let http: string;
  let ws: string;
  let envId: string;
  const clients: TermClient[] = [];
  let seq = 0;

  async function launch(
    terminals: Partial<TerminalOptions> = {},
    extra: { maxTerminals?: number; maxBufferedBytes?: number } = {},
  ) {
    server = createServer(
      {
        host: "127.0.0.1",
        port: 0,
        dataDir: path.join(base, `data${seq++}`),
        token: TOKEN,
        allowCidrs: [],
        ...(extra.maxTerminals === undefined
          ? {}
          : { maxTerminals: extra.maxTerminals }),
      },
      {
        webRoot: path.join(base, "web"),
        terminals,
        ...(extra.maxBufferedBytes === undefined
          ? {}
          : { tuning: { maxBufferedBytes: extra.maxBufferedBytes } }),
      },
    );
    const addr = await server.start();
    http = `http://127.0.0.1:${addr.port}`;
    ws = `ws://127.0.0.1:${addr.port}`;
    envId = "local";
    if (kind === "ssh" && sshd) {
      const key = await api("POST", "/api/v1/secrets", {
        name: "k",
        kind: "ssh_key",
        value: sshd.privateKey,
      });
      const env = await api("POST", "/api/v1/environments", {
        name: "t",
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        os: "posix",
        secretId: ((await key.json()) as { id: string }).id,
      });
      envId = ((await env.json()) as { id: string }).id;
    }
  }

  const api = (method: string, url: string, body?: unknown) =>
    fetch(http + url, {
      method,
      headers: {
        ...auth,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const create = (over: Record<string, unknown> = {}) =>
    api("POST", "/api/v1/terminals", {
      environmentId: envId,
      cols: 80,
      rows: 24,
      cwd: work,
      ...over,
    });

  const attach = async (id: string) => {
    const c = await TermClient.connect(`${ws}/api/v1/terminals/${id}/stream`, [
      "yuanshu.v1",
      `bearer.${TOKEN}`,
    ]);
    clients.push(c);
    await waitFor(() => c.controls.length > 0, "ready 帧");
    return c;
  };

  const list = async () =>
    (
      (await (await api("GET", "/api/v1/terminals")).json()) as {
        terminals: TerminalStatus[];
      }
    ).terminals;
  const detail = async (id: string) =>
    (await (
      await api("GET", `/api/v1/terminals/${id}`)
    ).json()) as TerminalStatus;

  // 异步条件轮询；waitFor 只收同步条件。
  async function until(
    cond: () => Promise<boolean>,
    what: string,
    timeoutMs = 15_000,
  ) {
    const start = Date.now();
    while (!(await cond())) {
      if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // 开一个终端并连上流。
  const open = async (over: Record<string, unknown> = {}) => {
    const r = await create(over);
    expect(r.status).toBe(201);
    const info = (await r.json()) as { id: string };
    return { id: info.id, c: await attach(info.id) };
  };

  beforeAll(() => {
    if (!enabled) return;
    base = mkdtempSync(path.join(tmpdir(), "yuanshu-term-"));
    mkdirSync(path.join(base, "web"));
    writeFileSync(path.join(base, "web", "index.html"), "<title>x</title>");
  });
  afterAll(() => {
    if (enabled) rmSync(base, { recursive: true, force: true });
  });
  beforeEach(() => {
    if (enabled) work = realpathSync(mkdtempSync(path.join(base, "w-")));
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server?.stop().catch(() => {});
  });

  describe.skipIf(!enabled)("基本", () => {
    test("创建、回显与 cwd：命令输出可读，起始目录是请求的 cwd", async () => {
      await launch();
      const r = await create();
      expect(r.status).toBe(201);
      const info = (await r.json()) as { id: string };
      expect(info).toMatchObject({
        environmentId: envId,
        cwd: work,
        cols: 80,
        rows: 24,
      });
      const c = await attach(info.id);
      expect(c.controls[0]).toEqual({
        type: "ready",
        id: info.id,
        cols: 80,
        rows: 24,
      });
      c.input("echo A$((6*7))B; pwd\n");
      await c.seen(/A42B/, "echo 输出");
      await c.seen(new RegExp(`\\n${work}\\r?\\n`), "pwd 输出");
    });

    test("resize 改变 pty 窗口大小", async () => {
      await launch();
      const { c } = await open();
      c.resize(100, 30);
      c.input("stty size\n");
      await c.seen(/\b30 100\b/, "stty size");
    });

    test("断线保留并重连回放，之后继续可交互", async () => {
      await launch();
      const { id, c } = await open();
      c.input("echo MARK$((1+1))\n");
      await c.seen(/MARK2/, "首次输出");
      c.close();
      await waitFor(() => c.closed !== null, "断开");
      const again = await attach(id);
      await again.seen(/MARK2/, "回放");
      again.input("echo AFTER$((2+2))\n");
      await again.seen(/AFTER4/, "重连后输出");
    });

    test("shell 退出：推送 exit 帧与退出码并以 1000 关闭，终端随之消失", async () => {
      await launch();
      const { id, c } = await open();
      c.input("exit 3\n");
      await waitFor(() => c.closed !== null, "关闭");
      expect(c.controls).toContainEqual({ type: "exit", exitCode: 3 });
      expect(c.closed).toBe(1000);
      expect((await api("DELETE", `/api/v1/terminals/${id}`)).status).toBe(404);
    });

    test("DELETE 回收：连接以 1000 关闭，shell 进程消失，再删得 404", async () => {
      await launch();
      const { id, c } = await open();
      c.input("echo PID$$X\n");
      await c.seen(/PID\d+X/, "pid");
      const pid = Number(/PID(\d+)X/.exec(c.output)?.[1]);
      expect((await api("DELETE", `/api/v1/terminals/${id}`)).status).toBe(204);
      await waitFor(() => c.closed !== null, "关闭");
      expect(c.closed).toBe(1000);
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, "shell 进程退出");
      expect((await api("DELETE", `/api/v1/terminals/${id}`)).status).toBe(404);
    });

    test("无人连接不回收：断开后列表仍在，重新附着回放且可继续交互", async () => {
      await launch();
      const { id, c } = await open();
      c.input("echo KEEP$((3+4))\n");
      await c.seen(/KEEP7/, "输出");
      c.close();
      await waitFor(() => c.closed !== null, "断开");
      await until(async () => (await detail(id)).attached === 0, "附着数归零");
      expect((await api("GET", `/api/v1/terminals/${id}`)).status).toBe(200);
      const again = await attach(id);
      await again.seen(/KEEP7/, "回放");
    });

    test("数量上限：超过得 429，关掉一个后又可创建；并发创建不会冲过上限", async () => {
      await launch({ max: 2 });
      const rs = await Promise.all([create(), create(), create()]);
      expect(rs.map((r) => r.status).sort()).toEqual([201, 201, 429]);
      const ok = (await Promise.all(
        rs.filter((r) => r.status === 201).map((r) => r.json()),
      )) as Array<{ id: string }>;
      const full = (await rs.find((r) => r.status === 429)?.json()) as {
        error: string;
        message: string;
      };
      expect(full.error).toBe("too_many_terminals");
      expect(full.message).toContain("2");
      expect(full.message).toContain("关闭");
      await api("DELETE", `/api/v1/terminals/${ok[0]?.id}`);
      expect((await create()).status).toBe(201);
    });

    test("上限可由 Server 配置（maxTerminals）指定", async () => {
      await launch({}, { maxTerminals: 1 });
      expect((await create()).status).toBe(201);
      const r = await create();
      expect(r.status).toBe(429);
      expect(((await r.json()) as { message: string }).message).toContain("1");
    });

    test("开关写审计（kind=terminal，不含输入输出）", async () => {
      await launch();
      const { id, c } = await open();
      c.input("echo SECRET$((1+1))\n");
      await c.seen(/SECRET2/, "输出");
      await api("DELETE", `/api/v1/terminals/${id}`);
      const j = (await (
        await api("GET", "/api/v1/audit?kind=terminal")
      ).json()) as {
        entries: Array<{
          actor: string;
          sessionId: string | null;
          environmentId: string;
          detail: Record<string, unknown>;
        }>;
      };
      const ops = j.entries.map((e) => e.detail.op).sort();
      expect(ops).toEqual(["close", "open"]);
      expect(j.entries.every((e) => e.environmentId === envId)).toBe(true);
      expect(
        j.entries.every(
          (e) =>
            e.detail.result === "ok" && typeof e.detail.durationMs === "number",
        ),
      ).toBe(true);
      expect(j.entries.every((e) => e.sessionId === null)).toBe(true);
      expect(JSON.stringify(j)).not.toContain("SECRET");
      expect(
        j.entries.find((e) => e.detail.op === "close")?.detail.reason,
      ).toBe("user");
    });

    test("带 workspaceId 的终端：列表里可见；工作区不存在 404", async () => {
      await launch();
      const ws = await api("POST", "/api/v1/workspaces", {
        directories: [{ path: work }],
      });
      expect(ws.status).toBe(201);
      const workspaceId = ((await ws.json()) as { id: string }).id;
      const made = await create({ workspaceId });
      expect(made.status).toBe(201);
      expect(((await made.json()) as { workspaceId: string }).workspaceId).toBe(
        workspaceId,
      );
      expect((await list()).map((t) => t.workspaceId)).toEqual([workspaceId]);
      const missing = await create({ workspaceId: "nope" });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toBe(
        "workspace_not_found",
      );
    });

    test("带 sessionId 的终端开关归属到该会话", async () => {
      await launch();
      const { id } = (await (await create({ sessionId: "term-9" })).json()) as {
        id: string;
      };
      await api("DELETE", `/api/v1/terminals/${id}`);
      const ops = async () =>
        (
          (await (await api("GET", "/api/v1/audit?session=term-9")).json()) as {
            entries: Array<{ sessionId: string; detail: { op: string } }>;
          }
        ).entries.map((e) => [e.detail.op, e.sessionId]);
      for (let i = 0; i < 100 && (await ops()).length < 2; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(await ops()).toEqual([
        ["close", "term-9"],
        ["open", "term-9"],
      ]);
    });

    test("Server 停止时回收全部终端", async () => {
      await launch();
      const { c } = await open();
      c.input("echo PID$$X\n");
      await c.seen(/PID\d+X/, "pid");
      const pid = Number(/PID(\d+)X/.exec(c.output)?.[1]);
      await server.stop();
      await waitFor(() => c.closed !== null, "关闭");
      expect(c.closed).toBe(1001);
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, "shell 进程退出");
    });

    test("请求校验：尺寸、环境、cwd", async () => {
      await launch();
      const bad = async (over: Record<string, unknown>) =>
        (await create(over)).status;
      expect(await bad({ cols: 0 })).toBe(400);
      expect(await bad({ rows: 501 })).toBe(400);
      expect(await bad({ cols: 1.5 })).toBe(400);
      expect(await bad({ environmentId: 7 })).toBe(400);
      expect(await bad({ environmentId: "nope" })).toBe(404);
      expect(await bad({ cwd: "relative/dir" })).toBe(400);
      expect(await bad({ cwd: path.join(work, "none") })).toBe(404);
      writeFileSync(path.join(work, "f"), "x");
      expect(await bad({ cwd: path.join(work, "f") })).toBe(400);
    });

    test("不带 cwd 时进入环境的 home", async () => {
      await launch();
      const r = await api("POST", "/api/v1/terminals", {
        environmentId: envId,
        cols: 80,
        rows: 24,
      });
      expect(r.status).toBe(201);
      const info = (await r.json()) as { id: string; cwd: string };
      expect(path.isAbsolute(info.cwd)).toBe(true);
      const c = await attach(info.id);
      // 用标记夹住 pwd 的输出：有的发行版的 shell 会在提示符前后插 OSC 转义序列，不能指望路径独占一行
      c.input("echo HOME_BEGIN; pwd -P; echo HOME_END\n");
      await c.seen(
        new RegExp(`HOME_BEGIN\\r?\\n${realpathSync(info.cwd)}\\r?\\nHOME_END`),
        `home 目录 ${info.cwd}`,
      );
    });

    test("非法 WS 消息得 error 帧，连接保持可用", async () => {
      await launch();
      const { c } = await open();
      c.ws.send("not json");
      c.ws.send(JSON.stringify({ type: "resize", cols: -1, rows: 5 }));
      await waitFor(
        () => c.controls.filter((m) => m.type === "error").length === 2,
        "两个 error 帧",
      );
      c.input("echo OK$((1+1))\n");
      await c.seen(/OK2/, "仍可输入");
    });

    test("回放缓冲只保留最近 N 字节", async () => {
      await launch({ scrollbackBytes: 2048 });
      const { id, c } = await open();
      c.input("yes line | head -n 5000; echo END$((1+1))\n");
      await c.seen(/END2/, "大量输出结束");
      c.close();
      await waitFor(() => c.closed !== null, "断开");
      const again = await attach(id);
      await waitFor(() => /END2/.test(again.output), "回放尾部");
      expect(Buffer.byteLength(again.output)).toBeLessThanOrEqual(2048 + 16);
    });
  });

  describe.skipIf(!enabled)("列表、详情与流控", () => {
    test("列表与详情字段齐全；失去引用的终端可见可关，关闭后详情 404", async () => {
      await launch();
      const created = (await (await create()).json()) as Record<
        string,
        unknown
      >;
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      const idle = created.id as string;
      const { id: watched } = await open();
      const busy = kind === "local" ? false : null;
      await until(
        async () => (await detail(watched)).busy === busy,
        "busy 初值",
      );

      const items = await list();
      expect(items.map((t) => t.id)).toEqual([idle, watched]);
      const base = {
        environmentId: envId,
        cwd: work,
        cols: 80,
        rows: 24,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        workspaceId: null,
        paused: false,
        busy,
      };
      expect(items[1]).toEqual({ ...base, id: watched, attached: 1 });
      expect(await detail(idle)).toMatchObject({ id: idle, attached: 0 });

      expect((await api("DELETE", `/api/v1/terminals/${idle}`)).status).toBe(
        204,
      );
      expect((await api("GET", `/api/v1/terminals/${idle}`)).status).toBe(404);
      expect((await list()).map((t) => t.id)).toEqual([watched]);
      expect((await api("GET", "/api/v1/terminals/nope")).status).toBe(404);
    });

    test.skipIf(kind !== "local")("busy 随前台进程变化", async () => {
      await launch();
      const { id, c } = await open();
      await until(async () => (await detail(id)).busy === false, "空闲");
      c.input("sleep 30\n");
      await until(async () => (await detail(id)).busy === true, "前台有进程");
      c.input("\x03");
      await until(async () => (await detail(id)).busy === false, "回到空闲");
    });

    test("无人附着输出过量：暂停读取但不杀 shell；附着后恢复并跑完", async () => {
      await launch({ scrollbackBytes: 2048 });
      const { id, c } = await open();
      c.input(
        "echo S$((1+1)); sleep 1; yes line | head -n 100000; echo END$((2+2))\n",
      );
      await c.seen(/S2/, "起始标记");
      c.close();
      await waitFor(() => c.closed !== null, "断开");
      await until(async () => (await detail(id)).paused, "暂停");

      const again = await attach(id);
      await again.seen(/END4/, "恢复后输出跑完");
      await until(async () => !(await detail(id)).paused, "恢复");
      again.input("echo OK$((5+5))\n");
      await again.seen(/OK10/, "shell 仍可交互");
    }, 30_000);

    test("慢客户端：积压过半暂停读取，追上后恢复；连接与 shell 都保留", async () => {
      await launch({}, { maxBufferedBytes: 1024 * 1024 });
      const { id, c } = await open();
      // 只在末尾留一小段，避免对几十 MB 的输出反复跑正则。
      let tail = "";
      c.ws.on("message", (raw: Buffer, isBinary: boolean) => {
        if (isBinary) tail = (tail + raw.toString("utf8")).slice(-200);
      });
      const sock = (
        c.ws as unknown as { _socket: { pause(): void; resume(): void } }
      )._socket;
      c.input(
        "echo S$((1+1)); sleep 1; yes line | head -c 8000000; echo END$((2+2))\n",
      );
      await c.seen(/S2/, "起始标记");
      sock.pause();

      await until(async () => (await detail(id)).paused, "积压暂停", 20_000);
      expect(c.closed).toBeNull();

      sock.resume();
      await waitFor(() => tail.includes("END4"), "追上后输出跑完", 25_000);
      await until(async () => !(await detail(id)).paused, "恢复");
      expect(c.closed).toBeNull();
    }, 60_000);
  });

  describe.skipIf(!enabled)("认证", () => {
    test("无令牌：POST、GET、DELETE、WS 升级都得 401", async () => {
      await launch();
      const { id } = await open();
      const no = (method: string, p: string, body?: unknown) =>
        fetch(http + p, {
          method,
          ...(body
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        });
      expect(
        (
          await no("POST", "/api/v1/terminals", {
            environmentId: envId,
            cols: 80,
            rows: 24,
          })
        ).status,
      ).toBe(401);
      expect((await no("GET", "/api/v1/terminals")).status).toBe(401);
      expect((await no("GET", `/api/v1/terminals/${id}`)).status).toBe(401);
      expect((await no("DELETE", `/api/v1/terminals/${id}`)).status).toBe(401);
      await expect(
        TermClient.connect(`${ws}/api/v1/terminals/${id}/stream`),
      ).rejects.toThrow("HTTP 401");
      await expect(
        TermClient.connect(`${ws}/api/v1/terminals/${id}/stream`, [
          "yuanshu.v1",
          "bearer.wrong",
        ]),
      ).rejects.toThrow("HTTP 401");
    });

    test("不存在的终端：升级前得 404", async () => {
      await launch();
      await expect(
        TermClient.connect(`${ws}/api/v1/terminals/nope/stream`, [
          "yuanshu.v1",
          `bearer.${TOKEN}`,
        ]),
      ).rejects.toThrow("HTTP 404");
    });
  });
});
