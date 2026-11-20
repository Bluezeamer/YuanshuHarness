import { expect, test } from "vitest";
import type { JobInfo } from "../../../api";
import { visibleJobs } from "./jobs";

const T0 = Date.parse("2026-11-17T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const job = (id: string, over: Partial<JobInfo> = {}): JobInfo => ({
  id,
  sessionId: "s1",
  kind: "command",
  name: "bash",
  label: id,
  ref: null,
  state: "running",
  exitCode: null,
  remindMs: 0,
  input: "",
  startedAt: iso(T0),
  endedAt: null,
  ...over,
});

test("只列在跑的、按开始时间；结束的（无论成败）、子代理与工作流都不在这里", () => {
  const list = [
    job("late", { startedAt: iso(T0 + 5) }),
    job("early"),
    job("done", { state: "done", endedAt: iso(T0 + 1) }),
    job("failed", { state: "failed", exitCode: 1, endedAt: iso(T0 + 1) }),
    job("stopped", { state: "stopped", endedAt: iso(T0 + 1) }),
    job("cut", { state: "interrupted", endedAt: iso(T0 + 1) }),
    job("sub", { kind: "subagent", name: "spawn_subagent" }),
    job("wf", { kind: "tool", name: "workflow_run" }),
  ];
  expect(visibleJobs(list).map((j) => j.id)).toEqual(["early", "late"]);
});
