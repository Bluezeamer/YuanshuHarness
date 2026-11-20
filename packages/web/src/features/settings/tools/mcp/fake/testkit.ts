// 仅测试使用：与服务端 mcp/conf.ts 同规则的 mcpServers JSON 校验（只覆盖会被测到的规则，文案同服务端）。
import type {
  Exposure,
  McpConf,
  McpDiagnostic,
} from "../../../../../api/mcpLibrary";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function validate(
  text: string,
  conflict: (n: string) => string | undefined,
) {
  const d: McpDiagnostic[] = [];
  const err = (code: string, message: string, field?: string) =>
    d.push({ level: "error", code, message, ...(field ? { field } : {}) });
  const fail = () => ({
    ok: false,
    diagnostics: d,
    preview: null,
    draft: null,
  });
  if (text.trim() === "") {
    err("empty", "先填配置 JSON");
    return fail();
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    err("invalid_json", `JSON 解析失败 · ${(e as Error).message}`);
    return fail();
  }
  const servers = doc.mcpServers as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!servers || typeof servers !== "object") {
    err(
      "no_mcp_servers",
      '需要 mcpServers 包装 · {"mcpServers":{"名称":{…}}}',
      "mcpServers",
    );
    return fail();
  }
  const keys = Object.keys(servers);
  if (keys.length !== 1) {
    err(
      "not_single",
      `一次只添加一个服务 · 当前 ${keys.length} 个`,
      "mcpServers",
    );
    return fail();
  }
  const name = keys[0] as string;
  const e = servers[name] as Record<string, unknown>;
  if (!NAME_RE.test(name))
    err("invalid_name", "名称只能用字母、数字、_ 和 -，1–32 位", "name");
  else if (conflict(name) !== undefined)
    err("name_exists", `同名服务已存在：${conflict(name)}`, "name");
  if (e.type === "sse")
    err("sse", "不支持 sse · 用 streamable HTTP，通常路径是 /mcp", "type");
  const hasCmd = e.command != null;
  const hasUrl = e.url != null;
  if (hasCmd && hasUrl) err("both_command_url", "command 与 url 只能有一个");
  else if (!hasCmd && !hasUrl)
    err("no_command_url", "需要 command（stdio）或 url（http）");
  if (hasCmd && !hasUrl) {
    if (typeof e.command === "string" && /\s/.test(e.command.trim()))
      err(
        "command_has_space",
        "command 是一个可执行文件，参数放 args",
        "command",
      );
    const env = e.env as Record<string, unknown> | undefined;
    if (env && Object.values(env).some((v) => typeof v !== "string"))
      err("invalid_map", "env 要是 {名: 值} 的字符串对象", "env");
    if (e.headers != null)
      err("headers_on_stdio", "headers 只用于 http", "headers");
  }
  if (hasUrl && !hasCmd && !/^https?:\/\//i.test(String(e.url)))
    err("invalid_url", `url 要以 ${"http"}:// 或 ${"https"}:// 开头`, "url");
  if (e.description !== undefined)
    d.push({
      level: "warning",
      code: "description_ignored",
      message: "description 取自包元数据或握手返回的 serverInfo，手填会被忽略",
      field: "description",
    });
  if (d.some((x) => x.level === "error")) return fail();
  const env = (e.env as Record<string, string> | undefined) ?? {};
  const headers = (e.headers as Record<string, string> | undefined) ?? {};
  const stdio = hasCmd;
  const conf: McpConf = {
    ...(stdio
      ? {
          command: e.command as string,
          ...(e.args ? { args: e.args as string[] } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        }
      : {
          url: e.url as string,
          ...(Object.keys(headers).length ? { headers } : {}),
        }),
    exposure: (e.exposure as Exposure | undefined) ?? "direct",
    ...(e.oauth != null ? { oauth: e.oauth } : {}),
    ...(e.enabled === false ? { enabled: false } : {}),
  };
  return {
    ok: true,
    diagnostics: d,
    preview: {
      name,
      transport: stdio ? "stdio" : "http",
      target: stdio
        ? [e.command, ...((e.args as string[] | undefined) ?? [])].join(" ")
        : String(e.url),
      envCount: Object.keys(env).length,
      headerCount: Object.keys(headers).length,
    },
    draft: { name, conf, enabled: e.enabled !== false },
  };
}
