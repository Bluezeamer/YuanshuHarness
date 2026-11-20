// 能力求值（prompt.md E1）：会话基线 → 模式的操作（限定为 → 增加 → 减少），再并上框架工具。
// 纯函数，每次运行前现算；结果就是「当前启用的工具集合」。

/**
 * 能力单元：一个开关管一组互相依赖的工具（不细分到单个工具）。id 形如 `unit:<名>`。
 * 单元里的工具仍是普通的内置工具，只是界面上合成一项。
 */
export const CAPABILITY_UNITS: Record<string, readonly string[]> = {
  "unit:subagent": ["spawn_subagent", "message_subagent"],
  "unit:canvas": ["canvas_edit"],
  "unit:team": [
    "team_create",
    "team_update",
    "team_stop",
    "team_status",
    "team_diff",
    "team_disband",
  ],
  "unit:devtools": [
    "browser_network",
    "browser_exec",
    "browser_storage",
    "browser_request",
    "browser_route",
    "browser_emulate",
    "browser_cdp",
  ],
};

/**
 * 默认关闭的单元：开发调试用的危险工具。「不限制」（能力为 null）不含它们，
 * 要明确勾选、或由模式的「增加」才启用——开启的人自己知道风险。
 */
export const DEFAULT_OFF_UNITS: readonly string[] = ["unit:devtools"];

/** 「不限制」时的内置工具：全部，去掉默认关闭的单元。 */
export function unlimitedTools(all: Iterable<string>): string[] {
  const off = new Set(
    DEFAULT_OFF_UNITS.flatMap((u) => CAPABILITY_UNITS[u] ?? []),
  );
  return [...all].filter((t) => !off.has(t));
}

/** 能力 id 里点名的内置工具名：`tool:<名>` 加上单元展开的。 */
export function toolsOfCaps(caps: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of caps) {
    if (c.startsWith("tool:")) out.add(c.slice(5));
    for (const t of CAPABILITY_UNITS[c] ?? []) out.add(t);
  }
  return [...out];
}

/** 模式对能力的三种操作。能力 id 与预设一致：`tool:<名>`、`unit:<名>`、`mcp:<服务>`。 */
export interface ModeOps {
  /** 限定为：只留这些；null 表示不限定 */
  limit: string[] | null;
  /** 增加：即使基线里没有也出现（须是已注册的工具） */
  add: string[];
  /** 减少：从现有集合里去掉，没有则无事 */
  remove: string[];
}

export interface EvalInput {
  /** 会话自己的基线：启用的工具名（不含框架工具） */
  baseline: readonly string[];
  /** 所有已注册、可被启用的工具名（不含框架工具），决定「增加」能加什么 */
  registered: readonly string[];
  /** 框架工具：始终可用，不受模式影响 */
  framework: readonly string[];
  mode: ModeOps | null;
  /** MCP 工具名 → 所属服务，用来匹配 `mcp:<服务>` */
  serverOf?: (tool: string) => string | undefined;
}

const hits = (ids: readonly string[], tool: string, server?: string) =>
  ids.includes(`tool:${tool}`) ||
  ids.some((id) => CAPABILITY_UNITS[id]?.includes(tool)) ||
  (server !== undefined && ids.includes(`mcp:${server}`));

/** 当前启用的工具名：按「已注册」的顺序，框架工具排在后面。 */
export function evaluateTools(i: EvalInput): string[] {
  const server = (t: string) => i.serverOf?.(t);
  let on = new Set(i.baseline);
  const m = i.mode;
  if (m) {
    if (m.limit)
      on = new Set([...on].filter((t) => hits(m.limit ?? [], t, server(t))));
    for (const t of i.registered) if (hits(m.add, t, server(t))) on.add(t);
    for (const t of [...on]) if (hits(m.remove, t, server(t))) on.delete(t);
  }
  const ordered = i.registered.filter((t) => on.has(t));
  return [...ordered, ...i.framework.filter((t) => !ordered.includes(t))];
}
