import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveToken } from "../../../../api/http";
import { type LinkTarget, RECONNECT_DELAYS, TerminalLink } from "./link";
import { bad, FakeSocket, ok, status } from "./testkit";
import type { LinkState } from "./types";

const api = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  getTerminal: vi.fn(),
  listTerminals: vi.fn(),
  openTerminalSocket: vi.fn(),
}));
vi.mock("../../../../api/terminals", () => api);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  sessionStorage.clear();
  saveToken("tok");
  api.openTerminalSocket.mockImplementation((id: string) => new FakeSocket(id));
  api.closeTerminal.mockResolvedValue(ok(undefined));
});
afterEach(() => {
  vi.useRealTimers();
  for (const f of Object.values(api)) f.mockReset();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

function make(target: Partial<LinkTarget> = {}) {
  const states: LinkState[] = [];
  const o = {
    target: (): LinkTarget => ({
      termId: undefined,
      termEnded: false,
      environmentId: "local",
      cwd: "/w",
      sessionId: "s1",
      workspaceId: "ws1",
      ...target,
    }),
    size: () => ({ cols: 100, rows: 30 }),
    patch: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    onState: (s: LinkState) => states.push(s),
  };
  const link = new TerminalLink(o);
  const last = () => states.at(-1);
  return { link, o, states, last };
}

test("有 id：按 id 接回，不创建；ready 后清屏并回放字节，尺寸一致时不发 resize", async () => {
  const { link, o, last } = make({ termId: "t-1" });
  link.start();
  expect(api.createTerminal).not.toHaveBeenCalled();
  expect(FakeSocket.last.id).toBe("t-1");
  expect(last()).toEqual({ kind: "connecting", stage: "attaching" });

  FakeSocket.last.serve({ type: "ready", cols: 100, rows: 30 });
  expect(o.reset).toHaveBeenCalledTimes(1);
  expect(last()).toEqual({ kind: "live" });
  FakeSocket.last.serveBytes(new TextEncoder().encode("hello"));
  expect(o.write).toHaveBeenCalledTimes(1);
  expect(FakeSocket.last.sent).toEqual([]);

  link.input("ls\r");
  link.resize(120, 40);
  expect(FakeSocket.last.sent).toEqual([
    { type: "input", data: "ls\r" },
    { type: "resize", cols: 120, rows: 40 },
  ]);
});

test("接回时服务端记的尺寸和窗口不一致：ready 后补发 resize", () => {
  const { link } = make({ termId: "t-1" });
  link.start();
  FakeSocket.last.serve({ type: "ready", cols: 80, rows: 24 });
  expect(FakeSocket.last.sent).toEqual([
    { type: "resize", cols: 100, rows: 30 },
  ]);
});

test("没有 id：首次创建，带环境/目录/尺寸/会话/工作区，写回 termId 后接回", async () => {
  api.createTerminal.mockResolvedValue(ok(status("t-new")));
  const { link, o } = make({ environmentId: "ssh-1", cwd: "/srv" });
  link.start();
  await flush();
  expect(api.createTerminal).toHaveBeenCalledWith("tok", {
    environmentId: "ssh-1",
    cwd: "/srv",
    cols: 100,
    rows: 30,
    sessionId: "s1",
    workspaceId: "ws1",
  });
  expect(o.patch).toHaveBeenCalledWith({ termId: "t-new", termEnded: false });
  expect(FakeSocket.last.id).toBe("t-new");
});

test("tab 已标记结束：只展示已结束态，不接回也不创建", async () => {
  const { link, last } = make({ termId: "t-1", termEnded: true });
  link.start();
  await flush();
  expect(last()).toEqual({ kind: "ended", reason: "gone", exitCode: null });
  expect(FakeSocket.all).toHaveLength(0);
  expect(api.createTerminal).not.toHaveBeenCalled();
});

test("接回时服务端已没有该终端（404）：标记结束，绝不新建 shell", async () => {
  api.getTerminal.mockResolvedValue(bad("not_found"));
  const { link, o, last } = make({ termId: "t-gone" });
  link.start();
  FakeSocket.last.drop(); // 握手被拒，随后浏览器触发 close
  await flush();
  expect(api.getTerminal).toHaveBeenCalledWith("tok", "t-gone");
  expect(o.patch).toHaveBeenCalledWith({ termEnded: true });
  expect(last()).toEqual({ kind: "ended", reason: "gone", exitCode: null });
  expect(api.createTerminal).not.toHaveBeenCalled();
  expect(FakeSocket.all).toHaveLength(1);
});

test("掉线但终端还在：退避后接回同一个 id，不创建；连上后计数清零", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1")));
  const { link, last } = make({ termId: "t-1" });
  link.start();
  FakeSocket.last.serve({ type: "ready", cols: 100, rows: 30 });

  FakeSocket.last.drop();
  await flush();
  expect(last()).toEqual({
    kind: "reconnecting",
    attempt: 1,
    max: RECONNECT_DELAYS.length,
  });
  await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS[0]);
  expect(FakeSocket.all).toHaveLength(2);
  expect(FakeSocket.last.id).toBe("t-1");

  FakeSocket.last.serve({ type: "ready", cols: 100, rows: 30 });
  expect(last()).toEqual({ kind: "live" });
  FakeSocket.last.drop();
  await flush();
  expect(last()).toMatchObject({ kind: "reconnecting", attempt: 1 });
  expect(api.createTerminal).not.toHaveBeenCalled();
});

