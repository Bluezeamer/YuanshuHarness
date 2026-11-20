// 隐私变量页的纯逻辑：分段、状态、有效期说明、文案与时间格式化。与 React 解耦。
import type {
  ReferenceView,
  RefResult,
  VarExpiry,
  VariableView,
  VarPolicy,
} from "../../../api/variables";
import { fmtDateTime } from "../../../ui/time";

/** 新文法：小写字母开头，3–48 位。`{{@名称}}` 的收尾由 `}}` 给出，所以允许 `.` 与 `-`。 */
export const NAME_RE = /^[a-z][a-z0-9_.-]{2,47}$/;
export const NAME_ERROR =
  "名称需小写字母开头，3–48 位，可含小写字母、数字、下划线、点与连字符。";
export const DESC_MAX = 500;
export const DESC_ERROR = "写一句描述：agent 只靠它判断什么时候该引用。";
export const GROUP_MAX = 32;
export const GROUP_ERROR = `变量组名称 1–${GROUP_MAX} 个字符。`;
export const VALUE_MIN = 4;
export const VALUE_MAX = 16 * 1024;
export const DAYS_MAX = 365;

export const POLICIES: readonly VarPolicy[] = ["allow", "ask", "deny"];
export const POLICY_LABEL: Record<VarPolicy, string> = {
  allow: "自动放行",
  ask: "每次批准",
  deny: "禁止",
};
export const POLICY_HINT: Record<VarPolicy, string> = {
  allow: "引用时直接放行，仍然写审计；适合只读、低权限的值。",
  ask: "命令停在闸门等你批准；批准只对那一次有效，不产生长期授权。",
  deny: "引用直接失败，不弹批准；名字留着，等你改策略。",
};

/** 页面上直接编辑的那几项：进草稿，点保存才落库（ys-ui-design 的 X06）。 */
export interface Editable {
  desc: string;
  group: string | null;
  policy: VarPolicy;
  expiry: VarExpiry;
  /** 启用它的工作区 id，升序。 */
  workspaces: string[];
}

export const editableOf = (v: VariableView): Editable => ({
  desc: v.desc,
  group: v.group,
  policy: v.policy,
  expiry: v.expiry,
  workspaces: [...v.workspaces].sort(),
});

export const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// ---- 左列表 ----

export interface VarSection {
  /** 组名；未分组为 ""。 */
  key: string;
  /** 未分组段的标题固定叫「未分组」，组头可重命名 / 解散的只有真正的组。 */
  name: string;
  isGroup: boolean;
  items: VariableView[];
}

export const matchesQuery = (v: VariableView, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return (
    !s || v.name.toLowerCase().includes(s) || v.desc.toLowerCase().includes(s)
  );
};

export const groupNames = (vars: readonly VariableView[]): string[] =>
  [...new Set(vars.map((v) => v.group).filter((g): g is string => !!g))].sort(
    (a, b) => a.localeCompare(b),
  );

/** 组按名称排，「未分组」在最后；段内按名称排；没有命中的段不出现。 */
export function sectionsOf(
  vars: readonly VariableView[],
  query: string,
): VarSection[] {
  const hit = vars.filter((v) => matchesQuery(v, query));
  const byName = (a: VariableView, b: VariableView) =>
    a.name.localeCompare(b.name);
  return [
    ...groupNames(vars).map((g) => ({
      key: g,
      name: g,
      isGroup: true,
      items: hit.filter((v) => v.group === g).sort(byName),
    })),
    {
      key: "",
      name: "未分组",
      isGroup: false,
      items: hit.filter((v) => !v.group).sort(byName),
    },
  ].filter((s) => s.items.length > 0);
}

/** 悬停详情卡片里的键值：只放行里没有的信息（X05）。 */
export function peekFacts(
  v: VariableView,
  workspaces: readonly { id: string; name: string }[],
  now: number,
): [string, string][] {
  const names = v.workspaces.map(
    (id) => workspaces.find((w) => w.id === id)?.name ?? id,
  );
  return [
    ["变量组", v.group ?? "未分组"],
    ["类型", v.kind === "file" ? "文件" : "文本"],
    ["策略", POLICY_LABEL[v.policy]],
    ["有效期", expiryLine(v.expiry, v, now)],
    [
      "启用于",
      names.length === 0
        ? "没有工作区"
        : names.length <= 3
          ? names.join("、")
          : `${names.slice(0, 3).join("、")} 等 ${names.length} 个`,
    ],
    ["最近引用", v.lastUsedAt ? relTime(v.lastUsedAt, now) : "还没被引用过"],
  ];
}

// ---- 状态 ----

export interface Status {
  tone: "live" | "warn" | "danger" | "idle";
  label: string;
}

/** 详情页头的状态：过期 > 禁止 > 没启用 > 已启用 N 个工作区。 */
export function statusOf(v: VariableView): Status {
  if (v.expired) return { tone: "warn", label: "已过期" };
  if (v.policy === "deny") return { tone: "danger", label: "已禁止" };
  if (v.workspaces.length === 0) return { tone: "idle", label: "未启用" };
  return { tone: "live", label: `已启用 ${v.workspaces.length} 个工作区` };
}

/** 左列表行尾只在有话要说时才出字：平时是空的。 */
export const railTrail = (v: VariableView): string | undefined =>
  v.expired
    ? "已过期"
    : v.policy === "deny"
      ? "已禁止"
      : v.workspaces.length === 0
        ? "未启用"
        : undefined;

// ---- 有效期 ----

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "从未";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `<input type="datetime-local">` 的值（本地时间，到分钟）。 */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const daysLeft = (ms: number, now: number) =>
  Math.max(0, Math.ceil((ms - now) / DAY));

/** 有效期的一句话说明；按「草稿里的有效期」算，days 型从最近一次写入值起滚动。 */
export function expiryLine(
  e: VarExpiry,
  v: Pick<VariableView, "rotatedAt" | "createdAt">,
  now: number,
): string {
  if (e.kind === "never") return "永久有效：不会自动失效，直到你删除它。";
  if (e.kind === "at") {
    const at = Date.parse(e.at);
    return at <= now
      ? `已在 ${fmtDateTime(e.at)} 失效，轮换并重设有效期才能恢复。`
      : `${fmtDateTime(e.at)} 失效，还有 ${daysLeft(at, now)} 天。`;
  }
  const end = Date.parse(v.rotatedAt ?? v.createdAt) + e.days * DAY;
  return end <= now
    ? `从写入当天起算 ${e.days} 天，已过期，先轮换。`
    : `从写入当天起算 ${e.days} 天，还有 ${daysLeft(end, now)} 天。`;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

/** sha256 指纹只显示前 8 位，与「只回显指纹」的约定一致。 */
export const fingerprint = (sha: string): string => sha.slice(0, 8);

// ---- 引用记录 ----

export type RefFilter = "all" | "ok" | "fail";

export const RESULT_LABEL: Record<RefResult, string> = {
  ok: "放行",
  denied: "拒绝",
  expired: "已过期",
  unknown: "名称不存在",
  dropped: "已丢弃",
};

export const refPasses = (r: ReferenceView, f: RefFilter): boolean =>
  f === "all" || (f === "ok") === (r.result === "ok");
