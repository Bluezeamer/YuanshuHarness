import type { SkillRecord } from "../store/skills.js";

// 某会话应生效的 skill：全局在前、agent 级其次、workspace 级在后，按名字去重；库里已不存在的名字单列。
// 已禁用的 skill 退出能力集（不注入、不同步），但不算「不存在」，也不动环境里已有的文件。
export function resolveSkills(
  library: SkillRecord[],
  agentNames: string[],
  workspaceNames: string[],
): { skills: SkillRecord[]; missing: string[] } {
  const byName = new Map(library.map((s) => [s.name, s]));
  const globalNames = library
    .filter((s) => s.scope === "global")
    .map((s) => s.name);
  const skills: SkillRecord[] = [];
  const missing: string[] = [];
  for (const n of new Set([...globalNames, ...agentNames, ...workspaceNames])) {
    const s = byName.get(n);
    if (!s) missing.push(n);
    else if (s.enabled) skills.push(s);
  }
  return { skills, missing };
}