test("重连用尽：进入 lost 而不是无限转圈，仍不创建；retry 接回同一个 id", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1")));
  const { link, last } = make({ termId: "t-1" });
  link.start();
  for (const delay of RECONNECT_DELAYS) {
    FakeSocket.last.drop();
    await flush();
    await vi.advanceTimersByTimeAsync(delay);
  }
  FakeSocket.last.drop();
  await flush();
  expect(last()).toEqual({ kind: "lost", attempts: RECONNECT_DELAYS.length });
  expect(FakeSocket.all).toHaveLength(RECONNECT_DELAYS.length + 1);
  expect(api.createTerminal).not.toHaveBeenCalled();

  link.retry();
  expect(FakeSocket.last.id).toBe("t-1");
  expect(last()).toEqual({ kind: "connecting", stage: "attaching" });
  expect(api.createTerminal).not.toHaveBeenCalled();
});

test("掉线后详情接口暂时不通：按无法判断处理，继续重连而不是判定结束", async () => {
  api.getTerminal.mockResolvedValue(bad("network"));
  const { link, last } = make({ termId: "t-1" });
  link.start();
  FakeSocket.last.drop();
  await flush();
  expect(last()).toMatchObject({ kind: "reconnecting", attempt: 1 });
});

test("shell 自己退出（exit 消息）：标记结束并带退出码", () => {
  const { link, o, last } = make({ termId: "t-1" });
  link.start();
  FakeSocket.last.serve({ type: "ready", cols: 100, rows: 30 });
  FakeSocket.last.serve({ type: "exit", exitCode: 3 });
  FakeSocket.last.drop();
  expect(o.patch).toHaveBeenCalledWith({ termEnded: true });
  expect(last()).toEqual({ kind: "ended", reason: "exit", exitCode: 3 });
  expect(api.getTerminal).not.toHaveBeenCalled();
});

test("重新打开：显式创建新终端，替换 termId 并清除 termEnded", async () => {
  api.createTerminal.mockResolvedValue(ok(status("t-2")));
  const { link, o, last } = make({ termId: "t-1", termEnded: true });
  link.start();
  expect(api.createTerminal).not.toHaveBeenCalled();
  link.reopen();
  await flush();
  expect(api.createTerminal).toHaveBeenCalledTimes(1);
  expect(o.patch).toHaveBeenCalledWith({ termId: "t-2", termEnded: false });
  expect(FakeSocket.last.id).toBe("t-2");
  expect(last()).toEqual({ kind: "connecting", stage: "attaching" });
});

test("创建遇到数量上限（429 无 Retry-After）：给出上限数，不接回任何终端", async () => {
  api.createTerminal.mockResolvedValue(
    bad("rate_limited", { retryAfter: null }),
  );
  api.listTerminals.mockResolvedValue(
    ok(Array.from({ length: 32 }, (_, i) => status(`t-${i}`))),
  );
  const { link, last } = make();
  link.start();
  await flush();
  expect(last()).toEqual({ kind: "failed", cause: "limit", max: 32 });
  expect(FakeSocket.all).toHaveLength(0);
});

test("创建遇到通用限流（带 Retry-After）：不当成数量上限", async () => {
  api.createTerminal.mockResolvedValue(bad("rate_limited", { retryAfter: 7 }));
  const { link, last } = make();
  link.start();
  await flush();
  expect(last()).toEqual({ kind: "failed", cause: "throttled", retryAfter: 7 });
  expect(api.listTerminals).not.toHaveBeenCalled();
});

test("创建失败后 retry：重走创建（没有存活 id，不会去接回旧 id）", async () => {
  api.createTerminal
    .mockResolvedValueOnce(bad("server"))
    .mockResolvedValueOnce(ok(status("t-9")));
  const { link, last } = make({ termId: "t-old", termEnded: true });
  link.start();
  link.reopen();
  await flush();
  expect(last()).toEqual({ kind: "failed", cause: "server" });
  link.retry();
  await flush();
  expect(api.createTerminal).toHaveBeenCalledTimes(2);
  expect(FakeSocket.last.id).toBe("t-9");
});

test("创建返回前已卸载：把刚建出的终端关掉，不留孤儿", async () => {
  api.createTerminal.mockResolvedValue(ok(status("t-late")));
  const { link, o } = make();
  link.start();
  link.dispose();
  await flush();
  expect(api.closeTerminal).toHaveBeenCalledWith("tok", "t-late");
  expect(o.patch).not.toHaveBeenCalled();
  expect(FakeSocket.all).toHaveLength(0);
});

test("卸载只断开连接，不关服务端终端，也不再重连", async () => {
  api.getTerminal.mockResolvedValue(ok(status("t-1")));
  const { link } = make({ termId: "t-1" });
  link.start();
  const sock = FakeSocket.last;
  link.dispose();
  expect(sock.closed).toBe(true);
  sock.drop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.closeTerminal).not.toHaveBeenCalled();
  expect(FakeSocket.all).toHaveLength(1);
});
