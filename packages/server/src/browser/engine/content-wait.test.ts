// content-wait 的等待规则：全部用假时钟，不碰浏览器（真浏览器里的行为在 scroll-wait.live.test.ts）。
import { describe, expect, test } from "vitest";
import {
  CAP_MS,
  type Clock,
  POLL_MS,
  PROBE_MS,
  pendingSince,
  QUIET_MS,
  waitForContent,
} from "./content-wait.js";
import type { NetworkEntry } from "./types.js";

/** 假时钟：sleep 就是把时刻往前拨，绝不真等。 */
function fakeClock() {
  let now = 0;
  const clock: Clock & { at(): number } = {
    at: () => now,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return clock;
}

/** 没有任何信号：没有新增、也没有在飞的请求。 */
const quiet = {
  added: async () => ({ count: 0, lastAt: 0 }),
  pending: () => 0,
};

describe("waitForContent", () => {
  test("一个信号都没有：PROBE 之前不返回，到点返回 none", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const end = await waitForContent(
      0,
      {
        added: async () => {
          seen.push(clock.at());
          return { count: 0, lastAt: 0 };
        },
        pending: () => 0,
      },
      clock,
    );
    expect(end).toBe("none");
    expect(clock.at()).toBe(PROBE_MS);
    // 一路都在看，不是等到底才看一眼。
    expect(seen.length).toBe(PROBE_MS / POLL_MS + 1);
  });

  test("有在飞的请求：请求 400ms 出现、900ms 结束，等它结束才返回", async () => {
    const clock = fakeClock();
    const end = await waitForContent(
      0,
      {
        ...quiet,
        pending: () => (clock.at() >= 400 && clock.at() < 900 ? 1 : 0),
      },
      clock,
    );
    expect(end).toBe("settled");
    expect(clock.at()).toBeGreaterThanOrEqual(900);
    expect(clock.at()).toBeLessThan(CAP_MS);
  });

  test("新增在 350ms 出现、之后不再新增：安静 QUIET 之后返回", async () => {
    const clock = fakeClock();
    const end = await waitForContent(
      0,
      {
        added: async () =>
          clock.at() >= 350
            ? { count: 1, lastAt: 350 }
            : { count: 0, lastAt: 0 },
        pending: () => 0,
      },
      clock,
    );
    expect(end).toBe("settled");
    // 只在轮询点上看得到，所以不会早于 550，也不会晚一个轮询周期以上。
    expect(clock.at()).toBeGreaterThanOrEqual(350 + QUIET_MS);
    expect(clock.at()).toBeLessThanOrEqual(350 + QUIET_MS + POLL_MS);
  });

  test("新增一直不停：到了 CAP 也返回", async () => {
    const clock = fakeClock();
    const end = await waitForContent(
      0,
      {
        added: async () => ({ count: 1, lastAt: clock.at() }),
        pending: () => 0,
      },
      clock,
    );
    expect(end).toBe("cap");
    expect(clock.at()).toBe(CAP_MS);
  });

  test("请求一直在飞：到了 CAP 返回", async () => {
    const clock = fakeClock();
    const end = await waitForContent(0, { ...quiet, pending: () => 1 }, clock);
    expect(end).toBe("cap");
    expect(clock.at()).toBe(CAP_MS);
  });

  test("信号在 PROBE 之后才出现：已经以 none 返回（已知局限）", async () => {
    const clock = fakeClock();
    const end = await waitForContent(
      0,
      {
        added: async () =>
          clock.at() >= 1000
            ? { count: 1, lastAt: clock.at() }
            : { count: 0, lastAt: 0 },
        pending: () => 0,
      },
      clock,
    );
    expect(end).toBe("none");
    expect(clock.at()).toBe(PROBE_MS);
  });

  test("added() 抛错当作没有新增：不抛，有请求照样等", async () => {
    const clock = fakeClock();
    const end = await waitForContent(
      0,
      {
        added: async () => {
          throw new Error("Execution context was destroyed.");
        },
        pending: () => (clock.at() < 600 ? 1 : 0),
      },
      clock,
    );
    expect(end).toBe("settled");
    expect(clock.at()).toBeGreaterThanOrEqual(600);

    // 读不到新增、也没有请求：跟没有信号一样。
    const other = fakeClock();
    expect(
      await waitForContent(
        0,
        {
          added: async () => {
            throw new Error("Target page, context or browser has been closed");
          },
          pending: () => 0,
        },
        other,
      ),
    ).toBe("none");
    expect(other.at()).toBe(PROBE_MS);
  });
});

describe("pendingSince", () => {
  const entry = (over: Partial<NetworkEntry>): NetworkEntry => ({
    id: 1,
    ts: 0,
    method: "GET",
    url: "https://a.test/x",
    type: "xhr",
    frame: "main",
    status: null,
    mime: "",
    size: null,
    ms: null,
    failure: null,
    ...over,
  });

  test("只算滚动开始之后发出、还没结束、也没失败的", () => {
    expect(pendingSince([entry({ ts: 100 })], 100)).toBe(1);
    expect(pendingSince([entry({ ts: 99 })], 100)).toBe(0); // 滚动之前发出的
    expect(pendingSince([entry({ ts: 200, ms: 5 })], 100)).toBe(0); // 已经结束
    expect(pendingSince([entry({ ts: 200, ms: 5, status: 200 })], 100)).toBe(0);
    expect(
      pendingSince([entry({ ts: 200, failure: "net::ERR_FAILED" })], 100),
    ).toBe(0);
    expect(pendingSince([], 100)).toBe(0);
  });

  test("WebSocket / EventSource / ping 不算，其它类型照算", () => {
    const list = [
      entry({ id: 1, ts: 200, type: "websocket" }),
      entry({ id: 2, ts: 200, type: "eventsource" }),
      entry({ id: 3, ts: 200, type: "ping" }),
      entry({ id: 4, ts: 200, type: "fetch" }),
      entry({ id: 5, ts: 200, type: "document" }),
    ];
    expect(pendingSince(list, 100)).toBe(2);
  });
});
