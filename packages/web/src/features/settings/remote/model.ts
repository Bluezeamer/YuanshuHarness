// 远程连接页的纯逻辑：分组、状态、校验、跳板约束与断开影响面。与 React 解耦，单测直接调用。
import type {
  ConnectionRef,
  ConnectionView,
  HostKeyPolicy,
  LogEntry,
  LogType,
  UpdateConnectionInput,
} from "../../../api/connections";
import type { DotProps } from "../../../ui";

/** 跳板链最长几跳（与服务端 MAX_JUMP_DEPTH 一致）。 */
export const MAX_JUMP_DEPTH = 4;

export type GroupId = "active" | "pending" | "off";

export interface ConnState {
  group: GroupId;
  tone: NonNullable<DotProps["tone"]>;
  motion?: DotProps["motion"];
  label: string;
}

/** 列表分组与状态点：激活中 > 待核对 > 最近一次激活失败 > 已断开。 */
export function stateOf(c: ConnectionView): ConnState {
  if (c.status === "activating")
    return { group: "off", tone: "accent", motion: "pulse", label: "激活中" };
  if (c.status === "active")
    return {
      group: "active",
      tone: "live",
      motion: "breathe",
      label: "已激活",
    };
  if (c.hostKeyChange !== null)
    return { group: "pending", tone: "warn", label: "待核对" };
  if (c.activation?.state === "failed")
    return { group: "off", tone: "danger", label: "激活失败" };
  return { group: "off", tone: "idle", label: "已断开" };
}

/** 正在激活的连接：服务端状态或轮询中的激活过程。一次只允许一个（B9）。 */
export const activatingOf = (list: readonly ConnectionView[]) =>
  list.find(
    (c) => c.status === "activating" || c.activation?.state === "running",
  );

export const addrOf = (c: Pick<ConnectionView, "user" | "host" | "port">) =>
  `${c.user}@${c.host}:${c.port}`;

/** 左列表：按名称、主机或用户筛选，已激活在前、待处理次之、其余在后（同级保持原序）。 */
export function visibleConnections(
  list: readonly ConnectionView[],
  query: string,
): ConnectionView[] {
  const q = query.trim().toLowerCase();
  const order: GroupId[] = ["active", "pending", "off"];
  return list
    .filter(
      (c) =>
        q === "" ||
        `${c.label} ${c.host} ${c.user} ${c.port}`.toLowerCase().includes(q),
    )
    .map((c, i) => ({ c, i, rank: order.indexOf(stateOf(c).group) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c);
}

/** 相对时间；缺失时给占位。 */
export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

const hostPort = (c: Pick<ConnectionView, "host" | "port" | "user">) =>
  `${c.user}@${c.host}${c.port === 22 ? "" : `:${c.port}`}`;

/** 复制用的 ssh 命令：跳板链用 -J 逗号串联，从最外层到直接跳板。 */
export function sshCommand(
  c: ConnectionView,
  all: readonly ConnectionView[],
): string {
  const jumps = c.chain
    .map((r) => all.find((x) => x.id === r.id))
    .filter((x): x is ConnectionView => x !== undefined)
    .map(hostPort);
  return `ssh${jumps.length ? ` -J ${jumps.join(",")}` : ""} -p ${c.port} ${c.user}@${c.host}`;
}

// ---- 跳板 ----

const childrenOf = (id: string, all: readonly ConnectionView[]) =>
  all.filter((c) => c.jump[0] === id);

/** 递归下游（不含自己），广度优先。 */
export function descendants(
  id: string,
  all: readonly ConnectionView[],
): ConnectionView[] {
  const out: ConnectionView[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const c of childrenOf(cur, all)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      queue.push(c.id);
    }
  }
  return out;
}

function depthBelow(
  id: string,
  all: readonly ConnectionView[],
  seen = new Set<string>(),
): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  const kids = childrenOf(id, all);
  return kids.length === 0
    ? 0
    : 1 + Math.max(...kids.map((k) => depthBelow(k.id, all, seen)));
}

export interface JumpChoice {
  conn: ConnectionView;
  /** 不能选的原因；null 表示可选。 */
  reason: string | null;
}

