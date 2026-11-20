import { expect, test } from "vitest";
import type { JobRow } from "../store/jobs.js";
import { interruptedNotice, reminderText, TEAM_MEMBER } from "./messages.js";

const row = (name: string, label: string): JobRow => ({
  id: "abc12345",
  sessionId: "s",
  kind: "subagent",
  name,
  label,
  input: "",
  ref: "child",
  state: "running",
  exitCode: null,
  remindMs: 600_000,
  told: false,
  startedAt: new Date(0).toISOString(),
  endedAt: null,
});

test("团队成员的提醒与中断通知指向 team_* 与 post，不再推荐被拒的 job_stop", () => {
  const member = row(TEAM_MEMBER, "alpha");
  const remind = reminderText(member, "", 1000, 1000);
  expect(remind).toContain('team_stop { "member": "alpha" }');
  expect(remind).toContain('post { "to": "alpha"');
  expect(remind).not.toContain("job_stop");
  const notice = interruptedNotice(member);
  expect(notice).toContain('post { "to": "alpha"');
  expect(notice).not.toContain("start it again");

  const plain = reminderText(row("spawn_subagent", "task"), "", 1000, 1000);
  expect(plain).toContain("job_stop to stop it");
  expect(interruptedNotice(row("spawn_subagent", "task"))).toContain(
    "start it again",
  );
});
