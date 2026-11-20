import { request } from "./http";

// 内置工具的审批规则：与服务端 api/tools.ts、permission/tool-matrix.ts 一一对应。
// 旧的 capabilities.ts 仍是旧形状（能力勾选在用），这里是设置页专用的客户端。

export const POLICIES = ["allow", "ask"] as const;
export type Policy = (typeof POLICIES)[number];

export interface ToolPolicy {
  inside: Policy;
  outside: Policy;
}

/** path：cwd 内 / 外各一档；flat：一个开关（两格恒相等）；fixed：不可调，只读。 */
export type ToolKind = "path" | "flat" | "fixed";

export type ToolGroupKey =
  | "files"
  | "dirs"
  | "orchestrate"
  | "browser"
  | "devtools"
  | "framework";

export interface ToolRow {
  name: string;
  description: string;
  readOnly: boolean;
  server: boolean;
  group: { key: ToolGroupKey; name: string };
  kind: ToolKind;
  /** 始终可用、不进能力勾选的工具。 */
  framework: boolean;
  /** 仅 fixed 有：一句话说明它怎么判定。 */
  note: string | null;
  factory: ToolPolicy | null;
  rule: ToolPolicy | null;
  modified: boolean;
}

const base = "/api/v1/tools";

export const listTools = async (token: string | null) =>
  (await request<{ tools: ToolRow[] }>("GET", base, token)).tools;

/** 一次改多个工具，原子：任何一项不合格就一项都不写。与出厂值相同的项等于恢复出厂。 */
export const setToolRules = async (
  token: string | null,
  rules: Readonly<Record<string, ToolPolicy>>,
) =>
  (
    await request<{ tools: ToolRow[] }>("PUT", `${base}/rules`, token, {
      rules,
    })
  ).tools;
