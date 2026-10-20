export interface SessionInfo {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  workspaceId?: string | null;
  reviewPolicy?: string | null;
}

export type Tier = "rules" | "auto" | "full";

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  tier: Tier;
  createdAt: string;
}

export interface RuleInfo {
  id: string;
  kind: "path" | "command";
  access: "read" | "write" | null;
  value: string;
  createdAt: string;
}

export interface ChatEntry {
  index: number;
  role: "user" | "assistant";
  text: string;
  blocks?: import("./history").Block[];
}

export interface Page {
  messages: ChatEntry[];
  nextBefore: string | null;
}

export type Failure =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "rate_limited"; retryAfter: number | null }
  | { kind: "network" }
  | { kind: "server" };

export type Result<T> = { ok: true; data: T } | ({ ok: false } & Failure);

const STORAGE_KEY = "yuanshu.token";

export const loadToken = (): string | null =>
  sessionStorage.getItem(STORAGE_KEY);
export const saveToken = (token: string): void =>
  sessionStorage.setItem(STORAGE_KEY, token);
export const clearToken = (): void => sessionStorage.removeItem(STORAGE_KEY);

function failure(res: Response): Failure {
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 429) {
    const secs = Number(res.headers.get("Retry-After"));
    return {
      kind: "rate_limited",
      retryAfter: Number.isFinite(secs) && secs > 0 ? secs : null,
    };
  }
  return { kind: "server" };
}

// token 只通过参数传入，不在这里读存储：调用方决定用哪个令牌。
async function get<T>(
  path: string,
  token: string | null,
  pick: (body: never) => T,
): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  if (!res.ok) return { ok: false, ...failure(res) };
  try {
    return { ok: true, data: pick((await res.json()) as never) };
  } catch {
    return { ok: false, kind: "server" };
  }
}

export const listSessions = (token: string | null) =>
  get(
    "/api/v1/sessions",
    token,
    (b: { sessions: SessionInfo[] }) => b.sessions,
  );

// 服务端上限 200 条；默认 50 条恰好等于快照窗口，取不到更早的历史。
export const listMessages = (
  id: string,
  token: string | null,
  before?: string,
) =>
  get(
    `/api/v1/sessions/${encodeURIComponent(id)}/messages?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    token,
    (b: Page) => {
      if (!Array.isArray(b.messages)) throw new Error("bad page");
      return { messages: b.messages, nextBefore: b.nextBefore ?? null };
    },
  );

export interface Workbench {
  revision: number;
  document: unknown | null;
}

export const getWorkbench = (token: string | null) =>
  get("/api/v1/workbench", token, (b: Workbench) => {
    if (typeof b.revision !== "number") throw new Error("shape");
    return { revision: b.revision, document: b.document ?? null };
  });

export type PutResult =
  | { ok: true; revision: number }
  | { ok: false; kind: "conflict"; current: Workbench }
  | ({ ok: false } & Failure);

// 409 带回当前文档，所以不走通用的 get。pagehide 期间走 keepalive。
export async function putWorkbench(
  token: string | null,
  baseRevision: number,
  document: unknown,
  keepalive = false,
): Promise<PutResult> {
  let res: Response;
  try {
    res = await fetch("/api/v1/workbench", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ baseRevision, document }),
      keepalive,
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  try {
    if (res.status === 409) {
      const b = (await res.json()) as Workbench;
      return {
        ok: false,
        kind: "conflict",
        current: { revision: b.revision, document: b.document ?? null },
      };
    }
    if (!res.ok) return { ok: false, ...failure(res) };
    const b = (await res.json()) as { revision: number };
    if (typeof b.revision !== "number") return { ok: false, kind: "server" };
    return { ok: true, revision: b.revision };
  } catch {
    return { ok: false, kind: "server" };
  }
}

export interface SavedLayout {
  id: string;
  revision: number;
  document: unknown;
}

export const listSavedLayouts = (token: string | null) =>
  get("/api/v1/saved-layouts", token, (b: { layouts: SavedLayout[] }) => {
    if (!Array.isArray(b.layouts)) throw new Error("shape");
    return b.layouts;
  });

export type CreateSavedResult =
  | { ok: true; id: string; revision: number }
  | ({ ok: false } & Failure);

export async function createSavedLayout(
  token: string | null,
  document: unknown,
): Promise<CreateSavedResult> {
  let res: Response;
  try {
    res = await fetch("/api/v1/saved-layouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ document }),
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  try {
    if (res.status === 201) {
      const b = (await res.json()) as { id: string; revision: number };
      if (typeof b.id !== "string" || typeof b.revision !== "number")
        return { ok: false, kind: "server" };
      return { ok: true, id: b.id, revision: b.revision };
    }
    if (!res.ok) return { ok: false, ...failure(res) };
    return { ok: false, kind: "server" };
  } catch {
    return { ok: false, kind: "server" };
  }
}

export type DeleteSavedResult =
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | ({ ok: false } & Failure);

export async function deleteSavedLayout(
  token: string | null,
  id: string,
): Promise<DeleteSavedResult> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/saved-layouts/${id}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  if (res.status === 204) return { ok: true };
  if (res.status === 404) return { ok: false, kind: "not_found" };
  return { ok: false, ...failure(res) };
}

export type CallFailure =
  | Failure
  | { kind: "bad_request" }
  | { kind: "not_found" }
  | { kind: "conflict" };

export type CallResult<T> =
  | { ok: true; data: T }
  | ({ ok: false } & CallFailure);

// 带请求体或非 GET 的调用。204 视为成功且无数据。
export async function call<T>(
  method: string,
  path: string,
  token: string | null,
  body: unknown,
  pick: (b: never) => T,
): Promise<CallResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, kind: "network" };
  }
  if (res.status === 400) return { ok: false, kind: "bad_request" };
  if (res.status === 404) return { ok: false, kind: "not_found" };
  if (res.status === 409) return { ok: false, kind: "conflict" };
  if (!res.ok) return { ok: false, ...failure(res) };
  if (res.status === 204) return { ok: true, data: undefined as T };
  try {
    return { ok: true, data: pick((await res.json()) as never) };
  } catch {
    return { ok: false, kind: "server" };
  }
}

export const enc = encodeURIComponent;

export const listWorkspaces = (token: string | null) =>
  get("/api/v1/workspaces", token, (b: { workspaces: WorkspaceInfo[] }) => {
    if (!Array.isArray(b.workspaces)) throw new Error("shape");
    return b.workspaces;
  });

export const createWorkspace = (
  token: string | null,
  body: { path: string; name?: string },
) => call("POST", "/api/v1/workspaces", token, body, (b: WorkspaceInfo) => b);

export const patchWorkspace = (
  token: string | null,
  id: string,
  body: { name?: string; tier?: Tier },
) =>
  call(
    "PATCH",
    `/api/v1/workspaces/${enc(id)}`,
    token,
    body,
    (b: WorkspaceInfo) => b,
  );

export const deleteWorkspace = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/workspaces/${enc(id)}`, token, undefined, () => {});

