import { expect, test } from "vitest";
import { execCtxText, execElapsed, execStatus } from "./execModel";
import { exec } from "./testkit";

test("执行体展示：状态、读条文字、时长", () => {
  expect(execStatus(exec()).label).toBe("运行中");
  expect(execStatus(exec({ state: "idle" })).label).toBe("未激活");
  expect(execStatus(exec({ state: "done", outcome: "failed" })).tone).toBe(
    "failed",
  );
  expect(execCtxText(exec())).toBe("38k / 200k");
  expect(execCtxText(exec({ ctx: { used: 900, win: null } }))).toBe("900");
  const now = Date.parse("2026-10-25T00:02:05.000Z");
  expect(execElapsed(exec({ since: "2026-10-25T00:00:00.000Z" }), now)).toBe(
    "2 分 5 秒",
  );
  expect(execElapsed(exec({ state: "done" }), now)).toBeNull();
});
