import { createHash } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { McpToolInfo } from "../store/mcp.js";
import type { McpCallResult } from "./connection.js";

export interface McpToolDef {
  // 注册给模型的工具名：mcp__<server>__<tool>。
  name: string;
  server: string;
  tool: McpToolInfo;
}

export type McpCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<McpCallResult>;

const NAME_MAX = 64;
const TEXT_MAX = 40_000;

const slug = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

// 工具名限字母数字下划线且 ≤64；超长或撞名时用原名哈希收尾，保证同一会话内唯一。
export function toolName(
  server: string,
  tool: string,
  taken: ReadonlySet<string>,
): string {
  const base = `mcp__${slug(server)}__${slug(tool)}`;
  if (base.length <= NAME_MAX && !taken.has(base)) return base;
  const h = createHash("sha256")
    .update(`${server}\0${tool}`)
    .digest("hex")
    .slice(0, 8);
  return `${base.slice(0, NAME_MAX - 9)}_${h}`;
}

export function buildToolDefs(
  servers: { name: string; tools: McpToolInfo[] }[],
): McpToolDef[] {
  const taken = new Set<string>();
  const out: McpToolDef[] = [];
  for (const s of servers)
    for (const tool of s.tools) {
      const name = toolName(s.name, tool.name, taken);
      taken.add(name);
      out.push({ name, server: s.name, tool });
    }
  return out;
}

const clip = (s: string) =>
  s.length <= TEXT_MAX
    ? s
    : `${s.slice(0, TEXT_MAX / 2)}\n[中间省略 ${s.length - TEXT_MAX} 个字符]\n${s.slice(-TEXT_MAX / 2)}`;

type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// MCP 内容块 → SDK 工具结果；音频、资源等非文本块折成一行说明。
export function toBlocks(content: unknown[]): Block[] {
  const out: Block[] = [];
  for (const raw of content) {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (c.type === "text" && typeof c.text === "string")
      out.push({ type: "text", text: clip(c.text) });
    else if (
      c.type === "image" &&
      typeof c.data === "string" &&
      typeof c.mimeType === "string"
    )
      out.push({ type: "image", data: c.data, mimeType: c.mimeType });
    else if (c.type === "resource" && typeof c.resource === "object") {
      const r = c.resource as Record<string, unknown>;
      out.push({
        type: "text",
        text: clip(
          typeof r.text === "string" ? r.text : `[资源 ${String(r.uri)}]`,
        ),
      });
    } else
      out.push({
        type: "text",
        text: `[${String(c.type)} 内容：${String(c.uri ?? c.mimeType ?? "")}]`,
      });
  }
  return out;
}

// 把已登记 server 的缓存工具注册为 SDK 自定义工具；调用经 call 转发，权限由现有扩展统一拦截。
export function mcpExtension(
  defs: McpToolDef[],
  call: McpCaller,
): ExtensionFactory {
  return (pi) => {
    for (const d of defs) {
      const schema = d.tool.inputSchema;
      pi.registerTool({
        name: d.name,
        label: `${d.server}/${d.tool.name}`,
        description: `[MCP ${d.server}] ${d.tool.description}`.trim(),
        parameters: {
          ...schema,
          type: schema.type ?? "object",
          ...(schema.properties === undefined ? { properties: {} } : {}),
        } as never,
        async execute(_id, params, signal) {
          const r = await call(
            d.server,
            d.tool.name,
            (params ?? {}) as Record<string, unknown>,
            signal,
          );
          const blocks = toBlocks(r.content);
          if (r.isError)
            throw new Error(
              blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n") ||
                "MCP 工具返回错误",
            );
          return {
            content: blocks.length ? blocks : [{ type: "text", text: "" }],
            details: {},
          };
        },
      });
    }
  };
}
