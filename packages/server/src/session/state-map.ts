// 状态映射（prompt-delivery.md §3.3）：状态 = 「槽位 → 值」。
// 槽位：tools（启用的工具名）、prompt（我们生成的系统段，不含 AGENTS.md）、mode（当前模式与设定）、skills（生效的技能与描述）。
// 冻结物与每条状态通知都带完整映射；通知正文只写与「最近一份承载者」相比有差异的槽。

export interface ModeState {
  id: string;
  name: string;
  /** 模式提示词正文（用户写的卡片，按原文发） */
  text: string;
  /** 标成 user 通道的段，并入进入通知 */
  userText: string;
}

export interface StateMapping {
  /** 启用的工具名（含框架工具），已排序 */
  tools: string[];
  /** 槽位 → 文本；身份在 "identity"，其余按段名 */
  prompt: Record<string, string>;
  mode: ModeState | null;
  /**
   * 会话此刻生效的技能：名字 → 描述（全局 ∪ Agent 基线 ∪ 工作区勾选，不含已禁用与同步失败的）。
   * 只记「有哪些」，不记路径（路径随当前所在主机变，换目录不该触发通知）。
   * 这一栏出现之前写下的冻结物与通知没有它，按空算。
   */
  skills?: Record<string, string>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters?: unknown;
}

export const STATE_TYPE = "yuanshu.state";

const modeKey = (m: ModeState | null) =>
  m === null ? "" : JSON.stringify([m.id, m.text, m.userText]);

const skillsOf = (m: StateMapping): Record<string, string> => m.skills ?? {};

export function sameState(a: StateMapping, b: StateMapping): boolean {
  return (
    a.tools.join("\n") === b.tools.join("\n") &&
    JSON.stringify(sortKeys(a.prompt)) === JSON.stringify(sortKeys(b.prompt)) &&
    JSON.stringify(sortKeys(skillsOf(a))) ===
      JSON.stringify(sortKeys(skillsOf(b))) &&
    modeKey(a.mode) === modeKey(b.mode)
  );
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)),
  );
}

/** 行级差异：只给出被删与新增的行，够模型看出改了什么。 */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (lcs[i + 1] as number[])[j] as number,
              (lcs[i] as number[])[j + 1] as number,
            );
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (
      ((lcs[i + 1] as number[])[j] as number) >=
      ((lcs[i] as number[])[j + 1] as number)
    )
      out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

/**
 * 没有 skills 栏的旧状态（这一栏出现之前写下的冻结物与通知）：从冻结的开头消息里还原「当时已经列过哪些技能」。
 * pi 把技能写成 `<available_skills>` 里的 `<name>…</name>`；描述按当前的算，免得旧会话白白多一条「描述变了」。
 */
export function skillsListedIn(
  head: unknown,
  now: Record<string, string>,
): Record<string, string> {
  const text = JSON.stringify(head ?? {});
  const from = text.indexOf("<available_skills>");
  if (from < 0) return {};
  const to = text.indexOf("</available_skills>", from);
  const out: Record<string, string> = {};
  for (const m of text
    .slice(from, to < 0 ? undefined : to)
    .matchAll(/<name>([^<]+)<\/name>/g))
    if (m[1]) out[m[1]] = now[m[1]] ?? "";
  return out;
}

/** 与新状态相比的「上一份」：旧状态没有 skills 栏时按冻结物里列过的技能补上。 */
export function withListedSkills(
  prev: StateMapping,
  head: unknown,
  next: StateMapping,
): StateMapping {
  return prev.skills === undefined
    ? { ...prev, skills: skillsListedIn(head, next.skills ?? {}) }
    : prev;
}

const SKILL_DESC_MAX = 200;
const shortText = (s: string) =>
  s.length > SKILL_DESC_MAX ? `${s.slice(0, SKILL_DESC_MAX)}…` : s;

const defLine = (d: ToolDef) =>
  [
    `- ${d.name}: ${d.description}`,
    d.parameters === undefined
      ? ""
      : `  parameters (JSON schema): ${JSON.stringify(d.parameters)}`,
  ]
    .filter(Boolean)
    .join("\n");

