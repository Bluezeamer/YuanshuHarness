import { enc, request } from "./http";
import type { Policy } from "./toolRules";

// MCP 库：与服务端 api/mcp.ts、mcp/conf.ts、mcp/pin.ts、mcp/runtime.ts 对应。
// 旧的 capabilities.ts 里的 MCP 是旧形状（结构化 config，没有 JSON 入口），新界面不用。

export const EXPOSURES = ["direct", "hidden"] as const;
export type Exposure = (typeof EXPOSURES)[number];

/** 最近一次握手（启动 + 握手 + 列工具）；失败原因点名，如 401 令牌过期。 */
export interface McpHandshake {
  ok: boolean;
  /** 握手返回的工具总数。 */
  tools: number;
  ms: number;
  at: string;
  error?: string;
  /** 失败属于授权类（令牌无效 / 过期 / 无权访问）。 */
  authFailed?: true;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

/** mcpServers 里的那一条（登记条目还原成 JSON 的样子；密码库引用写成占位串，不含值）。 */
export interface McpConf {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
  exposure: Exposure;
  toolExposure?: Record<string, Exposure>;
  oauth?: unknown;
}

export interface McpView {
  name: string;
  /** 取自包元数据或握手 serverInfo，不接受手填；没有时服务端写「来源未提供描述」。 */
  description: string;
  transport: "stdio" | "http";
  conf: McpConf;
  /** stdio 且命令是 npx / uvx 才有；其余为 null（不可固定）。 */
  source: { runtime: "npm" | "pypi"; pkg: string } | null;
  /** 命令里写死的 x.y.z；null = 浮动（每次启动解析最新）。 */
  version: string | null;
  pinned: boolean;
  /** 试装时解析到的最新版；回退到旧版后据此标「低于解析」。 */
  latestVersion: string | null;
  /** 每服务一档，对 mcp__<server>__* 全部工具统一生效；默认审批。 */
  approval: Policy;
  enabled: boolean;
  /** 全局：每个会话都带上；否则只在被勾给的工作区里生效。 */
  global: boolean;
  /** direct：直接声明给模型；hidden：已登记但不可达（可用 toolExposure 单独放行几个工具）。 */
  exposure: Exposure;
  toolExposure: Record<string, Exposure>;
  timeout: number | null;
  /** 服务端存而不执行。 */
  oauth: unknown;
  handshake: McpHandshake | null;
  /** 握手缓存的工具；可能只是 handshake.tools 个里的一部分。 */
  tools: McpToolInfo[] | null;
  toolsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpDiagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  field?: string;
}

export interface McpPreview {
  name: string;
  transport: "stdio" | "http";
  target: string;
  envCount: number;
  headerCount: number;
}

export interface McpValidation {
  ok: boolean;
  diagnostics: McpDiagnostic[];
  /** 没有 error 时才有。 */
  preview: McpPreview | null;
}

export interface StepResult {
  state: "ok" | "error" | "skipped";
  ms: number;
  error?: string;
}

/** 检测三步：启动 → 握手 → 列工具；失败也是 200，原因在 steps 与 handshake.error。 */
export interface McpCheck {
  name: string;
  ok: boolean;
  ms: number;
  tools: number;
  steps: { start: StepResult; handshake: StepResult; list: StepResult };
  handshake: McpHandshake;
}

export interface McpRef {
  kind: "preset" | "directory";
  id: string;
  name: string;
  detail: string;
}

export interface PinSuccess {
  ok: true;
  version: string;
  latestVersion: string;
  resolveMs: number;
  check: McpCheck;
  server: McpView;
}

export interface McpVersions {
  name: string;
  runtime: "npm" | "pypi";
  pkg: string;
  /** 命令里写死的版本；null = 浮动。 */
  current: string | null;
  latest: string;
  versions: { version: string; current: boolean; latest: boolean }[];
}

export type McpBatchAction =
  | "pin"
  | "check"
  | "enable"
  | "disable"
  | "uninstall";

export interface McpBatchItem {
  name: string;
  ok: boolean;
  error?: string;
  message?: string;
}

export interface McpBatchResult {
  action: McpBatchAction;
  okCount: number;
  failCount: number;
  results: McpBatchItem[];
  servers: McpView[];
}

const base = "/api/v1/mcp";
const one = (name: string) => `${base}/${enc(name)}`;

export const listMcp = async (token: string | null) =>
  (await request<{ servers: McpView[] }>("GET", base, token)).servers;

/** 编辑器边输入边校验：逐条诊断，不落库。editing 是正在编辑的现有条目（重名判断排除它自己）。 */
export const validateMcp = (
  token: string | null,
  json: string,
  editing?: string,
) =>
  request<McpValidation>("POST", `${base}/validate`, token, {
    json,
    ...(editing === undefined ? {} : { editing }),
  });

/** 名称取自 JSON 的键。400 invalid_config（diagnostics 逐条）、409 name_exists。 */
export const createMcp = (token: string | null, json: string) =>
  request<McpView & { diagnostics: McpDiagnostic[] }>("POST", base, token, {
    json,
  });

/** JSON 的键变了即改名；旧名被引用 409 mcp_referenced，body.references 列出位置。 */
export const updateMcp = (token: string | null, name: string, json: string) =>
  request<McpView & { diagnostics: McpDiagnostic[]; renamedFrom?: string }>(
    "PUT",
    one(name),
    token,
    { json },
  );

export const patchMcp = (
  token: string | null,
  name: string,
  patch: { approval?: Policy; enabled?: boolean; global?: boolean },
) => request<McpView>("PATCH", one(name), token, patch);

export const deleteMcp = (token: string | null, name: string) =>
  request("DELETE", one(name), token);

export const checkMcp = (token: string | null, name: string) =>
  request<McpCheck & { server: McpView }>("POST", `${one(name)}/check`, token);

/** 全部检测：只测已启用的，逐个串行，汇总就绪数。 */
export const checkAllMcp = (token: string | null) =>
  request<{
    total: number;
    ready: number;
    results: McpCheck[];
    servers: McpView[];
  }>("POST", `${base}/check-all`, token);

/**
 * 试装并固定：成功才把 pkg@版本 写回命令；失败（网络 503 / 包不存在 422 / 试装跑不起来 502）不写，
 * body 是 {error,message,steps?,server}。version 缺省取最新，指定旧版即回退并锁定。
 */
export const tryPinMcp = (
  token: string | null,
  name: string,
  version?: string,
) =>
  request<PinSuccess>(
    "POST",
    `${one(name)}/try-pin`,
    token,
    version === undefined ? {} : { version },
  );

export const mcpVersions = (token: string | null, name: string) =>
  request<McpVersions>("POST", `${one(name)}/versions`, token);

export const batchMcp = (
  token: string | null,
  names: string[],
  action: McpBatchAction,
) => request<McpBatchResult>("POST", `${base}/batch`, token, { names, action });
