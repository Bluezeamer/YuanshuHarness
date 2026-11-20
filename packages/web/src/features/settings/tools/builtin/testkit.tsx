// 仅测试使用：内置工具规则的带状态假服务端，语义对照 server 的 api/tools.ts。
import type {
  Policy,
  ToolGroupKey,
  ToolKind,
  ToolPolicy,
  ToolRow,
} from "../../../../api/toolRules";
import { type Route, reply } from "../common/testkit";

const GROUP_NAME: Record<ToolGroupKey, string> = {
  files: "文件与命令",
  dirs: "目录与传输",
  orchestrate: "编排与委派",
  browser: "浏览器",
  devtools: "开发调试",
  framework: "框架工具",
};

interface Seed {
  name: string;
  group: ToolGroupKey;
  kind: ToolKind;
  factory?: ToolPolicy;
  framework?: boolean;
  note?: string;
}

const both = (p: Policy): ToolPolicy => ({ inside: p, outside: p });
const FILE: ToolPolicy = { inside: "allow", outside: "ask" };

// 每一类都有代表：path（两格）、flat（一个开关）、fixed（只读）、框架工具
const SEEDS: Seed[] = [
  { name: "read", group: "files", kind: "path", factory: FILE },
  { name: "write", group: "files", kind: "path", factory: FILE },
  { name: "bash", group: "files", kind: "path", factory: both("ask") },
  {
    name: "list_directories",
    group: "dirs",
    kind: "flat",
    factory: both("allow"),
  },
  {
    name: "switch_directory",
    group: "dirs",
    kind: "flat",
    factory: both("ask"),
  },
  {
    name: "transfer_files",
    group: "dirs",
    kind: "fixed",
    note: "源端按 read、目标端按 write，各取所在目录的规则",
  },
  {
    name: "spawn_subagent",
    group: "orchestrate",
    kind: "flat",
    factory: both("allow"),
  },
  {
    name: "workflow_run",
    group: "orchestrate",
    kind: "flat",
    factory: both("ask"),
  },
  {
    name: "browser_open",
    group: "browser",
    kind: "flat",
    factory: both("ask"),
  },
  {
    name: "browser_snapshot",
    group: "browser",
    kind: "flat",
    factory: both("allow"),
  },
  {
    name: "todo_write",
    group: "framework",
    kind: "fixed",
    framework: true,
    note: "自身放行",
  },
  {
    name: "switch_mode",
    group: "framework",
    kind: "flat",
    factory: both("ask"),
    framework: true,
  },
];

const same = (a: ToolPolicy, b: ToolPolicy) =>
  a.inside === b.inside && a.outside === b.outside;

export function toolsRoutes() {
  const state = { overrides: {} as Record<string, ToolPolicy> };
  const view = (s: Seed): ToolRow => {
    const rule = s.factory ? (state.overrides[s.name] ?? s.factory) : null;
    return {
      name: s.name,
      description: `${s.name} 说明`,
      readOnly: false,
      server: false,
      group: { key: s.group, name: GROUP_NAME[s.group] },
      kind: s.kind,
      framework: s.framework ?? false,
      note: s.note ?? null,
      factory: s.factory ?? null,
      rule,
      modified: !!s.factory && !!rule && !same(rule, s.factory),
    };
  };
  const route: Route = (method, path, body) => {
    if (method === "GET" && path === "/api/v1/tools")
      return reply(200, { tools: SEEDS.map(view) });
    if (method === "PUT" && path === "/api/v1/tools/rules") {
      const rules = (body as { rules: Record<string, ToolPolicy> }).rules;
      for (const [name, r] of Object.entries(rules)) {
        const s = SEEDS.find((x) => x.name === name);
        if (!s?.factory)
          return reply(400, {
            error: "invalid_rule",
            message: `${name} 不可调整`,
          });
        if (s.kind === "flat" && r.inside !== r.outside)
          return reply(400, {
            error: "invalid_rule",
            message: `${name} 不分 cwd，inside 与 outside 须相同`,
          });
      }
      for (const [name, r] of Object.entries(rules)) {
        const factory = SEEDS.find((x) => x.name === name)
          ?.factory as ToolPolicy;
        if (same(r, factory)) delete state.overrides[name];
        else state.overrides[name] = r;
      }
      return reply(200, { tools: SEEDS.map(view) });
    }
    return undefined;
  };
  return { route, state };
}
