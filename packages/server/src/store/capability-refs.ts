import type { AuditLog } from "./audit.js";

const LABEL = { skill: "skill", mcp: "MCP server" } as const;

// 引用指向库里已不存在的 skill / MCP：保存时放行，运行时跳过并留一条审计。
export function auditSkipped(
  audit: AuditLog | undefined,
  sessionId: string | null,
  kind: "skill" | "mcp",
  names: string[],
): void {
  if (!audit || !sessionId) return;
  for (const name of names)
    audit.record({
      sessionId,
      actor: "system",
      kind: "tool",
      summary: `跳过不存在的${LABEL[kind]}引用：${name}`,
      detail: { event: "capability_skipped", capability: kind, name },
    });
}