export const listRules = (token: string | null, workspaceId: string) =>
  get(
    `/api/v1/workspaces/${enc(workspaceId)}/rules`,
    token,
    (b: { rules: RuleInfo[] }) => {
      if (!Array.isArray(b.rules)) throw new Error("shape");
      return b.rules;
    },
  );

export const deleteRule = (
  token: string | null,
  workspaceId: string,
  ruleId: string,
) =>
  call(
    "DELETE",
    `/api/v1/workspaces/${enc(workspaceId)}/rules/${enc(ruleId)}`,
    token,
    undefined,
    () => {},
  );

export const createSession = (
  token: string | null,
  body: { workspaceId?: string; agentId?: string },
) =>
  call("POST", "/api/v1/sessions", token, body, (b: { id: string }) => {
    if (typeof b.id !== "string") throw new Error("shape");
    return b;
  });

// reviewPolicy 空串表示清除。
export const patchSession = (
  token: string | null,
  id: string,
  body: { reviewPolicy: string },
) => call("PATCH", `/api/v1/sessions/${enc(id)}`, token, body, () => {});

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
  readable: boolean;
  writable: boolean;
  truncated: boolean;
}

// path 缺省为服务端用户 home；400 表示路径不存在或不是目录。
export const listDirs = (token: string | null, path?: string, hidden = false) =>
  call(
    "GET",
    `/api/v1/fs/dirs?${path === undefined ? "" : `path=${enc(path)}&`}hidden=${hidden ? 1 : 0}`,
    token,
    undefined,
    (b: DirListing) => {
      if (typeof b.path !== "string" || !Array.isArray(b.dirs))
        throw new Error("shape");
      return b;
    },
  );

export type ModelApiKind =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelCompat {
  supportsDeveloperRole?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  supportsMidConvoSystemMessages?: boolean;
  supportsMidConvoToolAdditions?: boolean;
  supportsMidConvoToolChanges?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  api: ModelApiKind;
  baseUrl: string;
  modelId: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  input: Array<"text" | "image">;
  thinkingLevelMap: ThinkingLevelMap | null;
  compat: ModelCompat | null;
  hasKey: boolean;
  isDefault: boolean;
}

export interface ModelInput {
  name: string;
  api: ModelApiKind;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: ModelCompat;
  apiKey?: string;
}

