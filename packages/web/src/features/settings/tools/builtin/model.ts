import type {
  Policy,
  ToolGroupKey,
  ToolPolicy,
  ToolRow,
} from "../../../../api/toolRules";

/** 可调工具（path / flat）的规则表：工具名 → 规则。flat 工具两格恒相等。 */
export type Rules = Record<string, ToolPolicy>;

export const rulesOf = (tools: readonly ToolRow[]): Rules =>
  Object.fromEntries(tools.flatMap((t) => (t.rule ? [[t.name, t.rule]] : [])));

export interface Section<K extends string, T> {
  key: K;
  name: string;
  tools: T[];
}
export type ToolSection = Section<ToolGroupKey, ToolRow>;

/** 按服务端给的顺序分组（同组相邻）。设置页与「提示词与能力」页共用。 */
export function sectionsOf<T extends { group: { key: string; name: string } }>(
  tools: readonly T[],
): Section<T["group"]["key"], T>[] {
  const out: Section<T["group"]["key"], T>[] = [];
  for (const t of tools) {
    let s = out.find((x) => x.key === t.group.key);
    if (!s) {
      s = { key: t.group.key, name: t.group.name, tools: [] };
      out.push(s);
    }
    s.tools.push(t);
  }
  return out;
}

const same = (a: ToolPolicy, b: ToolPolicy) =>
  a.inside === b.inside && a.outside === b.outside;

/** 相对出厂值是否改过（按草稿算）。 */
export const isModified = (t: ToolRow, rules: Rules): boolean => {
  const r = rules[t.name];
  return t.factory !== null && r !== undefined && !same(r, t.factory);
};

export const flatRule = (p: Policy): ToolPolicy => ({ inside: p, outside: p });

/** 组内批量：全部放行 / 全部审批（cwd 内外两格一起变），或全部恢复出厂。 */
export type Bulk = Policy | "factory";

export function bulkSet(
  rules: Rules,
  tools: readonly ToolRow[],
  to: Bulk,
): Rules {
  const next = { ...rules };
  for (const t of tools) {
    if (t.factory === null) continue;
    next[t.name] = to === "factory" ? t.factory : flatRule(to);
  }
  return next;
}

/** 与已保存值不同的项：保存时只发这些。 */
export function changed(draft: Rules, saved: Rules): Rules {
  const out: Rules = {};
  for (const [name, r] of Object.entries(draft)) {
    const was = saved[name];
    if (was === undefined || !same(r, was)) out[name] = r;
  }
  return out;
}

export function matchesQuery(t: ToolRow, q: string): boolean {
  const s = q.trim().toLowerCase();
  return (
    s === "" ||
    `${t.name} ${t.description} ${t.note ?? ""}`.toLowerCase().includes(s)
  );
}

/** 各组的一段说明，写在组标题下面。 */
export const GROUP_NOTE: Record<ToolGroupKey, string> = {
  files:
    "规则只管路径落点（cwd 内 / 外）。敏感路径、解释器前缀不可记住、sudo、隐私变量是不对等的约束，放行也绕不过。",
  dirs: "每个工具一个开关，不分 cwd。传输文件固定：源端按读、目标端按写，各取所在目录的规则。",
  orchestrate:
    "派出去的会话继承模式，不会多出权限，它们自己的调用照常审批。无人值守的子会话没人能批，设为「审批」的工具在那里会被拒。",
  browser:
    "「审批」的 browser_open 访问外部站点时按站点批准，批准记在本工作区内；本工作区的文件与自己起的服务不用批准。设为「放行」后不再询问站点。",
  devtools:
    "默认关闭，不在「不限制」之内：要在 Agent 或会话的能力里勾选「开发调试」才会提供给模型。开启的人自己知道风险，所以这里默认放行；这里的开关只管提供之后是否逐次审批。",
  framework:
    "运行时的必需件：始终可用，不进能力勾选，不受模式限制，它们包着的内层调用照常审批。switch_mode 可以改：模式能增加基线外的工具，默认每次人工批准。",
};
