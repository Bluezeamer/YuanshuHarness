import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PROBE_MS } from "../../../api/foreground";
import { FakeSocket, pageView } from "./testkit";
import { usePageStream } from "./usePageStream";

const RETRY_MS = 3000;

// 画布 ref 必须每次渲染是同一个：换了它就会重连。
const canvas = () => createRef<HTMLCanvasElement>();

const mount = (pageId: string | null = "p1", maxRetries = 5) => {
  const ref = canvas();
  const h = renderHook(
    ({ pid }: { pid: string | null }) =>
      usePageStream("w", pid, ref, {
        open: (wid, page) =>
          new FakeSocket(`${wid}/${page}`) as unknown as WebSocket,
        retryMs: RETRY_MS,
        maxRetries,
      }),
    { initialProps: { pid: pageId } },
  );
  return { ...h, ref };
};

beforeEach(() => {
  FakeSocket.reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("pageId 为 null 不建连", () => {
  const h = mount(null);
  expect(FakeSocket.all).toHaveLength(0);
  expect(h.result.current.link).toBe("connecting");
});

test("state / console / error 三种文本帧：页面、控制台、提示（seq 递增）", () => {
  const { result } = mount();
  const sock = FakeSocket.last;
  act(() => sock.open());
  expect(result.current.link).toBe("live");
  act(() =>
    sock.serve({
      type: "state",
      page: pageView({ id: "p1", title: "文档" }),
      operator: true,
    }),
  );
  expect(result.current.page?.title).toBe("文档");
  expect(result.current.operator).toBe(true);

  act(() =>
    sock.serve({
      type: "console",
      entry: {
        id: 1,
        ts: 1,
        firstTs: 1,
        count: 1,
        kind: "console",
        level: "log",
        text: "hi",
      },
    }),
  );
  expect(result.current.console.map((c) => c.text)).toEqual(["hi"]);

  act(() => sock.serve({ type: "error", message: "操作失败" }));
  const first = result.current.notice;
  expect(first).toEqual({ text: "操作失败", seq: 1 });
  // 同样的文字再来一条：seq 递增，界面能重新提示
  act(() => sock.serve({ type: "error", message: "操作失败" }));
  expect(result.current.notice).toEqual({ text: "操作失败", seq: 2 });
  act(() => result.current.clearNotice());
  expect(result.current.notice).toBeNull();
});

test("copied 文本帧：记下选中的文字（seq 递增，同样的文字也能重新触发）；send.copy 发 copy", () => {
  const { result } = mount();
  const sock = FakeSocket.last;
  act(() => sock.open());
  expect(result.current.copied).toBeNull();
  act(() => result.current.send.copy());
  expect(sock.sent).toEqual([{ type: "copy" }]);
  act(() => sock.serve({ type: "copied", text: "划选的字" }));
  expect(result.current.copied).toEqual({ text: "划选的字", seq: 1 });
  act(() => sock.serve({ type: "copied", text: "划选的字" }));
  expect(result.current.copied).toEqual({ text: "划选的字", seq: 2 });
});

test("clipboard 文本帧：记下页面自己写剪贴板的内容（seq 递增），不与 copied 混用", () => {
  const { result } = mount();
  const sock = FakeSocket.last;
  act(() => sock.open());
  expect(result.current.pageCopy).toBeNull();
  act(() => sock.serve({ type: "clipboard", text: "https://x.example/s/1" }));
  expect(result.current.pageCopy).toEqual({
    text: "https://x.example/s/1",
    seq: 1,
  });
  expect(result.current.copied).toBeNull();
});

test("console 只保留最近 500 组，同一组再出现原地更新次数", () => {
  const { result } = mount();
  const sock = FakeSocket.last;
  act(() => sock.open());
  act(() => {
    for (let i = 0; i < 510; i++)
      sock.serve({
        type: "console",
        entry: {
          id: i,
          ts: i,
          firstTs: i,
          count: 1,
          kind: "console",
          level: "log",
          text: `n${i}`,
        },
      });
  });
  expect(result.current.console).toHaveLength(500);
  expect(result.current.console[0]?.text).toBe("n10");
  expect(result.current.console.at(-1)?.text).toBe("n509");
  act(() =>
    sock.serve({
      type: "console",
      entry: {
        id: 509,
        ts: 600,
        firstTs: 509,
        count: 7,
        kind: "console",
        level: "log",
        text: "n509",
      },
    }),
  );
  expect(result.current.console).toHaveLength(500);
  expect(result.current.console.at(-1)?.count).toBe(7);
});

test("closed：link 变 closed，之后断开也不重连", async () => {
  vi.useFakeTimers();
  const { result } = mount();
  const sock = FakeSocket.last;
  act(() => sock.open());
  act(() => sock.serve({ type: "closed" }));
  expect(result.current.link).toBe("closed");
  act(() => sock.drop());
  await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
  expect(FakeSocket.all).toHaveLength(1);
  expect(result.current.link).toBe("closed");
});

test("断线重连：按间隔新建连接，用尽后 lost；retry 重新连", async () => {
  vi.useFakeTimers();
  const { result } = mount("p1", 1);
  act(() => FakeSocket.last.open());
  act(() => FakeSocket.last.drop());
  expect(result.current.link).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  expect(FakeSocket.all).toHaveLength(2);
  act(() => FakeSocket.last.drop());
  expect(result.current.link).toBe("lost");
  act(() => result.current.retry());
  expect(result.current.link).toBe("connecting");
  expect(FakeSocket.all).toHaveLength(3);
});

test("重连成功后失败计数清零：之后再断仍可重连", async () => {
  vi.useFakeTimers();
  const { result } = mount("p1", 1);
  act(() => FakeSocket.last.open());
  act(() => FakeSocket.last.drop());
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  act(() => FakeSocket.last.open());
  act(() => FakeSocket.last.drop());
  expect(result.current.link).toBe("reconnecting");
});

// 先让合并窗口过去，再发信号。
const foreground = async () => {
  await act(() => vi.advanceTimersByTimeAsync(1000));
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
};
const pings = (sock: FakeSocket) => sock.sent.filter((m) => m.type === "ping");

test("回前台：连着就发 ping，回音到了不重连；没有回音就关掉旧连接并重连", async () => {
  vi.useFakeTimers();
  const { result } = mount();
  const first = FakeSocket.last;
  act(() => first.open());
  await foreground();
  await foreground();
  expect(pings(first)).toHaveLength(1);
  act(() => first.serve({ type: "pong" }));
  await act(() => vi.advanceTimersByTimeAsync(PROBE_MS * 2));
  expect(FakeSocket.all).toHaveLength(1);

  await foreground();
  expect(pings(first)).toHaveLength(2);
  await act(() => vi.advanceTimersByTimeAsync(PROBE_MS));
  expect(first.closed).toBe(true);
  expect(FakeSocket.all).toHaveLength(2);
  expect(result.current.link).toBe("connecting");
});

test("回前台：在退避里等着、或已经放弃的立即重连；首次连接没通、页面已关的不动", async () => {
  vi.useFakeTimers();
  const { result } = mount("p1", 1);
  await foreground();
  expect(FakeSocket.all).toHaveLength(1);

  act(() => FakeSocket.last.open());
  act(() => FakeSocket.last.drop());
  expect(result.current.link).toBe("reconnecting");
  await foreground();
  expect(FakeSocket.all).toHaveLength(2);

  // 回前台清零了失败计数：要再连续断两次才放弃
  act(() => FakeSocket.last.drop());
  await act(() => vi.advanceTimersByTimeAsync(RETRY_MS));
  act(() => FakeSocket.last.drop());
  expect(result.current.link).toBe("lost");
  const before = FakeSocket.all.length;
  await foreground();
  expect(FakeSocket.all).toHaveLength(before + 1);

  act(() => FakeSocket.last.open());
  act(() => FakeSocket.last.serve({ type: "closed" }));
  act(() => FakeSocket.last.drop());
  const total = FakeSocket.all.length;
  await foreground();
  expect(FakeSocket.all).toHaveLength(total);
  expect(result.current.link).toBe("closed");
});

test("换页面：关掉旧连接并清空页面、控制台与提示", () => {
  const { result, rerender } = mount();
  const first = FakeSocket.last;
  act(() => first.open());
  act(() =>
    first.serve({
      type: "state",
      page: pageView({ id: "p1" }),
      operator: true,
    }),
  );
  act(() =>
    first.serve({
      type: "console",
      entry: { ts: 1, kind: "console", level: "log", text: "hi" },
    }),
  );
  act(() => first.serve({ type: "error", message: "失败" }));
  rerender({ pid: "p2" });
  expect(first.closed).toBe(true);
  expect(FakeSocket.all).toHaveLength(2);
  expect(result.current.page).toBeNull();
  expect(result.current.console).toEqual([]);
  expect(result.current.notice).toBeNull();
  expect(result.current.operator).toBe(false);
  expect(result.current.link).toBe("connecting");
});

test("send.* 只在 live 时发出，内容是 StreamCommand 的 JSON", () => {
  const { result } = mount();
  const sock = FakeSocket.last;
  act(() =>
    result.current.send.input({ type: "key", action: "down", key: "a" }),
  );
  act(() => result.current.send.goto("https://example.org/"));
  expect(sock.sent).toEqual([]);

  act(() => sock.open());
  act(() =>
    result.current.send.input({ type: "key", action: "down", key: "a" }),
  );
  act(() => result.current.send.nav("back"));
  act(() => result.current.send.goto("https://example.org/"));
  act(() => result.current.send.take());
  expect(sock.sent).toEqual([
    { type: "input", event: { type: "key", action: "down", key: "a" } },
    { type: "nav", action: "back" },
    { type: "nav", action: "goto", target: "https://example.org/" },
    { type: "take" },
  ]);
});

test("不认识的文本帧与坏 JSON 忽略", () => {
  const { result } = mount();
  const sock = FakeSocket.last;
  act(() => sock.open());
  act(() => sock.serveText("不是 JSON"));
  act(() => sock.serve({ type: "nope" }));
  expect(result.current.page).toBeNull();
  expect(result.current.notice).toBeNull();
});

test("同尺寸的帧不重新赋 canvas 的宽高（赋值会清空位图）", async () => {
  vi.stubGlobal("createImageBitmap", async () => ({
    width: 640,
    height: 400,
    close() {},
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const ref = canvas();
  const el = document.createElement("canvas");
  ref.current = el;
  let widthWrites = 0;
  let heightWrites = 0;
  let w = 300;
  let h = 150;
  Object.defineProperty(el, "width", {
    get: () => w,
    set: (v: number) => {
      w = v;
      widthWrites += 1;
    },
  });
  Object.defineProperty(el, "height", {
    get: () => h,
    set: (v: number) => {
      h = v;
      heightWrites += 1;
    },
  });
  renderHook(() =>
    usePageStream("w", "p1", ref, {
      open: () => new FakeSocket("p1") as unknown as WebSocket,
      retryMs: RETRY_MS,
    }),
  );
  const sock = FakeSocket.last;
  act(() => sock.open());
  for (let i = 0; i < 3; i++) {
    act(() => sock.serveBytes(new Uint8Array([i])));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  expect([w, h]).toEqual([640, 400]);
  // 第一帧改了尺寸，之后两帧尺寸没变：只写一次
  expect([widthWrites, heightWrites]).toEqual([1, 1]);
});

test("每收到一帧画面就回一个确认，文本帧不回", () => {
  mount();
  const sock = FakeSocket.last;
  act(() => sock.open());
  act(() => sock.serve({ type: "error", message: "x" }));
  expect(sock.sent).toEqual([]);
  act(() => sock.serveBytes(new Uint8Array([1])));
  act(() => sock.serveBytes(new Uint8Array([2])));
  expect(sock.sent).toEqual([{ type: "ack" }, { type: "ack" }]);
});

test("二进制帧会触发绘制，且只画最新一帧", async () => {
  // jsdom 没有 createImageBitmap 与 canvas 2d：两个都换成替身。
  let resolveFirst: (bm: {
    width: number;
    height: number;
    close(): void;
  }) => void = () => {};
  const bitmap = vi.fn(
    (n: number) =>
      new Promise<{ width: number; height: number; close(): void }>((res) => {
        const bm = { width: n, height: n, close: vi.fn() };
        if (n === 1) resolveFirst = res;
        else res(bm);
      }),
  );
  let n = 0;
  vi.stubGlobal("createImageBitmap", () => {
    n += 1;
    return bitmap(n);
  });
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);

  // 画布要是真元素：hook 在解码完成后才去读 ref.current
  const ref = canvas();
  ref.current = document.createElement("canvas");
  renderHook(() =>
    usePageStream("w", "p1", ref, {
      open: () => new FakeSocket("p1") as unknown as WebSocket,
      retryMs: RETRY_MS,
    }),
  );
  const sock = FakeSocket.last;
  act(() => sock.open());
  act(() => sock.serveBytes(new Uint8Array([1])));
  act(() => sock.serveBytes(new Uint8Array([2])));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  // 第二帧先解码完画上；第一帧晚到，丢掉
  expect(drawImage).toHaveBeenCalledTimes(1);
  act(() => resolveFirst({ width: 1, height: 1, close: vi.fn() }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(ref.current?.width).toBe(2);
});
