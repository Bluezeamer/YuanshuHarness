// manager 单测：订阅、空闲回收、站点审批逻辑。真实浏览器的完整测试在 live/ 里。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserDriver, Launcher, PageDriver } from "./driver.js";
import { BrowserManager, type BrowserOptions } from "./manager.js";

const noopPage = (): PageDriver => ({
  goto: async () => ({ status: 200 }),
  url: () => "http://example.test/",
  title: async () => "Test",
  loading: () => false,
  snapshot: async () => "snapshot text",
  click: async () => {},
  type: async () => {},
  screenshot: async () => Buffer.from("jpeg"),
  startScreencast: async () => {},
  stopScreencast: async () => {},
  onChange: () => {},
  takeBlocked: () => [],
  close: async () => {},
});

describe("BrowserManager", () => {
  let manager: BrowserManager;
  let driverMock: BrowserDriver;
  let pageMock: PageDriver;
  let launcher: Launcher;

  beforeEach(() => {
    pageMock = noopPage();
    driverMock = {
      newPage: vi.fn(async () => pageMock),
      close: vi.fn(async () => {}),
      onDisconnected: vi.fn(() => {}),
    };
    launcher = vi.fn(async () => driverMock);
    const opts: BrowserOptions = {
      launch: launcher,
      locate: () => "/fake/chromium",
      idleMs: 100,
      lingerMs: 50,
    };
    manager = new BrowserManager(opts);
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  test("未打开页面时状态是 inactive", () => {
    const s = manager.state("s1");
    expect(s.active).toBe(false);
  });

  test("打开页面成功，状态变 active", async () => {
    const navAllowed = (url: string) => url.startsWith("http://example.test");
    await manager.open("s1", "http://example.test/page", navAllowed);
    const s = manager.state("s1");
    expect(s.active).toBe(true);
    expect(s.url).toBe("http://example.test/");
  });

  test("snapshot 返回文本", async () => {
    const navAllowed = () => true;
    await manager.open("s1", "http://example.test/", navAllowed);
    const snap = await manager.snapshot("s1");
    expect(snap).toContain("snapshot text");
  });

  test("审批站点后记录在内存", () => {
    manager.approve("s1", "http://example.test/page");
    expect(manager.isApproved("s1", "http://example.test/other")).toBe(true);
    expect(manager.isApproved("s1", "http://other.test/")).toBe(false);
  });

  test("订阅后立刻收到当前状态", () => {
    const sub = { state: vi.fn(), frame: vi.fn() };
    manager.subscribe("s1", sub);
    expect(sub.state).toHaveBeenCalledWith(
      expect.objectContaining({ active: false }),
    );
  });

  test("取消订阅后不再收推送", async () => {
    const sub = { state: vi.fn(), frame: vi.fn() };
    const unsub = manager.subscribe("s1", sub);
    sub.state.mockClear();
    unsub();
    const navAllowed = () => true;
    await manager.open("s1", "http://example.test/", navAllowed);
    expect(sub.state).not.toHaveBeenCalled();
  });

  test("forget 清除审批记录与页面", async () => {
    manager.approve("s1", "http://example.test/");
    const navAllowed = () => true;
    await manager.open("s1", "http://example.test/", navAllowed);
    expect(manager.state("s1").active).toBe(true);
    await manager.forget("s1");
    expect(manager.state("s1").active).toBe(false);
    expect(manager.isApproved("s1", "http://example.test/")).toBe(false);
  });
  test("工具无操作超过 idleMs 后回收页面", async () => {
    await manager.open("s1", "http://example.test/", () => true);
    expect(manager.state("s1").active).toBe(true);
    await vi.waitFor(() => expect(manager.state("s1").active).toBe(false), {
      timeout: 1000,
    });
  });

  test("同一会话重复 open 复用同一个页面", async () => {
    await manager.open("s1", "http://example.test/a", () => true);
    await manager.open("s1", "http://example.test/b", () => true);
    expect(driverMock.newPage).toHaveBeenCalledTimes(1);
  });

  test("不同会话各有各的页面，释放一个不影响另一个", async () => {
    await manager.open("s1", "http://example.test/", () => true);
    await manager.open("s2", "http://example.test/", () => true);
    expect(driverMock.newPage).toHaveBeenCalledTimes(2);
    await manager.release("s1");
    expect(manager.state("s1").active).toBe(false);
    expect(manager.state("s2").active).toBe(true);
  });

  test("浏览器进程意外退出：全部页面作废并通知旁观者", async () => {
    const sub = { state: vi.fn(), frame: vi.fn() };
    manager.subscribe("s1", sub);
    await manager.open("s1", "http://example.test/", () => true);
    const onDisc = vi.mocked(driverMock.onDisconnected).mock.calls[0]?.[0];
    sub.state.mockClear();
    onDisc?.();
    expect(manager.state("s1").active).toBe(false);
    expect(sub.state).toHaveBeenCalledWith(
      expect.objectContaining({ active: false }),
    );
  });

  test("最后一个页面关掉后，浏览器进程在 lingerMs 后退出", async () => {
    await manager.open("s1", "http://example.test/", () => true);
    await manager.release("s1");
    expect(driverMock.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(driverMock.close).toHaveBeenCalled(), {
      timeout: 1000,
    });
  });

  test("找不到浏览器：给出安装提示，不尝试启动", async () => {
    const m = new BrowserManager({ launch: launcher, locate: () => null });
    expect(m.state("s1")).toMatchObject({ available: false });
    expect(m.state("s1").hint).toBeTruthy();
    await expect(
      m.open("s1", "http://example.test/", () => true),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(launcher).not.toHaveBeenCalled();
    await m.closeAll();
  });

  test("非 http(s) 地址被拒", async () => {
    await expect(
      manager.open("s1", "file:///etc/passwd", () => true),
    ).rejects.toMatchObject({ code: "bad_url" });
  });
});
