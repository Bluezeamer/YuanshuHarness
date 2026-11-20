import { describe, expect, test } from "vitest";
import { type DelegationInput, delegationSection } from "./delegation.js";

const agents = [
  { name: "coder", description: "Writes and edits code.\nUse for changes." },
  { name: "reviewer", description: "" },
];

const input = (o: Partial<DelegationInput>): DelegationInput => ({
  canSpawn: false,
  canTeam: false,
  canWorkflow: false,
  isSubagent: false,
  modeCount: 0,
  agents,
  ...o,
});

describe("「子代理与模式」内置段", () => {
  test("没有派发工具也没有模式：不生成", () => {
    expect(delegationSection(input({}))).toBeNull();
  });

  test("能派发：写明默认阻塞、并行、反轮询、fresh 与 fork，并列出可派发的 Agent（描述压成一行）", () => {
    const t = delegationSection(input({ canSpawn: true })) as string;
    expect(t).toContain("waits until the subagent delivers");
    expect(t).toContain("several spawn_subagent calls in the same message");
    expect(t).toContain("Do NOT poll");
    expect(t).toContain('context "fresh"');
    expect(t).toContain('context "fork"');
    expect(t).toContain("  - coder: Writes and edits code. Use for changes.");
    expect(t).toContain("  - reviewer\n".trimEnd());
    expect(t).not.toContain("switch_mode");
  });

  test("有模式：说明能切；能派发时再说明子代理继承模式、不能切", () => {
    const both = delegationSection(
      input({ canSpawn: true, modeCount: 2, agents: [] }),
    ) as string;
    expect(both).toContain("switch_mode");
    expect(both).toContain("cannot switch modes");
    expect(both).not.toContain("Agent definitions");
    const onlyModes = delegationSection(input({ modeCount: 1 })) as string;
    expect(onlyModes).toContain("switch_mode");
    expect(onlyModes).not.toContain("spawn_subagent");
  });

  test("子代理自己：不提切换模式，只说明继承", () => {
    const t = delegationSection(
      input({ canSpawn: true, isSubagent: true }),
    ) as string;
    expect(t).toContain("You are a subagent");
    expect(t).not.toContain("switch_mode changes");
  });

  test("能建团队：写明共享目录、成员不提交 git、公告不推给自己；成员（子代理）看不到这一段", () => {
    const t = delegationSection(input({ canTeam: true })) as string;
    expect(t).toContain("team_create");
    expect(t).toContain("no isolation");
    expect(t).toContain("never commit");
    expect(t).toContain("Board announcements are not pushed to you");
    expect(delegationSection(input({ canTeam: true, isSubagent: true }))).toBe(
      null,
    );
  });

  test("能跑工作流：点名 workflow_list 与 workflow_run 的 name", () => {
    const t = delegationSection(input({ canWorkflow: true })) as string;
    expect(t).toContain("workflow_run");
    expect(t).toContain("workflow_list");
    expect(t).toContain("name");
  });
});
