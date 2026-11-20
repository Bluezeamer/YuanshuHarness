import { call, enc } from "./http";

// ---- skill（ADR-0055）----

export type SkillScope = "global" | "project";

export interface SkillInfo {
  name: string;
  description: string;
  scope: SkillScope;
  source: string;
  updatedAt: string;
}

export interface EnvSkillInfo {
  name: string;
  description: string;
  dir: string;
  managed: boolean;
  inLibrary: boolean;
}

export type SyncStatus =
  | "added"
  | "updated"
  | "unchanged"
  | "conflict"
  | "failed";

export interface SyncItem {
  name: string;
  scope: SkillScope;
  status: SyncStatus;
  message?: string;
}

export interface SyncReport {
  directoryId: string;
  at: string;
  items: SyncItem[];
}

export const listSkills = (token: string | null) =>
  call(
    "GET",
    "/api/v1/skills",
    token,
    undefined,
    (b: { skills: SkillInfo[] }) => {
      if (!Array.isArray(b.skills)) throw new Error("shape");
      return b.skills;
    },
  );

export const setSkillScope = (
  token: string | null,
  name: string,
  scope: SkillScope,
) =>
  call(
    "PATCH",
    `/api/v1/skills/${enc(name)}`,
    token,
    { scope },
    (b: SkillInfo) => b,
  );

export const deleteSkill = (token: string | null, name: string) =>
  call("DELETE", `/api/v1/skills/${enc(name)}`, token, undefined, () => {});

export const scanEnvSkills = (
  token: string | null,
  environmentId: string,
  directoryId?: string,
) =>
  call(
    "GET",
    `/api/v1/environments/${enc(environmentId)}/skills${directoryId ? `?directoryId=${enc(directoryId)}` : ""}`,
    token,
    undefined,
    (b: { skills: EnvSkillInfo[] }) => {
      if (!Array.isArray(b.skills)) throw new Error("shape");
      return b.skills;
    },
  );

export const importEnvSkill = (
  token: string | null,
  body: {
    environmentId: string;
    dir: string;
    scope: SkillScope;
    directoryId?: string;
  },
) => call("POST", "/api/v1/skills/import", token, body, (b: SkillInfo) => b);

// ---- MCP（ADR-0056）----

export interface McpEntryInfo {
  key: string;
  value?: string;
  secretId?: string;
  prefix?: string;
}

export type McpConfigInfo =
  | { transport: "stdio"; command: string; args: string[]; env: McpEntryInfo[] }
  | { transport: "http"; url: string; headers: McpEntryInfo[] };

export interface McpServerInfo {
  name: string;
  config: McpConfigInfo;
  tools: { name: string; description: string }[] | null;
  toolsAt: string | null;
  status: { state: "ok" | "error"; error?: string; at: string } | null;
}

export const listMcp = (token: string | null) =>
  call(
    "GET",
    "/api/v1/mcp",
    token,
    undefined,
    (b: { servers: McpServerInfo[] }) => {
      if (!Array.isArray(b.servers)) throw new Error("shape");
      return b.servers;
    },
  );

export const createMcp = (
  token: string | null,
  body: { name: string; config: McpConfigInfo },
) => call("POST", "/api/v1/mcp", token, body, (b: McpServerInfo) => b);

export const updateMcp = (
  token: string | null,
  name: string,
  config: McpConfigInfo,
) =>
  call(
    "PUT",
    `/api/v1/mcp/${enc(name)}`,
    token,
    { config },
    (b: McpServerInfo) => b,
  );

export const deleteMcp = (token: string | null, name: string) =>
  call("DELETE", `/api/v1/mcp/${enc(name)}`, token, undefined, () => {});

// 连不上时服务端返回 502，这里落在 server 失败类里，原因在服务端状态中。
export const refreshMcp = (token: string | null, name: string) =>
  call(
    "POST",
    `/api/v1/mcp/${enc(name)}/refresh`,
    token,
    {},
    (b: McpServerInfo) => b,
  );

// ---- 内置工具清单 ----

/**
 * 能力单元（服务端 session/capabilities.ts 的 CAPABILITY_UNITS 的镜像）：
 * 一个开关管一组互相依赖的内置工具，界面上合成一项，不再单列这些工具。
 */