/** 跳板候选：前端先拦环路与超深（服务端也会拒）。selfId 为 null 表示新建。 */
export function jumpChoices(
  selfId: string | null,
  all: readonly ConnectionView[],
): JumpChoice[] {
  const below = selfId === null ? [] : descendants(selfId, all);
  const downstream = selfId === null ? 0 : depthBelow(selfId, all);
  return all
    .filter((c) => c.id !== selfId)
    .map((conn) => {
      let reason: string | null = null;
      if (below.some((d) => d.id === conn.id))
        reason = "它经由当前连接跳转，选它会形成环路";
      else if (conn.chain.length + 1 + downstream > MAX_JUMP_DEPTH)
        reason = `跳板链最多 ${MAX_JUMP_DEPTH} 跳，选它会超过`;
      return { conn, reason };
    });
}

// ---- 断开与删除的影响面 ----

/** 断开 c 会连带暂停的已激活下游（广度优先），以及受牵连的会话数。 */
export function disconnectImpact(
  c: ConnectionView,
  all: readonly ConnectionView[],
  sessionsOf: (connectionId: string) => number,
) {
  const downstream = descendants(c.id, all).filter(
    (d) => d.status === "active",
  );
  const sessions = [c, ...downstream].reduce((n, x) => n + sessionsOf(x.id), 0);
  return {
    downstream: downstream.map(
      (d): ConnectionRef => ({
        id: d.id,
        label: d.label,
      }),
    ),
    sessions,
    needsConfirm: sessions > 0 || downstream.length > 0,
  };
}

export interface DeleteGuard {
  /** 不可删除的原因（点名，一句短话，放在菜单项右侧）；null 表示可以走二次确认。 */
  blocked: string | null;
}

/** 删除前的本地守卫：激活中 / 被当作跳板 / 有目录挂载。服务端还会再拒一次。 */
export function deleteGuard(
  c: ConnectionView,
  directories: number,
): DeleteGuard {
  if (c.status === "active" || c.status === "activating")
    return { blocked: "先断开" };
  if (c.dependants.length > 0)
    return {
      blocked: `被${c.dependants.map((d) => `「${d.label}」`).join("、")}当跳板`,
    };
  if (directories > 0) return { blocked: `有 ${directories} 个目录挂载` };
  return { blocked: null };
}

// ---- 详情页的草稿：地址、认证、策略一起编辑、一起保存 ----

export interface Editable {
  host: string;
  port: string;
  user: string;
  /** 直接跳板的连接 id；空串 = 直连 */
  jump: string;
  authKind: "key" | "password";
  keyId: string;
  hostKey: HostKeyPolicy;
  keepAlive: boolean;
}

export const editableOf = (c: ConnectionView): Editable => ({
  host: c.host,
  port: String(c.port),
  user: c.user,
  jump: c.jump[0] ?? "",
  authKind: c.auth.kind === "password" ? "password" : "key",
  keyId: c.auth.kind === "key" ? (c.auth.secretId ?? "") : "",
  hostKey: c.policy.hostKey,
  keepAlive: c.policy.keepAlive,
});

/** 输入框失焦时把首尾空白与前导零收拾掉，免得保存后草稿还和已保存值差一个空格。 */
export const tidy = (e: Editable): Editable => ({
  ...e,
  host: e.host.trim(),
  user: e.user.trim(),
  port: /^\s*\d+\s*$/.test(e.port) ? String(Number(e.port)) : e.port.trim(),
});

export type EditErrors = Partial<
  Record<"host" | "port" | "user" | "auth", string>
>;

