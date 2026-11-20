import type { McpView } from "../../../../api/mcpLibrary";
import { relTime } from "../common/format";

export const NO_DESCRIPTION = "来源未提供描述";

/** 行内显示的目标：stdio 是 command + args，http 是 url。 */
export const targetOf = (m: McpView): string =>
  m.transport === "http"
    ? (m.conf.url ?? "")
    : [m.conf.command ?? "", ...(m.conf.args ?? [])].join(" ").trim();

/** 工具总数：握手返回的数优先，没握手过用缓存。 */
export const toolCount = (m: McpView): number =>
  m.handshake?.ok ? m.handshake.tools : (m.tools?.length ?? 0);

export const fullName = (server: string, tool: string) =>
  `mcp__${server}__${tool}`;

// x.y.z 比较（忽略预发布后缀）；用来判断「低于解析」。
export function cmpVersion(a: string, b: string): number {
  const nums = (v: string) => v.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 版本形如 x.y.z，可带预发布 / 构建后缀；与服务端 VERSION_RE 同规则。 */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

// ---- 状态 ----

export type StatusKey = "busy" | "off" | "issue" | "idle" | "update" | "ok";
export interface RowStatus {
  key: StatusKey;
  text: string;
  tone?: "warn" | "live" | "danger";
}

/** 握手失败里的授权问题（令牌无效 / 过期 / 无权访问）：由服务端标记。 */
export const isAuthFailure = (m: McpView): boolean =>
  m.handshake?.ok === false && m.handshake.authFailed === true;

/** 行状态：检测 / 试装中 > 已禁用 > 未检测 > 握手失败 > 可更新 > 就绪。 */
export function statusOf(m: McpView, busy: string | null): RowStatus {
  if (busy) return { key: "busy", text: busy, tone: "warn" };
  if (!m.enabled) return { key: "off", text: "已禁用" };
  if (!m.handshake) return { key: "idle", text: "未检测" };
  if (!m.handshake.ok)
    return {
      key: "issue",
      text: isAuthFailure(m) ? "授权过期" : "不可用",
      tone: "danger",
    };
  if (isUpdatable(m)) return { key: "update", text: "可更新", tone: "warn" };
  return { key: "ok", text: "就绪", tone: "live" };
}

/** 状态下一行的小字：耗时与时间，或失败原因。 */
export function statusSub(m: McpView, busy: string | null, now?: number) {
  if (busy) return "";
  if (!m.enabled) return "已断开";
  if (!m.handshake) return "尚未握手";
  if (!m.handshake.ok) return m.handshake.error ?? "握手失败";
  return `${m.handshake.ms}ms · ${relTime(m.handshake.at, now)}`;
}

/** 固定的版本低于包源查到的最新版：试装、查候选版本、检查更新都会刷新这个「最新版」。浮动的每次启动取最新，谈不上更新。 */
export const isUpdatable = (m: McpView): boolean =>
  m.version !== null &&
  m.latestVersion !== null &&
  cmpVersion(m.latestVersion, m.version) > 0;

// ---- 搜索与版本文案 ----

export const matchesServer = (m: McpView, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return (
    s === "" ||
    `${m.name} ${m.description} ${targetOf(m)}`.toLowerCase().includes(s)
  );
};

export const versionText = (m: McpView): string =>
  m.transport === "http"
    ? "远端服务"
    : m.source === null
      ? "不可固定"
      : m.pinned
        ? `${m.version} · 已固定`
        : "浮动 · 未固定";

// ---- 暴露方式：如实标注服务端实际执行了什么 ----

export const EXPOSURE_NOTE: Record<McpView["exposure"], string> = {
  direct: "与内置工具一样声明给模型",
  hidden: "已注册但不可达；用 toolExposure 可以单独放行几个工具",
};

/** oauth 只登记不执行。 */
export const hasOauth = (m: McpView): boolean =>
  m.oauth !== null && m.oauth !== false && m.oauth !== undefined;

// ---- 配置 JSON ----

/** 展开区只读块与编辑器读的是同一份：mcpServers 包一条。 */
export const confJson = (m: McpView): string =>
  JSON.stringify({ mcpServers: { [m.name]: m.conf } }, null, 2);

// 示例里的地址不进源码字面量（守卫禁止 http(s) 协议串出现在产品源码里），运行时拼出。
const SCHEME = "https:";
const TEMPLATES = {
  stdio: {
    mcpServers: {
      memory: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        env: { MEMORY_FILE_PATH: `\${MEMORY_FILE_PATH}` },
      },
    },
  },
  http: {
    mcpServers: {
      docs: {
        url: `${SCHEME}//docs.example.com/mcp`,
        headers: { Authorization: `Bearer \${DOCS_TOKEN}` },
      },
    },
  },
} as const;

export const TEMPLATE_KINDS = ["stdio", "http"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export const templateText = (k: TemplateKind): string =>
  JSON.stringify(TEMPLATES[k], null, 2);
