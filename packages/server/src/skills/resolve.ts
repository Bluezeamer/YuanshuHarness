import type { SkillMeta } from "../store/skills.js";

// 某会话应生效的 skill：agent 级名单在前、workspace 级在后，按名字去重；库里已不存在的名字单列。
export function resolveSkills(
  library: SkillMeta[],
  agentNames: string[],
  workspaceNames: string[],
): { skills: SkillMeta[]; missing: string[] } {
  const byName = new Map(library.map((s) => [s.name, s]));
  const skills: SkillMeta[] = [];
  const missing: string[] = [];
  for (const n of new Set([...agentNames, ...workspaceNames])) {
    const s = byName.get(n);
    if (s) skills.push(s);
    else missing.push(n);
  }
  return { skills, missing };
}