export const listModels = (token: string | null) =>
  call(
    "GET",
    "/api/v1/models",
    token,
    undefined,
    (b: { models: ModelInfo[] }) => {
      if (!Array.isArray(b.models)) throw new Error("shape");
      return b.models;
    },
  );

export const createModel = (token: string | null, input: ModelInput) =>
  call("POST", "/api/v1/models", token, input, (b: ModelInfo) => b);

export const setDefaultModel = (token: string | null, id: string) =>
  call(
    "PATCH",
    `/api/v1/models/${enc(id)}`,
    token,
    { isDefault: true },
    (b: ModelInfo) => b,
  );

export const deleteModel = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/models/${enc(id)}`, token, undefined, () => {});

export const testModel = (token: string | null, input: ModelInput) =>
  call(
    "POST",
    "/api/v1/models/test",
    token,
    input,
    (b: { ok: boolean; error?: string }) => {
      if (typeof b.ok !== "boolean") throw new Error("shape");
      return b;
    },
  );

export type VariableScope = "any" | "domain" | "sudo";

// 隐私变量的元数据；值只写入，接口永不返回。
export interface VariableInfo {
  id: string;
  name: string;
  purpose: string;
  scopeKind: VariableScope;
  scopeTarget: string | null;
  tier: Tier;
  // false：值太短，输出回显不会被遮罩。
  maskable: boolean;
  createdAt: string;
}

export interface VariableInput {
  name: string;
  purpose: string;
  scopeKind: VariableScope;
  scopeTarget: string | null;
  tier: Tier;
  value: string;
}

export const listVariables = (token: string | null) =>
  call(
    "GET",
    "/api/v1/variables",
    token,
    undefined,
    (b: { variables: VariableInfo[] }) => {
      if (!Array.isArray(b.variables)) throw new Error("shape");
      return b.variables;
    },
  );

export const createVariable = (token: string | null, input: VariableInput) =>
  call("POST", "/api/v1/variables", token, input, (b: VariableInfo) => b);

// 不带 value 则保留原值。
export const patchVariable = (
  token: string | null,
  id: string,
  body: Partial<VariableInput>,
) =>
  call(
    "PATCH",
    `/api/v1/variables/${enc(id)}`,
    token,
    body,
    (b: VariableInfo) => b,
  );

export const deleteVariable = (token: string | null, id: string) =>
  call("DELETE", `/api/v1/variables/${enc(id)}`, token, undefined, () => {});

// ---- 能力库：skill / MCP（ADR-0055、ADR-0056）----

export interface EnvironmentInfo {
  id: string;
  name: string;
  kind: "local" | "ssh";
}

export interface SecretInfo {
  id: string;
  name: string;
  kind: string;
}

export const listEnvironments = (token: string | null) =>
  call(
    "GET",
    "/api/v1/environments",
    token,
    undefined,
    (b: { environments: EnvironmentInfo[] }) => {
      if (!Array.isArray(b.environments)) throw new Error("shape");
      return b.environments;
    },
  );

export const listSecrets = (token: string | null) =>
  call(
    "GET",
    "/api/v1/secrets",
    token,
    undefined,
    (b: { secrets: SecretInfo[] }) => {
      if (!Array.isArray(b.secrets)) throw new Error("shape");
      return b.secrets;
    },
  );

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
  workspaceId: string;
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
  workspaceId?: string,
) =>
  call(
    "GET",
    `/api/v1/environments/${enc(environmentId)}/skills${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ""}`,
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
    workspaceId?: string;
  },
) => call("POST", "/api/v1/skills/import", token, body, (b: SkillInfo) => b);

export const getWorkspaceNames = (
  token: string | null,
  workspaceId: string,
  kind: "skills" | "mcp",
) =>
  call(
    "GET",
    `/api/v1/workspaces/${enc(workspaceId)}/${kind}`,
    token,
    undefined,
    (b: { names: string[] }) => {
      if (!Array.isArray(b.names)) throw new Error("shape");
      return b.names;
    },
  );

export const setWorkspaceNames = (
  token: string | null,
  workspaceId: string,
  kind: "skills" | "mcp",
  names: string[],
) =>
  call(
    "PUT",
    `/api/v1/workspaces/${enc(workspaceId)}/${kind}`,
    token,
    { names },
    (b: { names: string[] }) => b.names,
  );

export const getSkillSync = (token: string | null, workspaceId: string) =>
  call(
    "GET",
    `/api/v1/workspaces/${enc(workspaceId)}/skills/sync`,
    token,
    undefined,
    (b: { report: SyncReport | null }) => b.report,
  );

export const runSkillSync = (token: string | null, workspaceId: string) =>
  call(
    "POST",
    `/api/v1/workspaces/${enc(workspaceId)}/skills/sync`,
    token,
    undefined,
    (b: { report: SyncReport }) => b.report,
  );

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
