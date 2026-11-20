import { expect, test } from "vitest";
import { phase, wfRun } from "../exec/testkit";
import { phaseCounts, phaseLive, runEndText, visibleRuns } from "./workflow";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ended = (min: number, over = {}) =>
  wfRun({ state: "ok", ended: ago(min), ...over });

test("可见的运行：在跑的一直留着，结束不满 10 分钟的留着，更早的不再占右栏", () => {
  const runs = [
    wfRun({ id: "live" }),
    ended(2, { id: "fresh" }),
    ended(10, { id: "edge" }),
    ended(60, { id: "old" }),
    wfRun({ id: "no-time", state: "failed", ended: null }),
  ];
  expect(visibleRuns(runs, NOW).map((r) => r.id)).toEqual([
    "live",
    "fresh",
    "no-time",
  ]);
});

test("阶段在动：还有 agent 在跑或在排队", () => {
  expect(phaseLive(phase({ run: 1 }))).toBe(true);
  expect(phaseLive(phase({ queued: 3 }))).toBe(true);
  expect(phaseLive(phase({ done: 5, failed: 1 }))).toBe(false);
});

test("计数：已完成 · 运行中 · 排队，为 0 的不写；失败不在里面", () => {
  expect(phaseCounts(phase({ done: 3, run: 1, queued: 2, failed: 4 }))).toEqual(
    ["已完成 3", "运行中 1", "排队 2"],
  );
  expect(phaseCounts(phase({ queued: 7 }))).toEqual(["排队 7"]);
  expect(phaseCounts(phase({ failed: 2 }))).toEqual([]);
});

test("运行头右边的字：在跑不写，结束写多久之前，不成功的带结局", () => {
  expect(runEndText(wfRun(), NOW)).toBe("");
  expect(runEndText(ended(3), NOW)).toBe("3 分钟前");
  expect(runEndText(ended(3, { state: "failed" }), NOW)).toBe(
    "失败 · 3 分钟前",
  );
  expect(runEndText(ended(3, { state: "stopped" }), NOW)).toBe(
    "已停止 · 3 分钟前",
  );
  expect(runEndText(ended(3, { state: "interrupted" }), NOW)).toBe(
    "已中断 · 3 分钟前",
  );
  // 拿不到结束时间：只写结局，不留尾巴
  expect(runEndText(wfRun({ state: "failed", ended: null }), NOW)).toBe("失败");
});
