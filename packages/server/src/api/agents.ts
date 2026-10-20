import type { FastifyInstance, FastifyReply } from "fastify";
import { isMode } from "../permission/mode.js";
import type { SessionPool } from "../session/pool.js";
import { TOOL_NAMES, TOOLS } from "../session/tool-catalog.js";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  type AgentCapability,
  type AgentInput,
  type AgentStore,
  DEFAULT_AGENT_ID,
} from "../store/agents.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error: string = "bad_request") =>
  reply.code(400).send({ error });

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max
    ? v.trim()
    : null;

// 非法返回 false；缺省或 null 返回 null。
const optText = (v: unknown, max: number): string | null | false =>
  v === undefined || v === null ? null : (text(v, max) ?? false);

function parseBlocks(v: unknown): string[] | false {
  return Array.isArray(v) && v.every((i) => typeof i === "string") ? v : false;
}

function parseCapabilities(v: unknown): AgentCapability[] | false {
  if (!Array.isArray(v)) return false;
  const out: AgentCapability[] = [];
  for (const c of v) {
    if (!isObject(c)) return false;
    if (c.kind !== "tool" && c.kind !== "skill" && c.kind !== "mcp")
      return false;
    const name = text(c.name, 200);
    if (!name) return false;
    // 内置工具必须在目录里；skill / MCP 只是引用位，实际库由别处管理。
    if (c.kind === "tool" && !TOOL_NAMES.has(name)) return false;
    out.push({ kind: c.kind, name });
  }
  return out;
}

const FIELDS = [
  "name",
  "description",
  "promptBlocks",
  "capabilities",
  "model",
  "defaultThinkingLevel",
  "defaultMode",
] as const;

// 只处理出现的字段；任何字段非法返回 null。
function parsePatch(body: Record<string, unknown>): Partial<AgentInput> | null {
  const out: Partial<AgentInput> = {};
  if (body.name !== undefined) {
    const v = text(body.name, AGENT_NAME_MAX);
    if (!v) return null;
    out.name = v;
  }
  if (body.description !== undefined) {
    const v = text(body.description, AGENT_DESCRIPTION_MAX);
    if (!v) return null;
    out.description = v;
  }
  if (body.promptBlocks !== undefined) {
    const v = parseBlocks(body.promptBlocks);
    if (v === false) return null;
    out.promptBlocks = v;
  }
  if (body.capabilities !== undefined) {
    const v = parseCapabilities(body.capabilities);
    if (v === false) return null;
    out.capabilities = v;
  }
  for (const k of ["model", "defaultThinkingLevel", "defaultMode"] as const) {
    if (body[k] === undefined) continue;
    const v = optText(body[k], 200);
    if (v === false) return null;
    if (k === "defaultMode" && v !== null && !isMode(v)) return null;
    out[k] = v;
  }
  return out;
}

export async function agentsApi(
  app: FastifyInstance,
  opts: { agents: AgentStore; pool: SessionPool },
): Promise<void> {
  const { agents, pool } = opts;

  // 能力勾选用：只列真实存在的内置工具。
  app.get("/api/v1/tools", async () => ({ tools: TOOLS }));

  app.get("/api/v1/agents", async () => ({ agents: agents.list() }));

  app.get<{ Params: { id: string } }>(
    "/api/v1/agents/:id",
    async (req, reply) => {
      const a = agents.get(req.params.id);
      if (!a) return reply.code(404).send({ error: "not_found" });
      return a;
    },
  );

  app.post("/api/v1/agents", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const p = parsePatch(body);
    if (!p || !p.name) return bad(reply);
    return reply.code(201).send(
      agents.create({
        name: p.name,
        description: p.description ?? "",
        promptBlocks: p.promptBlocks ?? [],
        capabilities: p.capabilities ?? [],
        model: p.model ?? null,
        defaultThinkingLevel: p.defaultThinkingLevel ?? null,
        defaultMode: p.defaultMode ?? null,
      }),
    );
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/agents/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (!FIELDS.some((k) => body[k] !== undefined)) return bad(reply);
      const p = parsePatch(body);
      if (!p) return bad(reply);
      const a = agents.update(req.params.id, p);
      if (!a) return reply.code(404).send({ error: "not_found" });
      return a;
    },
  );

  // 默认 agent 是会话创建的兜底，不允许删除。
  app.delete<{ Params: { id: string } }>(
    "/api/v1/agents/:id",
    async (req, reply) => {
      if (req.params.id === DEFAULT_AGENT_ID)
        return bad(reply, "cannot_delete_default");
      if (pool.agentInUse(req.params.id))
        return reply.code(409).send({ error: "agent_in_use" });
      if (!agents.remove(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}
