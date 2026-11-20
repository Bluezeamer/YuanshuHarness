import { describe, expect, test } from "vitest";
import type { SkillRecord } from "../store/skills.js";
import { resolveSkills } from "./resolve.js";

const rec = (name: string, scope: "global" | "project", enabled = true) =>
  ({ name, scope, enabled }) as SkillRecord;

const names = (r: { skills: SkillRecord[] }) => r.skills.map((s) => s.name);

describe("resolveSkills", () => {
  const library = [
    rec("g-skill", "global"),
    rec("p-skill", "project"),
    rec("p-other", "project"),
    rec("g-off", "global", false),
  ];

  test("全局在前，agent 其次，workspace 在后，按名字去重", () => {
    const r = resolveSkills(library, ["p-skill", "g-skill"], ["p-other"]);
    expect(names(r)).toEqual(["g-skill", "p-skill", "p-other"]);
    expect(r.missing).toEqual([]);
  });

  test("没有名单时全局项仍生效", () => {
    expect(names(resolveSkills(library, [], []))).toEqual(["g-skill"]);
  });

  test("禁用的全局 skill 不生效", () => {
    expect(names(resolveSkills(library, [], []))).not.toContain("g-off");
  });

  test("missing 只含库里不存在的 agent / workspace 名字，不含全局", () => {
    const r = resolveSkills(library, ["gone-a"], ["gone-w"]);
    expect(names(r)).toEqual(["g-skill"]);
    expect(r.missing).toEqual(["gone-a", "gone-w"]);
  });
});