export const CAPABILITY_UNITS: ReadonlyArray<{
  id: string;
  name: string;
  desc: string;
  /** 属于哪一组工具（ToolInfo.group.key）：勾选清单里它排在那一组里 */
  group: string;
  /** 默认关闭：不在「不限制」之内，要明确勾选（或模式增加）才启用 */
  defaultOff?: boolean;
  tools: readonly string[];
}> = [
  {
    id: "unit:subagent",
    name: "子代理",
    desc: "整体开关：派发子代理并取回它的交付，可放到后台运行，也能给已派发的子代理追加指示",
    group: "orchestrate",
    tools: ["spawn_subagent", "message_subagent"],
  },
  {
    id: "unit:canvas",
    name: "画布",
    desc: "整体开关：在目录的 `.canvas/` 里收集灵感卡与项目文件引用，agent 只能通过 `canvas_edit` 写",
    group: "files",
    tools: ["canvas_edit"],
  },
  {
    id: "unit:team",
    name: "团队",
    desc: "整体开关：建一组有名字的成员并行工作，互发消息、共用公告板，随时查看进展与整体改动",
    group: "orchestrate",
    tools: [
      "team_create",
      "team_update",
      "team_stop",
      "team_status",
      "team_diff",
      "team_disband",
    ],
  },
  {
    id: "unit:devtools",
    name: "开发调试",
    desc: "整体开关，默认关闭：网络请求与响应体、页面脚本执行、存储与 Cookie、请求重放与拦截、环境模拟——开发与安全测试用，开启即表示你知道它能做什么",
    group: "devtools",
    defaultOff: true,
    tools: [
      "browser_network",
      "browser_exec",
      "browser_storage",
      "browser_request",
      "browser_route",
      "browser_emulate",
      "browser_cdp",
    ],
  },
];
export const UNIT_TOOLS: ReadonlySet<string> = new Set(
  CAPABILITY_UNITS.flatMap((u) => u.tools),
);
export const DEFAULT_OFF_UNITS: ReadonlySet<string> = new Set(
  CAPABILITY_UNITS.filter((u) => u.defaultOff).map((u) => u.id),
);

export interface ToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
  server: boolean;
  /** 工具分组（服务端给出，设置页与能力勾选共用同一份）。 */
  group: { key: string; name: string };
  /** 始终可用、不进能力勾选的工具。 */
  framework: boolean;
}

export const listTools = (token: string | null) =>
  call("GET", "/api/v1/tools", token, undefined, (b: { tools: ToolInfo[] }) => {
    if (!Array.isArray(b.tools)) throw new Error("shape");
    return b.tools;
  });

// ---- hook（ADR-0085）；与 server/src/hooks/points.ts、store/hooks.ts 对应 ----

export interface HookPoint {
  id: string;
  label: string;
  description: string;
  blocking: boolean;
  matchField: "tool_name" | "source" | null;
  sample: Record<string, unknown>;
}

export interface HookInfo {
  id: string;
  name: string;
  point: string;
  matcher: string;
  command: string;
  timeoutSec: number;
  enabled: boolean;
  /** null = 全局。 */
  directoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HookInput = Omit<HookInfo, "id" | "createdAt" | "updatedAt">;

export interface HookRunInfo {
  hookId: string;
  hookName: string;
  result: "ok" | "blocked" | "feedback" | "error" | "timeout";
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  reason?: string;
  context?: string;
  updatedInput?: Record<string, unknown>;
  error?: string;
}

export interface HookAuditEntry {
  id: number;
  ts: string;
  summary: string;
  detail: {
    hookId?: string;
    result?: HookRunInfo["result"];
    durationMs?: number;
    exitCode?: number | null;
    test?: boolean;
    reason?: string;
    error?: string;
  } | null;
}

export const listHooks = (token: string | null) =>
  call(
    "GET",
    "/api/v1/hooks",
    token,
    undefined,
    (b: { hooks: HookInfo[]; points: HookPoint[] }) => {
      if (!Array.isArray(b.hooks) || !Array.isArray(b.points))
        throw new Error("shape");
      return b;
    },
  );

export const createHook = (token: string | null, input: HookInput) =>
  call("POST", "/api/v1/hooks", token, input, (b: HookInfo) => b);

export const updateHook = (
  token: string | null,
  id: string,
  patch: Partial<HookInput>,
) => call("PUT", `/api/v1/hooks/${enc(id)}`, token, patch, (b: HookInfo) => b);

export const deleteHook = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/hooks/${enc(id)}`, token, undefined, () => {});

export const testHook = (token: string | null, id: string) =>
  call(
    "POST",
    `/api/v1/hooks/${enc(id)}/test`,
    token,
    {},
    (b: HookRunInfo) => b,
  );

// 审计里 kind=hook 的最近记录；按 hook 过滤在调用方做（审计接口没有 hookId 维度）。
export const listHookAudit = (token: string | null, limit = 100) =>
  call(
    "GET",
    `/api/v1/audit?kind=hook&limit=${limit}`,
    token,
    undefined,
    (b: { entries: HookAuditEntry[] }) => {
      if (!Array.isArray(b.entries)) throw new Error("shape");
      return b.entries;
    },
  );
