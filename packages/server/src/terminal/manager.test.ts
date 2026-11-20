import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExecEnv } from "../env/types.js";
import type { AuditLog } from "../store/audit.js";
import { openLocal, type PtyBackend } from "./backends.js";
import {
  TERMINAL_DEFAULTS,
  type TerminalClient,
  TerminalError,
  TerminalManager,
} from "./manager.js";

vi.mock("./backends.js", async (orig) => ({
  ...(await orig<typeof import("./backends.js")>()),
  openLocal: vi.fn(),
}));

// 假后端：记录对 pty 的操作，输出与退出由测试手动触发。
class FakeBackend implements PtyBackend {
  readonly pid = 1;
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  busy = vi.fn((): boolean | null => false);
  private dataCb: (chunk: Buffer) => void = () => {};
  private exitCb: (code: number | null) => void = () => {};
  onData(cb: (chunk: Buffer) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (code: number | null) => void) {
    this.exitCb = cb;
  }
  emit(data: string | number) {
    this.dataCb(
      typeof data === "number" ? Buffer.alloc(data, "x") : Buffer.from(data),
    );
  }
  exit(code: number | null) {
    this.exitCb(code);
  }
}

class FakeClient implements TerminalClient {
  received = "";
  send = vi.fn((chunk: Buffer) => {
    this.received += chunk.toString();
  });
  end = vi.fn();
}

const env = {
  id: "local",
  homedir: async () => "/home/u",
} as unknown as ExecEnv;
const req = { cols: 80, rows: 24 };

