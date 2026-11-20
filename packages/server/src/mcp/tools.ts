import { createHash } from "node:crypto";
import type { McpServerMeta, McpToolInfo } from "../store/mcp.js";

export interface McpToolDef {
  // 注册给模型的工具名：mcp__<server>__<tool>。
  name: string;
  server: string;
  tool: McpToolInfo;
}

const NAME_MAX = 64;

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

/**
 * pi 此刻实际注册的 MCP 工具（连上之后才有）：按服务名前缀归属；hidden 的 pi 也会登记但不可达，不算。
 * 会话里的可用名单以它为准，不依赖 Server 本机的检测缓存。
 */
export function liveToolDefs(
  names: readonly string[],
  servers: readonly McpServerMeta[],
): McpToolDef[] {
  const out: McpToolDef[] = [];
  for (const n of names) {
    if (!n.startsWith("mcp__")) continue;
    const owner = servers
      .filter((s) => n.startsWith(`mcp__${slug(s.name)}__`))
      .sort((a, b) => slug(b.name).length - slug(a.name).length)[0];
    if (!owner) continue;
    const rest = n.slice(`mcp__${slug(owner.name)}__`.length);
    const override = Object.entries(owner.toolExposure).find(
      ([k]) => slug(k) === rest,
    )?.[1];
    if ((override ?? owner.exposure) === "hidden") continue;
    out.push({
      name: n,
      server: owner.name,
      tool: { name: rest, description: "", inputSchema: {} },
    });
  }
  return out;
}
