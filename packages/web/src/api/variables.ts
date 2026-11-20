import { enc, request } from "./http";

// 隐私变量：文本 / 文件两种类型，名称文法 [a-z][a-z0-9_.-]{2,47}；可填一个变量组名；
// 默认对所有工作区都不可见，工作区「启用」了才可见（`workspaces` 是启用它的工作区 id）。

export type VarPolicy = "allow" | "ask" | "deny";
export type VarKind = "text" | "file";
export type VarExpiry =
  | { kind: "never" }
  | { kind: "days"; days: number }
  | { kind: "at"; at: string };
export interface VariableFile {
  name: string;
  bytes: number;
  lines: number;
  sha256: string;
}

export interface VariableView {
  id: string;
  name: string;
  /** 进上下文的描述（旧字段 purpose 与它同值）。 */
  desc: string;
  /** 所属变量组；null = 不分组。 */
  group: string | null;
  /** 启用它的工作区 id，升序。 */
  workspaces: string[];
  kind: VarKind;
  /** false：值太短（不足 8 个字符），命令输出里回显了也遮挡不住。 */
  maskable: boolean;
  /** 只回遮罩值；文件型没有。 */
  valueMasked?: string;
  file?: VariableFile;
  policy: VarPolicy;
  expiry: VarExpiry;
  expiresAt?: string;
  expired: boolean;
  owner: "user";
  createdAt: string;
  rotatedAt?: string;
  lastUsedAt?: string;
}

export interface NewVariable {
  name: string;
  desc: string;
  group?: string | null;
  /** 创建时顺手启用的工作区。 */
  workspaces?: string[];
  kind: VarKind;
  value: string;
  fileName?: string;
  policy: VarPolicy;
  expiry: VarExpiry;
}

export interface VariablePatch {
  desc?: string;
  group?: string | null;
  policy?: VarPolicy;
  expiry?: VarExpiry;
}

export interface RevealedValue {
  id: string;
  name: string;
  kind: VarKind;
  value: string;
}

const VARIABLES = "/api/v1/variables";

export const fetchVariables = async (token: string | null) =>
  (await request<{ variables: VariableView[] }>("GET", VARIABLES, token))
    .variables;

export const addVariable = (token: string | null, input: NewVariable) =>
  request<VariableView>("POST", VARIABLES, token, input);

export const editVariable = (
  token: string | null,
  id: string,
  patch: VariablePatch,
) => request<VariableView>("PATCH", `${VARIABLES}/${enc(id)}`, token, patch);

export const rotateVariable = (
  token: string | null,
  id: string,
  body: { value: string; fileName?: string },
) =>
  request<VariableView>("POST", `${VARIABLES}/${enc(id)}/rotate`, token, body);

/** 显式看值：服务端记审计，响应 no-store；8 秒后重新遮罩由界面负责。 */
export const revealVariable = (token: string | null, id: string) =>
  request<RevealedValue>("POST", `${VARIABLES}/${enc(id)}/reveal`, token);

export const removeVariable = (token: string | null, id: string) =>
  request("DELETE", `${VARIABLES}/${enc(id)}`, token);

// ---- 引用记录 ----

export type RefResult = "ok" | "denied" | "expired" | "unknown" | "dropped";

export interface ReferenceView {
  id: string;
  name: string;
  directoryId: string;
  hostId: string;
  runId?: string;
  toolCallId: string;
  at: string;
  result: RefResult;
  /** 含占位符的那段命令原文（服务端已遮罩、截到 500 字符）；旧记录与非命令调用没有。 */
  command?: string;
}

export interface ReferencePage {
  references: ReferenceView[];
  /** 下一页的翻页游标；没有更早的记录时为 null。 */
  nextBefore: number | null;
}

export const fetchReferences = (
  token: string | null,
  q: { directory?: string; name?: string; before?: number } = {},
) => {
  const qs = new URLSearchParams();
  if (q.directory) qs.set("directory", q.directory);
  if (q.name) qs.set("name", q.name);
  if (q.before !== undefined) qs.set("before", String(q.before));
  const tail = qs.size ? `?${qs}` : "";
  return request<ReferencePage>("GET", `/api/v1/references${tail}`, token);
};

// ---- 变量组与工作区启用关系 ----

/** 整份替换「哪些工作区启用了这个变量」。 */
export const setVariableWorkspaces = (
  token: string | null,
  id: string,
  workspaces: string[],
) =>
  request<VariableView>("PUT", `${VARIABLES}/${enc(id)}/workspaces`, token, {
    workspaces,
  });

export const fetchWorkspaceVariables = async (
  token: string | null,
  workspaceId: string,
) =>
  (
    await request<{ variables: string[] }>(
      "GET",
      `/api/v1/workspaces/${enc(workspaceId)}/variables`,
      token,
    )
  ).variables;

/** 整份替换某个工作区启用的变量（id 清单）。 */
export const setWorkspaceVariables = async (
  token: string | null,
  workspaceId: string,
  variables: string[],
) =>
  (
    await request<{ variables: string[] }>(
      "PUT",
      `/api/v1/workspaces/${enc(workspaceId)}/variables`,
      token,
      { variables },
    )
  ).variables;

/** 改组名；改到已有的组名就是合并。 */
export const renameVariableGroup = (
  token: string | null,
  name: string,
  to: string,
) =>
  request<{ renamed: number }>(
    "PUT",
    `/api/v1/variable-groups/${enc(name)}`,
    token,
    { name: to },
  );

/** 解散组：成员回到「不分组」，变量本身不动。 */
export const dissolveVariableGroup = (token: string | null, name: string) =>
  request("DELETE", `/api/v1/variable-groups/${enc(name)}`, token);