let backends: FakeBackend[];
beforeEach(() => {
  backends = [];
  vi.mocked(openLocal).mockImplementation(async () => {
    const b = new FakeBackend();
    backends.push(b);
    return b;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("生命周期（R1）：只有关闭、shell 退出、Server 停止才结束终端", () => {
  test("附着后断开，时间推进 1 小时仍存活、同 id，可重新附着并回放", async () => {
    vi.useFakeTimers();
    const m = new TerminalManager();
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;
    const c1 = new FakeClient();
    t.attach(c1);
    b.emit("hello\n");
    t.detach(c1);

    vi.advanceTimersByTime(60 * 60_000);

    expect(m.get(t.info.id)).toBe(t);
    expect(b.kill).not.toHaveBeenCalled();
    const c2 = new FakeClient();
    expect(t.attach(c2).toString()).toBe("hello\n");
    b.emit("more\n");
    expect(c2.received).toBe("more\n");
  });

  test("从未附着的终端同样不回收", async () => {
    vi.useFakeTimers();
    const m = new TerminalManager();
    const t = await m.create(env, req);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(m.list()).toEqual([t]);
    expect(backends[0]?.kill).not.toHaveBeenCalled();
  });

  test("shell 自己退出才结束，并通知附着的客户端", async () => {
    const m = new TerminalManager();
    const t = await m.create(env, req);
    const c = new FakeClient();
    t.attach(c);
    backends[0]?.exit(3);
    expect(c.end).toHaveBeenCalledWith("exit", 3);
    expect(m.get(t.info.id)).toBeUndefined();
  });
});

describe("流控（R3）：暂停读取而不是杀 shell", () => {
  test("无人附着时未读输出超过 scrollback 才暂停；attach 后恢复", async () => {
    const m = new TerminalManager(undefined, { scrollbackBytes: 1000 });
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;

    b.emit(600);
    expect(b.pause).not.toHaveBeenCalled();
    b.emit(600);
    expect(b.pause).toHaveBeenCalledTimes(1);
    expect(t.status().paused).toBe(true);
    b.emit(600); // 暂停前已在途的输出不会重复触发
    expect(b.pause).toHaveBeenCalledTimes(1);
    expect(b.kill).not.toHaveBeenCalled();

    t.attach(new FakeClient());
    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(t.status().paused).toBe(false);
    b.emit(5000); // 有人看着的输出不计入积压
    expect(b.pause).toHaveBeenCalledTimes(1);
  });

  test("最后一个客户端离开后，积压从零重新累计", async () => {
    const m = new TerminalManager(undefined, { scrollbackBytes: 1000 });
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;
    const c = new FakeClient();
    t.attach(c);
    b.emit(5000);
    t.detach(c);

    b.emit(1000);
    expect(b.pause).not.toHaveBeenCalled();
    b.emit(1);
    expect(b.pause).toHaveBeenCalledTimes(1);
  });

  test("客户端发送积压越过高水位暂停，降到低水位恢复", async () => {
    const m = new TerminalManager();
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;
    const c = new FakeClient();
    t.attach(c);

    t.congest(c, true);
    expect(b.pause).toHaveBeenCalledTimes(1);
    expect(t.status().paused).toBe(true);
    t.congest(c, false);
    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(t.status().paused).toBe(false);
    expect(b.kill).not.toHaveBeenCalled();
  });

  test("多客户端：任一端积压即暂停，全部追上才恢复", async () => {
    const m = new TerminalManager();
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;
    const [c1, c2] = [new FakeClient(), new FakeClient()];
    t.attach(c1);
    t.attach(c2);

    t.congest(c1, true);
    t.congest(c2, true);
    expect(b.pause).toHaveBeenCalledTimes(1);
    t.congest(c1, false);
    expect(b.resume).not.toHaveBeenCalled();
    t.congest(c2, false);
    expect(b.resume).toHaveBeenCalledTimes(1);
  });

  test("积压的客户端断开后恢复读取，终端与 shell 保留", async () => {
    const m = new TerminalManager();
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;
    const c = new FakeClient();
    t.attach(c);
    t.congest(c, true);

    t.detach(c);

    expect(b.resume).toHaveBeenCalledTimes(1);
    expect(m.get(t.info.id)).toBe(t);
    expect(b.kill).not.toHaveBeenCalled();
  });

  test("已断开的客户端迟到的积压报告被忽略", async () => {
    const m = new TerminalManager();
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;
    const c = new FakeClient();
    t.attach(c);
    t.detach(c);
    t.congest(c, true);
    expect(b.pause).not.toHaveBeenCalled();
  });

  test("暂停期间输入照常写入，显式关闭才杀 shell", async () => {
    const m = new TerminalManager(undefined, { scrollbackBytes: 10 });
    const t = await m.create(env, req);
    const b = backends[0] as FakeBackend;
    b.emit(100);
    expect(t.status().paused).toBe(true);

    t.input("ls\n");
    expect(b.write).toHaveBeenCalledWith("ls\n");
    expect(b.kill).not.toHaveBeenCalled();
    m.destroy(t.info.id);
    expect(b.kill).toHaveBeenCalledTimes(1);
  });
});

describe("列表与关闭（R5）", () => {
  test("状态含 id、环境、cwd、尺寸、附着数、创建时间、paused、busy", async () => {
    const m = new TerminalManager();
    const t = await m.create(env, { ...req, cwd: "/work" });
    const b = backends[0] as FakeBackend;
    t.attach(new FakeClient());
    t.resize(100, 30);
    b.busy.mockReturnValue(true);

    const s = t.status();
    expect(s).toEqual({
      id: t.info.id,
      environmentId: "local",
      cwd: "/work",
      cols: 100,
      rows: 30,
      attached: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      workspaceId: null,
      paused: false,
      busy: true,
    });
    expect(t.info.createdAt).toBe(s.createdAt);
    b.busy.mockReturnValue(null);
    expect(t.status().busy).toBeNull();
  });

  test("destroyWorkspace 只关该工作区的终端，返回关闭数", async () => {
    const m = new TerminalManager();
    const a = await m.create(env, { ...req, workspaceId: "ws1" });
    await m.create(env, { ...req, workspaceId: "ws1" });
    const c = await m.create(env, { ...req, workspaceId: "ws2" });
    expect(a.info.workspaceId).toBe("ws1");
    expect(m.destroyWorkspace("ws1")).toBe(2);
    expect(m.list().map((t) => t.info.id)).toEqual([c.info.id]);
    expect(m.destroyWorkspace("ws1")).toBe(0);
  });

  test("无人附着、也没有任何引用的终端仍在列表里，可关闭，关闭后消失", async () => {
    const m = new TerminalManager();
    const a = await m.create(env, req);
    const b = await m.create(env, req);
    expect(m.list().map((t) => t.info.id)).toEqual([a.info.id, b.info.id]);
    expect(m.list().map((t) => t.status().attached)).toEqual([0, 0]);

    expect(m.destroy(a.info.id)).toBe(true);
    expect(backends[0]?.kill).toHaveBeenCalledTimes(1);
    expect(m.get(a.info.id)).toBeUndefined();
    expect(m.destroy(a.info.id)).toBe(false);
    expect(m.list()).toEqual([b]);
  });
});

describe("数量上限（R7）", () => {
  test("默认上限为 32，超过抛 too_many_terminals", async () => {
    expect(TERMINAL_DEFAULTS.max).toBe(32);
    const m = new TerminalManager();
    for (let i = 0; i < 32; i++) await m.create(env, req);
    await expect(m.create(env, req)).rejects.toMatchObject({
      code: "too_many_terminals",
    });
  });

  test("配置的上限生效；提示带当前上限和可操作的建议；关掉一个后可再建", async () => {
    const m = new TerminalManager(undefined, { max: 2 });
    const first = await m.create(env, req);
    await m.create(env, req);
    const err = await m.create(env, req).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect(err.code).toBe("too_many_terminals");
    expect(err.message).toContain("2");
    expect(err.message).toContain("关闭");

    m.destroy(first.info.id);
    await expect(m.create(env, req)).resolves.toBeDefined();
  });
});

describe("审计", () => {
  test("关闭原因只有 user / exit / shutdown", async () => {
    const record = vi.fn();
    const m = new TerminalManager({ record } as unknown as AuditLog);
    const [a, , c] = [
      await m.create(env, req),
      await m.create(env, req),
      await m.create(env, req),
    ];
    m.destroy(a.info.id);
    backends[1]?.exit(0);
    m.closeAll();

    const reasons = record.mock.calls
      .map(([e]) => e.detail)
      .filter((d) => d.op === "close")
      .map((d) => [d.terminalId, d.reason]);
    expect(reasons).toEqual([
      [a.info.id, "user"],
      [expect.any(String), "exit"],
      [c.info.id, "shutdown"],
    ]);
  });
});
