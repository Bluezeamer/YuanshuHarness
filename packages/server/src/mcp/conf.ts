// MCP 配置入口：一段 mcpServers JSON（与 pi 的 mcpServers 条目同形）。校验规则见 brand-spec「设置页（工具与能力）」。
// 逐条给诊断（error 阻止保存，warning 只提示），而不是遇到第一个问题就停。

import { isObject } from "../lib/validate.js";
import {
  EXPOSURES,
  type Exposure,
  isExposure,
  type McpConfig,
  type McpEntry,
  type McpOptions,
  type McpServerMeta,
  parseMcpConfig,
} from "../store/mcp.js";

export interface McpDiagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  /** 出问题的字段，如 "env" / "command"；整体性问题没有。 */
  field?: string;
}

export interface McpDraft {
  name: string;
  config: McpConfig;
  options: McpOptions;
  /** 编辑器右侧预览用：只含解析出的名称、传输、目标与 env / headers 数量。 */
  preview: {
    name: string;
    transport: "stdio" | "http";
    target: string;
    envCount: number;
    headerCount: number;
  };
}

export interface McpJsonResult {
  ok: boolean;
  diagnostics: McpDiagnostic[];
  /** 没有 error 时才有。 */
  draft: McpDraft | null;
}

export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

// 从别处粘来的 pi 配置常带 codemode / deferred：说明为什么不支持，而不只是列出可选值。
const REMOVED_NOTE =
  "（codemode / deferred 已不支持：MCP 工具一律直接声明给模型）";

// 条目允许的键；description 取自包元数据 / 握手，手填会被忽略（见下）。
const KNOWN_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "oauth",
  "timeout",
  "enabled",
  "exposure",
  "toolExposure",
  "description",
]);

const isStringMap = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every((x) => typeof x === "string");

// 值是 `<前缀>${secret:<id>}` 就当密码库引用（编辑器回显的形式），否则是明文，其中 ${VAR} 取 Server 环境。
const SECRET_REF = /^(.*?)\$\{secret:([^}]+)\}$/s;

function toEntries(map: Record<string, string>): McpEntry[] {
  return Object.entries(map).map(([key, value]) => {
    const m = SECRET_REF.exec(value);
    return m
      ? { key, secretId: m[2] as string, ...(m[1] ? { prefix: m[1] } : {}) }
      : { key, value };
  });
}

/** 把登记的 env / headers 还原成 JSON 里的字符串表；密码库引用写成 ${secret:id}，不泄露值。 */
function toMap(entries: McpEntry[]): Record<string, string> {
  return Object.fromEntries(
    entries.map((e) => [
      e.key,
      e.secretId === undefined
        ? (e.value ?? "")
        : `${e.prefix ?? ""}\${secret:${e.secretId}}`,
    ]),
  );
}

/** 登记条目 → mcpServers 里的那一条（启用与暴露状态取当前值，固定版本改的 args 已在其中）。 */
export function toConf(meta: McpServerMeta): Record<string, unknown> {
  const c = meta.config;
  const e: Record<string, unknown> = {};
  if (c.transport === "stdio") {
    e.command = c.command;
    if (c.args.length) e.args = c.args;
    if (c.env.length) e.env = toMap(c.env);
    if (c.cwd) e.cwd = c.cwd;
  } else {
    e.url = c.url;
    if (c.headers.length) e.headers = toMap(c.headers);
  }
  if (meta.timeout !== null) e.timeout = meta.timeout;
  e.exposure = meta.exposure;
  if (!meta.enabled) e.enabled = false;
  if (Object.keys(meta.toolExposure).length) e.toolExposure = meta.toolExposure;
  if (meta.oauth !== null) e.oauth = meta.oauth;
  return e;
}

export interface McpJsonDeps {
  /** 密码库里是否有这个条目。 */
  secretExists: (id: string) => boolean;
  /** 与名字重名（- 与 _ 同、不分大小写）的已有条目；编辑自己时调用方应排除自己。 */
  conflict: (name: string) => string | undefined;
}