/**
 * 通知正文（英文，框架口吻）；没有差异返回 null。
 * declared：冻结声明里已有的工具；其余新增工具要经 call_tool 调用，所以给完整定义。
 * skillPath：新增技能的 SKILL.md 在会话当前所在环境里的路径（拿不到就只给名字与描述）。
 */
export function renderNotice(
  prev: StateMapping,
  next: StateMapping,
  declared: ReadonlySet<string>,
  def: (name: string) => ToolDef | undefined,
  skillPath: (name: string) => string | undefined = () => undefined,
): string | null {
  const parts: string[] = [];

  if (modeKey(prev.mode) !== modeKey(next.mode)) {
    if (prev.mode && next.mode)
      parts.push(
        `You left mode "${prev.mode.name}" and entered mode "${next.mode.name}".`,
      );
    else if (next.mode) parts.push(`You entered mode "${next.mode.name}".`);
    else if (prev.mode)
      parts.push(
        `You left mode "${prev.mode.name}": tools it added are unloaded, restrictions it imposed are lifted, and tools it removed are available again.`,
      );
    if (next.mode?.text.trim()) parts.push(next.mode.text.trim());
    if (next.mode?.userText.trim()) parts.push(next.mode.userText.trim());
  }

  const had = new Set(prev.tools);
  const has = new Set(next.tools);
  const added = next.tools.filter((t) => !had.has(t));
  const removed = prev.tools.filter((t) => !has.has(t));
  const again = added.filter((t) => declared.has(t));
  const fresh = added.filter((t) => !declared.has(t));
  if (fresh.length > 0)
    parts.push(
      [
        "New tools are available. They are not in your tool list: call them through call_tool with { name, arguments }.",
        ...fresh.map((t) => defLine(def(t) ?? { name: t, description: "" })),
      ].join("\n"),
    );
  if (again.length > 0)
    parts.push(`Tools available again: ${again.join(", ")}.`);
  if (removed.length > 0)
    parts.push(
      `Tools no longer available: ${removed.join(", ")}. Calling them will fail.`,
    );

  const wasSkills = skillsOf(prev);
  const nowSkills = skillsOf(next);
  const newSkills = Object.keys(nowSkills).filter((n) => !(n in wasSkills));
  const changedSkills = Object.keys(nowSkills).filter(
    (n) => n in wasSkills && wasSkills[n] !== nowSkills[n],
  );
  const goneSkills = Object.keys(wasSkills).filter((n) => !(n in nowSkills));
  const skillLine = (n: string) => {
    const path = skillPath(n);
    return `- ${n}: ${shortText(nowSkills[n] ?? "")}${path ? `\n  SKILL.md: ${path}` : ""}`;
  };
  if (newSkills.length > 0)
    parts.push(
      [
        "New skills are available. When a task matches a skill's description, read its SKILL.md first and follow it:",
        ...newSkills.map(skillLine),
      ].join("\n"),
    );
  if (changedSkills.length > 0)
    parts.push(
      ["Skill descriptions changed:", ...changedSkills.map(skillLine)].join(
        "\n",
      ),
    );
  if (goneSkills.length > 0)
    parts.push(
      `Skills no longer available: ${goneSkills.join(", ")}. Do not rely on them.`,
    );

  const tags = new Set([
    ...Object.keys(prev.prompt),
    ...Object.keys(next.prompt),
  ]);
  for (const tag of [...tags].sort()) {
    const was = prev.prompt[tag];
    const now = next.prompt[tag];
    if (was === now) continue;
    const label = tag === "identity" ? "identity" : `<${tag}>`;
    if (was === undefined)
      parts.push(`Prompt section ${label} was added:\n${now}`);
    else if (now === undefined)
      parts.push(`Prompt section ${label} was removed.`);
    else parts.push(`Prompt section ${label} changed:\n${lineDiff(was, now)}`);
  }

  if (parts.length === 0) return null;
  return [
    "[System state update — this overrides earlier descriptions of the same things; the latest update wins.]",
    ...parts,
  ].join("\n\n");
}
