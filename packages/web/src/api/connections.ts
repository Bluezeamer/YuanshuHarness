import { enc, request } from "./http";

// 与服务端 packages/server/src/api/connections.ts 的视图一一对应。

export type ConnectionStatus =
  | "active"
  | "inactive"
  | "verify-required"
  | "activating";

export type HostKeyPolicy = "ask" | "tofu";
export type OsType = "posix" | "windows";

export interface ConnectionPolicy {
  keepAlive: boolean;
  /** 服务端只存不生效。 */
  reuseSession: boolean;
  hostKey: HostKeyPolicy;
  /** 服务端只存不生效。 */
  proxyJumpFallback: boolean;
}

export interface ConnectionRef {
  id: string;
  label: string;
}

export interface HostKeyRecord {
  fingerprint: string;
  keyType: string;
  changedFrom: string | null;
  acceptedAt: string | null;
}

/** 待核对的指纹；首次连接时 old 为 null。 */
export interface HostKeyChange {
  old: string | null;
  new: string;
  oldType: string | null;
  newType: string;
  changedFrom: string | null;
}

export type StepState = "pending" | "running" | "done" | "failed";

export interface ActivationStep {
  id: ActivationStepId;
  name: string;
  state: StepState;
  ms?: number;
  detail?: string;
}

export interface Activation {
  state: "running" | "done" | "failed";
  steps: ActivationStep[];
  failedStage?: ActivationStepId;
  code?: string;
  message?: string;
}

/** 激活的六步，顺序即服务端的执行顺序；id 是线上取值，name 只用于展示。 */
export const ACTIVATION_STEPS = [
  { id: "resolve", name: "解析主机" },
  { id: "tcp", name: "TCP 连接" },
  { id: "hostkey", name: "主机密钥" },
  { id: "auth", name: "认证" },
  { id: "probe", name: "远端探测" },
  { id: "channel", name: "控制通道" },
] as const;

export type ActivationStepId = (typeof ACTIVATION_STEPS)[number]["id"];

export interface ConnectionView {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  os: OsType;
  /** kind 为 null：没有可用的凭据（登记时未带密码）。 */
  auth: { kind: "key" | "password" | null; secretId: string | null };
  /** 直接跳板（至多一个）。 */
  jump: string[];
  /** 从最外层到直接跳板的完整链。 */
  chain: ConnectionRef[];
  /** 直接以它为跳板的下游。 */
  dependants: ConnectionRef[];
  policy: ConnectionPolicy;
  status: ConnectionStatus;
  /** 登记信息已改，但在用的连接仍是激活时的旧配置。 */
  dirty: boolean;
  hostKey: HostKeyRecord | null;
  hostKeyChange: HostKeyChange | null;
  lastActiveAt: string | null;
  createdAt: string;
  activation: Activation | null;
}

export interface ServerHost {
  host: string;
  environmentId: string;
  label: string;
}

export interface ConnectionList {
  server: ServerHost;
  connections: ConnectionView[];
}

export interface CreateConnectionInput {
  label: string;
  host: string;
  port: number;
  user: string;
  os?: OsType;
  auth: { secretId: string; kind?: "key" | "password" };
  jump?: string[];
  policy?: Partial<ConnectionPolicy>;
}

export type UpdateConnectionInput = Partial<
  Omit<CreateConnectionInput, "policy">
> & { policy?: Partial<ConnectionPolicy> };

export interface Deactivated {
  deactivated: ConnectionRef[];
  connection: ConnectionView;
}

export type LogType = "activate" | "fail" | "disconnect" | "hostkey" | "config";
export const LOG_TYPES: readonly LogType[] = [
  "activate",
  "fail",
  "disconnect",
  "hostkey",
  "config",
];

export interface LogEntry {
  id: number;
  at: string;
  type: LogType;
  text: string;
  detail: string;
}

export interface LogPage {
  log: LogEntry[];
  nextBefore: number | null;
}

// 抛错式调用（ApiError）：400 的 code 是校验码；409 见各函数；404 not_found。
const base = "/api/v1/connections";
const one = (id: string) => `${base}/${enc(id)}`;

export const listConnections = (token: string | null) =>
  request<ConnectionList>("GET", base, token);

export const getConnection = (token: string | null, id: string) =>
  request<ConnectionView>("GET", one(id), token);

/** 409：name_exists，或 jump_not_found / jump_cycle / jump_too_deep。 */
export const createConnection = (
  token: string | null,
  input: CreateConnectionInput,
) => request<ConnectionView>("POST", base, token, input);

/** 409：activating（激活中不许改地址类字段）/ name_exists / jump_*。 */
export const updateConnection = (
  token: string | null,
  id: string,
  input: UpdateConnectionInput,
) => request<ConnectionView>("PATCH", one(id), token, input);

/** 409：active | referenced{referencedBy} | in_use{directories}。 */
export const deleteConnection = (token: string | null, id: string) =>
  request("DELETE", one(id), token);

/**
 * 202 立即返回；之后轮询 getConnection 的 activation。
 * 409：activating | busy{activating}（另一条连接正在激活）| already_active | jump_inactive{jump} | verify_required{hostKeyChange}。
 */
export const activateConnection = (token: string | null, id: string) =>
  request<ConnectionView>("POST", `${one(id)}/activate`, token);

/** 断开自己并递归暂停下游；deactivated 里自己在最前。 */
export const deactivateConnection = (token: string | null, id: string) =>
  request<Deactivated>("POST", `${one(id)}/deactivate`, token);

/** 接受待核对的指纹；409 nothing_to_trust。信任后需要再次 activate。 */
export const trustHostKey = (token: string | null, id: string) =>
  request<ConnectionView>("POST", `${one(id)}/trust`, token);

/** 新的在前；before 是上一页的 nextBefore。 */
export const getConnectionLog = (
  token: string | null,
  id: string,
  opts: { limit?: number; before?: number } = {},
) => {
  const q = new URLSearchParams();
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.before !== undefined) q.set("before", String(opts.before));
  const qs = q.toString();
  return request<LogPage>("GET", `${one(id)}/log${qs ? `?${qs}` : ""}`, token);
};

// ---- 凭据（密钥页与新建连接用；/secrets 的列表在这里多带了指纹与引用者） ----

export interface Credential {
  id: string;
  name: string;
  kind: "ssh_key" | "password";
  createdAt: string;
  /** 仅 ssh_key；私钥解析不了（带口令、格式不认识）时为 null。 */
  fingerprint?: string | null;
  keyType?: string | null;
  /** 引用它的连接。 */
  referencedBy: ConnectionRef[];
}

export const listCredentials = async (token: string | null) =>
  (await request<{ secrets: Credential[] }>("GET", "/api/v1/secrets", token))
    .secrets;

/** 400：invalid_name / invalid_kind / invalid_value；409：name_exists。 */
export const createCredential = (
  token: string | null,
  input: { name: string; kind: Credential["kind"]; value: string },
) =>
  request<{ id: string; name: string; kind: string }>(
    "POST",
    "/api/v1/secrets",
    token,
    input,
  );

/** 409：in_use。 */
export const deleteCredential = (token: string | null, id: string) =>
  request("DELETE", `/api/v1/secrets/${enc(id)}`, token);
