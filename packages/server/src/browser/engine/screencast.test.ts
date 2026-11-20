import type { BrowserContext, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startScreencast } from "./screencast.js";

// 假的 CDP 会话：记录发出去的命令，能手动推一帧。
function fakeCdp() {
  const handlers = new Map<
    string,
    (p: { data: string; sessionId: number }) => void
  >();
  const sent: string[] = [];
  const cdp = {
    on: (
      name: string,
      fn: (p: { data: string; sessionId: number }) => void,
    ) => {
      handlers.set(name, fn);
    },
    send: vi.fn(async (name: string, args?: { sessionId?: number }) => {
      sent.push(
        args?.sessionId !== undefined ? `${name} #${args.sessionId}` : name,
      );
    }),
    detach: vi.fn(async () => {}),
  };
  const ctx = { newCDPSession: async () => cdp } as unknown as BrowserContext;
  const emit = (n: number) =>
    handlers.get("Page.screencastFrame")?.({
      data: Buffer.from(`frame-${n}`).toString("base64"),
      sessionId: n,
    });
  return { ctx, emit, sent };
}

const OPTS = { maxWidth: 1280, maxHeight: 800, maxFps: 10, quality: 60 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startScreencast 的帧节奏", () => {
  test("到的帧立刻交给 onFrame，不排在上一帧的 ack 间隔后面（否则发出去的全是过期画面）", async () => {
    const { ctx, emit } = fakeCdp();
    const got: string[] = [];
    await startScreencast(ctx, {} as Page, OPTS, (jpeg) => {
      got.push(jpeg.toString());
    });
    emit(1);
    await vi.advanceTimersByTimeAsync(0);
    emit(2);
    emit(3);
    // 间隔是 100ms，这时第一帧的 ack 刚发、第二帧的 ack 还在等
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual(["frame-1", "frame-2", "frame-3"]);
  });

  test("ack 之间至少隔 1/maxFps 秒，Chrome 在 ack 前不发下一帧，从而限帧", async () => {
    const { ctx, emit, sent } = fakeCdp();
    await startScreencast(ctx, {} as Page, OPTS, () => {});
    emit(1);
    emit(2);
    emit(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((s) => s.includes("Ack"))).toEqual([
      "Page.screencastFrameAck #1",
    ]);
    await vi.advanceTimersByTimeAsync(99);
    expect(sent.filter((s) => s.includes("Ack"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.filter((s) => s.includes("Ack"))).toEqual([
      "Page.screencastFrameAck #1",
      "Page.screencastFrameAck #2",
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.filter((s) => s.includes("Ack"))).toHaveLength(3);
  });

  test("onFrame 没做完就不 ack（慢消费者靠这个被限速）", async () => {
    const { ctx, emit, sent } = fakeCdp();
    let finish = () => {};
    await startScreencast(
      ctx,
      {} as Page,
      OPTS,
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    emit(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.filter((s) => s.includes("Ack"))).toEqual([]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((s) => s.includes("Ack"))).toEqual([
      "Page.screencastFrameAck #1",
    ]);
  });

  test("onFrame 抛错：这一帧丢掉，照常 ack，后面的帧不受影响", async () => {
    const { ctx, emit, sent } = fakeCdp();
    let n = 0;
    await startScreencast(ctx, {} as Page, OPTS, () => {
      n += 1;
      if (n === 1) throw new Error("ws closed");
    });
    emit(1);
    await vi.advanceTimersByTimeAsync(0);
    emit(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(n).toBe(2);
    expect(sent.filter((s) => s.includes("Ack"))).toHaveLength(2);
  });

  test("stop 之后不再交付也不再 ack", async () => {
    const { ctx, emit, sent } = fakeCdp();
    const got: string[] = [];
    const cast = await startScreencast(ctx, {} as Page, OPTS, (j) => {
      got.push(j.toString());
    });
    await cast.stop();
    emit(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(got).toEqual([]);
    expect(sent.filter((s) => s.includes("Ack"))).toEqual([]);
  });
});
