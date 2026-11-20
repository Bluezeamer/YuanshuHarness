import { describe, expect, test } from "vitest";
import type { ReplaySession } from "../../../../api/browser";
import {
  indexAfterReload,
  nextIndex,
  pickSession,
  sessionName,
  stepClock,
} from "./replayModel";

const session = (sessionId: string): ReplaySession => ({
  sessionId,
  steps: 3,
  firstTs: "2026-11-12T08:00:00.000Z",
  lastTs: "2026-11-12T08:05:00.000Z",
});

describe("pickSession", () => {
  const list = [session("b"), session("a")];
  test("锚点会话有回放就看它", () => {
    expect(pickSession(list, "a")).toBe("a");
  });
  test("锚点没有回放或没有锚点：看列表第一个（最近有动作的）", () => {
    expect(pickSession(list, "zzz")).toBe("b");
    expect(pickSession(list, null)).toBe("b");
  });
  test("没有任何回放：null", () => {
    expect(pickSession([], "a")).toBeNull();
  });
});

test("sessionName：有标题用标题，否则用编号前 8 位", () => {
  const titles = new Map([["s1", "修登录"]]);
  expect(sessionName("s1", titles)).toBe("修登录");
  expect(sessionName("0123456789abcdef", titles)).toBe("01234567");
});

describe("stepClock", () => {
  test("本地时区的 HH:mm:ss", () => {
    const ts = new Date(2026, 10, 12, 9, 5, 7).toISOString();
    expect(stepClock(ts)).toBe("09:05:07");
  });
  test("解析失败给空串", () => {
    expect(stepClock("不是时间")).toBe("");
  });
});

describe("indexAfterReload", () => {
  test("第一次加载：最后一步", () => {
    expect(indexAfterReload(null, [1, 2, 3])).toBe(2);
    expect(indexAfterReload({ ids: [], index: 0 }, [1])).toBe(0);
  });
  test("原来在最后一步：跟到新的最后一步", () => {
    expect(
      indexAfterReload({ ids: [1, 2, 3], index: 2 }, [1, 2, 3, 4, 5]),
    ).toBe(4);
  });
  test("原来在中间：按步 id 找回原来那步（旧步被挤掉后序号会变）", () => {
    expect(
      indexAfterReload({ ids: [1, 2, 3, 4], index: 1 }, [2, 3, 4, 5]),
    ).toBe(0);
  });
  test("原来那步没了：停在最后", () => {
    expect(
      indexAfterReload({ ids: [1, 2, 3, 4], index: 0 }, [2, 3, 4, 5]),
    ).toBe(3);
  });
});

test("nextIndex：到头返回 null", () => {
  expect(nextIndex(0, 3)).toBe(1);
  expect(nextIndex(1, 3)).toBe(2);
  expect(nextIndex(2, 3)).toBeNull();
  expect(nextIndex(0, 0)).toBeNull();
});