/** 保存前的本地校验；认证只在动过它时才校验（没有凭据的连接不该一直标红）。 */
export function validateEdit(
  e: Editable,
  saved: Editable,
  password: string,
): EditErrors {
  const out: EditErrors = {};
  const port = Number(e.port);
  if (!e.host.trim()) out.host = "填写主机名或 IP";
  else if (/\s/.test(e.host.trim())) out.host = "主机不能包含空格";
  if (
    e.port.trim() === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    out.port = "端口必须是 1–65535 的整数";
  if (!e.user.trim()) out.user = "填写登录用户";
  if (e.authKind === "key") {
    if (!e.keyId && (saved.authKind !== "key" || saved.keyId !== ""))
      out.auth = "选择一把私钥";
  } else if (password === "" && saved.authKind !== "password") {
    out.auth = "填写密码";
  }
  return out;
}

/** 草稿相对已保存值的差异，拼成一次 PATCH；密码单独带出，由 store 先建凭据再改指向。 */
export function patchOf(
  e: Editable,
  saved: Editable,
  password: string,
): { input: UpdateConnectionInput; password?: string } {
  const t = tidy(e);
  const input: UpdateConnectionInput = {};
  if (t.host !== saved.host) input.host = t.host;
  if (t.port !== saved.port) input.port = Number(t.port);
  if (t.user !== saved.user) input.user = t.user;
  if (t.jump !== saved.jump) input.jump = t.jump ? [t.jump] : [];
  if (
    t.authKind === "key" &&
    (saved.authKind !== "key" || t.keyId !== saved.keyId)
  )
    input.auth = { secretId: t.keyId, kind: "key" };
  const policy: NonNullable<UpdateConnectionInput["policy"]> = {};
  if (t.hostKey !== saved.hostKey) policy.hostKey = t.hostKey;
  if (t.keepAlive !== saved.keepAlive) policy.keepAlive = t.keepAlive;
  if (Object.keys(policy).length > 0) input.policy = policy;
  return t.authKind === "password" && password !== ""
    ? { input, password }
    : { input };
}

// ---- 新建表单 ----

export interface NewForm {
  label: string;
  host: string;
  port: string;
  user: string;
  authKind: "key" | "password";
  keyId: string;
  password: string;
  jumpId: string;
}

export const EMPTY_FORM: NewForm = {
  label: "",
  host: "",
  port: "22",
  user: "",
  authKind: "key",
  keyId: "",
  password: "",
  jumpId: "",
};

export type FormErrors = Partial<
  Record<"label" | "host" | "port" | "user" | "auth" | "jump", string>
>;

/** 新建表单校验，全部在前端先做；服务端的校验码是兜底。 */
export function validateForm(
  f: NewForm,
  all: readonly ConnectionView[],
): FormErrors {
  const e: FormErrors = {};
  const label = f.label.trim();
  const host = f.host.trim();
  const user = f.user.trim();
  const port = Number(f.port);
  if (!label) e.label = "填写名称";
  else if (all.some((c) => c.label === label)) e.label = "这个名称已被占用";
  if (!host) e.host = "填写主机名或 IP";
  else if (/\s/.test(host)) e.host = "主机不能包含空格";
  if (
    f.port.trim() === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    e.port = "端口必须是 1–65535 的整数";
  if (!user) e.user = "填写登录用户";
  if (f.authKind === "key" && !f.keyId) e.auth = "选择一把私钥";
  if (f.authKind === "password" && f.password === "") e.auth = "填写密码";
  if (!e.host && !e.port && !e.user) {
    const dup = all.find(
      (c) => c.host === host && c.port === port && c.user === user,
    );
    if (dup) e.host = `已有相同主机、端口和用户的连接「${dup.label}」`;
  }
  if (f.jumpId) {
    const choice = jumpChoices(null, all).find((j) => j.conn.id === f.jumpId);
    if (!choice) e.jump = "跳板机不存在，重新选择";
    else if (choice.reason) e.jump = choice.reason;
  }
  return e;
}

// ---- 日志 ----

export const LOG_LABEL: Record<LogType, string> = {
  activate: "激活",
  disconnect: "断开",
  hostkey: "主机密钥",
  fail: "失败",
  config: "配置",
};

export const LOG_TONE: Record<LogType, NonNullable<DotProps["tone"]>> = {
  activate: "live",
  disconnect: "idle",
  hostkey: "warn",
  fail: "danger",
  config: "idle",
};

export type LogRow = LogEntry & { connectionId: string; connection: string };

export const logCounts = (rows: readonly LogRow[]) => {
  const counts: Record<LogType | "all", number> = {
    all: rows.length,
    activate: 0,
    disconnect: 0,
    hostkey: 0,
    fail: 0,
    config: 0,
  };
  for (const r of rows) counts[r.type] += 1;
  return counts;
};

/** 多条连接的日志合并：新的在前（按时间，同刻按 id）。 */
export const mergeLogs = (rows: readonly LogRow[]): LogRow[] =>
  [...rows].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
