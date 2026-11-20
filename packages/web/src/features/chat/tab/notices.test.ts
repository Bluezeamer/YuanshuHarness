import { expect, test } from "vitest";
import type { GoalNotice, JobSnapshot } from "../../../api";
import { placeNotices } from "./notices";

const job = (id: string, endedAt: string): JobSnapshot => ({
  id,
  kind: "command",
  name: "bash",
  label: id,
  ref: null,
  state: "done",
  exitCode: 0,
  startedAt: "2026-11-17T08:00:00.000Z",
  endedAt,
});

const goal = (event: GoalNotice["event"], revision: number): GoalNotice => ({
  event,
  goalId: "g1",
  revision,
});

const idOf = (n: ReturnType<typeof placeNotices>[number]) =>
  n.kind === "job" ? n.job.id : `${n.goal.event}@${n.goal.revision}`;

test("实时到达的按窗口起点换算成绝对序位", () => {
  const live = [{ kind: "job" as const, at: 2, ts: "t1", job: job("a", "e1") }];
  expect(placeNotices([], live, 10).map((n) => [n.at, idOf(n)])).toEqual([
    [12, "a"],
  ]);
});

test("同一张卡（任务 + 终态时间）两边都有时以历史的为准，不重复", () => {
  const j = job("a", "e1");
  const placed = placeNotices(
    [{ kind: "job", afterIndex: 7, ts: "h", job: j }],
    [{ kind: "job", at: 2, ts: "l", job: j }],
    10,
  );
  expect(placed).toHaveLength(1);
  expect(placed[0]).toMatchObject({ at: 7, ts: "h" });
});

test("同一个任务重开后再结束是另一张卡", () => {
  const placed = placeNotices(
    [
      { kind: "job", afterIndex: 3, job: job("a", "e1") },
      { kind: "job", afterIndex: 9, job: job("a", "e2") },
    ],
    [],
    0,
  );
  expect(placed.map((n) => n.at)).toEqual([3, 9]);
});

test("按序位排，同一位置按时间", () => {
  const placed = placeNotices(
    [
      { kind: "job", afterIndex: 5, ts: "2", job: job("b", "e") },
      { kind: "job", afterIndex: 5, ts: "1", job: job("c", "e") },
      { kind: "job", afterIndex: 1, ts: "9", job: job("a", "e") },
    ],
    [],
    0,
  );
  expect(placed.map(idOf)).toEqual(["a", "c", "b"]);
});

test("目标卡与任务卡混排；同一目标同一事件同一版本只有一张，不同版本是两张", () => {
  const placed = placeNotices(
    [
      { kind: "goal", afterIndex: 4, ts: "h", goal: goal("paused", 3) },
      { kind: "job", afterIndex: 4, ts: "i", job: job("a", "e") },
      { kind: "goal", afterIndex: 8, ts: "j", goal: goal("paused", 6) },
    ],
    [
      { kind: "goal", at: 4, ts: "l", goal: goal("paused", 3) },
      { kind: "goal", at: 9, ts: "m", goal: goal("resumed", 7) },
    ],
    0,
  );
  expect(placed.map((n) => [n.at, idOf(n)])).toEqual([
    [4, "paused@3"],
    [4, "a"],
    [8, "paused@6"],
    [9, "resumed@7"],
  ]);
});