export function parseMcpJson(input: unknown, deps: McpJsonDeps): McpJsonResult {
  const diagnostics: McpDiagnostic[] = [];
  const error = (code: string, message: string, field?: string) =>
    diagnostics.push({
      level: "error",
      code,
      message,
      ...(field ? { field } : {}),
    });
  const warn = (code: string, message: string, field?: string) =>
    diagnostics.push({
      level: "warning",
      code,
      message,
      ...(field ? { field } : {}),
    });
  const fail = (): McpJsonResult => ({ ok: false, diagnostics, draft: null });

  let doc: unknown = input;
  if (typeof input === "string") {
    if (input.trim() === "") {
      error("empty", "先填配置 JSON");
      return fail();
    }
    try {
      doc = JSON.parse(input);
    } catch (e) {
      error(
        "invalid_json",
        `JSON 解析失败 · ${e instanceof Error ? e.message : String(e)}`,
      );
      return fail();
    }
  }
  if (!isObject(doc)) {
    error("not_object", "顶层要是对象");
    return fail();
  }
  const servers = doc.mcpServers;
  if (!isObject(servers)) {
    error(
      "no_mcp_servers",
      '需要 mcpServers 包装 · {"mcpServers":{"名称":{…}}}',
      "mcpServers",
    );
    return fail();
  }
  const keys = Object.keys(servers);
  if (keys.length !== 1) {
    error(
      "not_single",
      keys.length
        ? `一次只添加一个服务 · 当前 ${keys.length} 个`
        : "mcpServers 里还没有条目",
      "mcpServers",
    );
    return fail();
  }
  const name = keys[0] as string;
  const e = servers[name];
  if (!MCP_NAME_RE.test(name))
    error("invalid_name", "名称只能用字母、数字、_ 和 -，1–32 位", "name");
  else {
    const hit = deps.conflict(name);
    if (hit !== undefined)
      error(
        "name_exists",
        hit === name
          ? `同名服务已存在：${hit}`
          : `同名服务已存在：${hit}（- 与 _ 视为相同，不分大小写）`,
        "name",
      );
  }
  if (!isObject(e)) {
    error("entry_not_object", "条目要是对象", name);
    return fail();
  }

  if (e.type === "sse")
    error("sse", "不支持 sse · 用 streamable HTTP，通常路径是 /mcp", "type");
  else if (
    e.type != null &&
    !["stdio", "http", "streamable-http"].includes(e.type as string)
  )
    error("invalid_type", "type 只能是 stdio / http / streamable-http", "type");

  const hasCmd = e.command != null;
  const hasUrl = e.url != null;
  let transport: "stdio" | "http" | null = null;
  if (hasCmd && hasUrl) error("both_command_url", "command 与 url 只能有一个");
  else if (!hasCmd && !hasUrl)
    error("no_command_url", "需要 command（stdio）或 url（http）");
  else transport = hasCmd ? "stdio" : "http";
  if (
    transport === "stdio" &&
    (e.type === "http" || e.type === "streamable-http")
  )
    error(
      "type_mismatch",
      `type 是 ${e.type as string}，但给的是 command`,
      "type",
    );
  if (transport === "http" && e.type === "stdio")
    error("type_mismatch", "type 是 stdio，但给的是 url", "type");

  let env: McpEntry[] = [];
  let headers: McpEntry[] = [];
  const entriesOf = (field: "env" | "headers"): McpEntry[] => {
    const raw = e[field];
    if (raw == null) return [];
    if (!isStringMap(raw)) {
      error("invalid_map", `${field} 要是 {名: 值} 的字符串对象`, field);
      return [];
    }
    const list = toEntries(raw);
    for (const it of list) {
      if (it.secretId !== undefined && !deps.secretExists(it.secretId))
        error(
          "unknown_secret",
          `${field}.${it.key}：密码库里没有 ${it.secretId}`,
          field,
        );
      if ((it.prefix?.length ?? 0) > 64)
        error(
          "prefix_too_long",
          `${field}.${it.key}：密码库引用的前缀至多 64 个字符`,
          field,
        );
    }
    return list;
  };

  if (transport === "stdio") {
    if (typeof e.command !== "string" || e.command.trim() === "")
      error("invalid_command", "command 要是可执行文件名", "command");
    else if (/\s/.test(e.command.trim()))
      error(
        "command_has_space",
        "command 是一个可执行文件，参数放 args",
        "command",
      );
    if (
      e.args != null &&
      (!Array.isArray(e.args) || e.args.some((a) => typeof a !== "string"))
    )
      error("invalid_args", "args 要是字符串数组", "args");
    env = entriesOf("env");
    if (e.headers != null)
      error("headers_on_stdio", "headers 只用于 http", "headers");
    if (e.cwd != null && (typeof e.cwd !== "string" || e.cwd.trim() === ""))
      error("invalid_cwd", "cwd 要是非空字符串", "cwd");
  } else if (transport === "http") {
    if (typeof e.url !== "string" || !/^https?:\/\//i.test(e.url))
      error("invalid_url", "url 要以 http:// 或 https:// 开头", "url");
    headers = entriesOf("headers");
    if (e.cwd != null || e.args != null)
      error(
        "stdio_only",
        "cwd / args 只用于 stdio",
        e.cwd != null ? "cwd" : "args",
      );
    if (e.env != null) warn("env_on_http", "env 只用于 stdio，已忽略", "env");
  }

  if (
    e.timeout != null &&
    (typeof e.timeout !== "number" ||
      !Number.isFinite(e.timeout) ||
      e.timeout <= 0)
  )
    error("invalid_timeout", "timeout 是以秒为单位的正数", "timeout");
  if (e.enabled != null && typeof e.enabled !== "boolean")
    error("invalid_enabled", "enabled 要是 true / false", "enabled");
  if (e.exposure != null && !isExposure(e.exposure))
    error(
      "invalid_exposure",
      `exposure 只能是 ${EXPOSURES.join(" / ")}${REMOVED_NOTE}`,
      "exposure",
    );
  let toolExposure: Record<string, Exposure> = {};
  if (e.toolExposure != null) {
    if (!isObject(e.toolExposure)) {
      error(
        "invalid_tool_exposure",
        "toolExposure 要是 {工具名: 暴露方式} 对象",
        "toolExposure",
      );
    } else if (Object.values(e.toolExposure).some((v) => !isExposure(v))) {
      error(
        "invalid_tool_exposure",
        `toolExposure 的值只能是 ${EXPOSURES.join(" / ")}${REMOVED_NOTE}`,
        "toolExposure",
      );
    } else toolExposure = e.toolExposure as Record<string, Exposure>;
  }
  if (e.oauth != null && !isObject(e.oauth) && typeof e.oauth !== "boolean")
    error("invalid_oauth", "oauth 要是对象或 true / false", "oauth");

  if (e.description !== undefined)
    warn(
      "description_ignored",
      "description 取自包元数据或握手返回的 serverInfo，手填会被忽略",
      "description",
    );
  for (const k of Object.keys(e))
    if (!KNOWN_KEYS.has(k)) warn("unknown_key", `未知键 ${k}，已忽略`, k);

  if (diagnostics.some((d) => d.level === "error") || transport === null)
    return fail();

  // 通过上面的规则后，再按登记库的长度上限等限制做一遍结构校验。
  const config = parseMcpConfig(
    transport === "stdio"
      ? {
          transport,
          command: (e.command as string).trim(),
          args: e.args ?? [],
          env,
          ...(e.cwd == null ? {} : { cwd: e.cwd }),
        }
      : { transport, url: e.url, headers },
  );
  if (typeof config === "string") {
    error("invalid_config", config);
    return fail();
  }
  return {
    ok: true,
    diagnostics,
    draft: {
      name,
      config,
      options: {
        enabled: e.enabled !== false,
        exposure: (e.exposure as Exposure | undefined) ?? "direct",
        toolExposure,
        timeout: typeof e.timeout === "number" ? e.timeout : null,
        oauth: e.oauth ?? null,
      },
      preview: {
        name,
        transport,
        target:
          config.transport === "stdio"
            ? [config.command, ...config.args].join(" ")
            : config.url,
        envCount: env.length,
        headerCount: headers.length,
      },
    },
  };
}
