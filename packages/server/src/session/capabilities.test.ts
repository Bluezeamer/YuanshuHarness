import { describe, expect, test } from "vitest";
import {
  CAPABILITY_UNITS,
  DEFAULT_OFF_UNITS,
  evaluateTools,
  type ModeOps,
  toolsOfCaps,
  unlimitedTools,
} from "./capabilities.js";
import { TOOL_GROUPS, TOOLS } from "./tool-catalog.js";

const REG = [
  "read",
  "grep",
  "write",
  "bash",
  "spawn_subagent",
  "message_subagent",
  "mcp__docs__search",
];
const FW = ["call_tool", "ask_user"];
const run = (baseline: string[], mode: ModeOps | null) =>
  evaluateTools({
    baseline,
    registered: REG,
    framework: FW,
    mode,
    serverOf: (t) => (t.startsWith("mcp__docs__") ? "docs" : undefined),
  });
const ops = (o: Partial<ModeOps>): ModeOps => ({
  limit: null,
  add: [],
  remove: [],
  ...o,
});

describe("能力求值", () => {
  test("没有模式：基线加框架工具", () => {
    expect(run(["read", "bash"], null)).toEqual(["read", "bash", ...FW]);
  });

  test("限定为：只留集合内的；框架工具不受影响", () => {
    expect(
      run(
        ["read", "write", "bash"],
        ops({ limit: ["tool:read", "tool:grep"] }),
      ),
    ).toEqual(["read", ...FW]);
  });

  test("增加：基线里没有也出现；没注册的不能凭空增加", () => {
    expect(run(["read"], ops({ add: ["tool:bash", "tool:nope"] }))).toEqual([
      "read",
      "bash",
      ...FW,
    ]);
  });

  test("减少：去掉；没有则无事", () => {
    expect(
      run(["read", "write"], ops({ remove: ["tool:write", "tool:bash"] })),
    ).toEqual(["read", ...FW]);
  });

  test("顺序：限定为 → 增加 → 减少，限定之后增加的不被限定掉", () => {
    expect(
      run(
        ["read", "write", "bash"],
        ops({
          limit: ["tool:read"],
          add: ["tool:grep"],
          remove: ["tool:read"],
        }),
      ),
    ).toEqual(["grep", ...FW]);
  });

  test("mcp:<服务> 命中该服务的全部工具", () => {
    const base = ["read", "mcp__docs__search"];
    expect(run(base, ops({ limit: ["tool:read"] }))).toEqual(["read", ...FW]);
    expect(run(base, ops({ limit: ["mcp:docs"] }))).toEqual([
      "mcp__docs__search",
      ...FW,
    ]);
    expect(run(base, ops({ remove: ["mcp:docs"] }))).toEqual(["read", ...FW]);
  });
});

describe("能力单元", () => {
  test("unit:subagent 展开成两个派发工具，与 tool: 点名的合并去重", () => {
    expect(toolsOfCaps(["tool:read", "unit:subagent"]).sort()).toEqual([
      "message_subagent",
      "read",
      "spawn_subagent",
    ]);
    expect(
      toolsOfCaps(["unit:subagent", "tool:spawn_subagent"]).sort(),
    ).toEqual(["message_subagent", "spawn_subagent"]);
    expect(toolsOfCaps(["mcp:docs", "unit:nope"])).toEqual([]);
  });

  test("模式的限定为 / 增加 / 减少都按单元整体命中", () => {
    const base = ["read", "spawn_subagent", "message_subagent"];
    expect(run(base, ops({ limit: ["unit:subagent"] }))).toEqual([
      "spawn_subagent",
      "message_subagent",
      ...FW,
    ]);
    expect(run(base, ops({ remove: ["unit:subagent"] }))).toEqual([
      "read",
      ...FW,
    ]);
    expect(run(["read"], ops({ add: ["unit:subagent"] }))).toEqual([
      "read",
      "spawn_subagent",
      "message_subagent",
      ...FW,
    ]);
  });

  test("默认关闭的单元：「不限制」不含它，明确勾选或模式增加才启用", () => {
    const all = ["read", "browser_open", "browser_network", "spawn_subagent"];
    expect(unlimitedTools(all)).toEqual([
      "read",
      "browser_open",
      "spawn_subagent",
    ]);
    expect(toolsOfCaps(["unit:devtools"])).toEqual([
      "browser_network",
      "browser_exec",
      "browser_storage",
      "browser_request",
      "browser_route",
      "browser_emulate",
      "browser_cdp",
    ]);
    const reg = [...all];
    expect(
      evaluateTools({
        baseline: unlimitedTools(all),
        registered: reg,
        framework: FW,
        mode: ops({ add: ["unit:devtools"] }),
      }),
    ).toContain("browser_network");
  });
});

describe("能力单元与工具目录", () => {
  test("单元里的工具都是目录里的内置工具；默认关闭的单元里的工具都归在「开发调试」组", () => {
    const group = new Map(TOOLS.map((t) => [t.name, t.group]));
    for (const [id, tools] of Object.entries(CAPABILITY_UNITS))
      for (const t of tools) expect(group.has(t), `${id} 的 ${t}`).toBe(true);
    for (const id of DEFAULT_OFF_UNITS)
      for (const t of CAPABILITY_UNITS[id] ?? [])
        expect(group.get(t), t).toBe("devtools");
    expect(TOOL_GROUPS.devtools).toBe("开发调试");
  });
});
