import type { FastifyInstance, FastifyReply } from "fastify";
import { isMode, type Mode } from "../permission/mode.js";
import {
  CONVENTIONS_FILE,
  CONVENTIONS_MAX,
  type GlobalConventions,
} from "../prompt/conventions.js";
import type { SessionPool } from "../session/pool.js";
import type { AgentStore } from "../store/agents.js";
import {
  type BlockInput,
  type BlockStore,
  CONTENT_MAX,
  DIMENSION_MAX,
  GROUP_MAX,
  NAME_MAX,
} from "../store/blocks.js";
import type { WorkspaceStore } from "../store/workspaces.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error: string = "bad_request") =>
  reply.code(400).send({ error });

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max
    ? v.trim()
    : null;

const nullableText = (v: unknown, max: number): string | null | false =>
  v === undefined || v === null
    ? null
    : text(v, max) === null
      ? false
      : text(v, max);

export async function promptApi(
  app: FastifyInstance,
  opts: {
    blocks: BlockStore;
    conventions: GlobalConventions;
    agents: AgentStore;
    workspaces: WorkspaceStore;
    pool: SessionPool;
  },
): Promise<void> {
  const { blocks, conventions, agents, workspaces, pool } = opts;

  app.get("/api/v1/prompt/blocks", async () => ({ blocks: blocks.list() }));

  app.post("/api/v1/prompt/blocks", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const name = text(body.name, NAME_MAX);
    const group = text(body.group, GROUP_MAX);
    const dim = nullableText(body.dimension, DIMENSION_MAX);
    const content = text(body.content, CONTENT_MAX);
    if (!name || !group || dim === false || !content) return bad(reply);
    const input: BlockInput = { name, group, dimension: dim, content };
    return reply.code(201).send(blocks.create(input));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/prompt/blocks/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (
        body.name === undefined &&
        body.group === undefined &&
        body.dimension === undefined &&
        body.content === undefined
      )
        return bad(reply);
      const name =
        body.name === undefined ? undefined : text(body.name, NAME_MAX);
      const group =
        body.group === undefined ? undefined : text(body.group, GROUP_MAX);
      const dim =
        body.dimension === undefined
          ? undefined
          : nullableText(body.dimension, DIMENSION_MAX);
      const content =
        body.content === undefined
          ? undefined
          : text(body.content, CONTENT_MAX);
      if (name === null || group === null || dim === false || content === null)
        return bad(reply);
      const b = blocks.update(req.params.id, {
        ...(name ? { name } : {}),
        ...(group ? { group } : {}),
        ...(dim !== undefined ? { dimension: dim } : {}),
        ...(content ? { content } : {}),
      });
      if (!b) return reply.code(404).send({ error: "not_found" });
      return b;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/prompt/blocks/:id",
    async (req, reply) => {
      if (!blocks.remove(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // 实时预览：给 agentId（已存的定义）或 promptBlocks（编辑器里未保存的块列表，可带 mode）；workspaceId 缺省用默认 workspace。
  app.post("/api/v1/prompt/preview", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    let ids: string[];
    let mode: Mode = "build";
    if (body.promptBlocks !== undefined) {
      if (
        !Array.isArray(body.promptBlocks) ||
        !body.promptBlocks.every((i) => typeof i === "string")
      )
        return bad(reply);
      ids = body.promptBlocks as string[];
      if (body.mode !== undefined) {
        if (!isMode(body.mode)) return bad(reply);
        mode = body.mode;
      }
    } else if (typeof body.agentId === "string") {
      const a = agents.get(body.agentId);
      if (!a) return reply.code(404).send({ error: "agent_not_found" });
      ids = a.promptBlocks;
      if (isMode(a.defaultMode)) mode = a.defaultMode;
    } else return bad(reply);
    if (body.workspaceId !== undefined && typeof body.workspaceId !== "string")
      return bad(reply);
    const ws =
      body.workspaceId === undefined
        ? workspaces.getDefault()
        : workspaces.get(body.workspaceId);
    if (body.workspaceId !== undefined && !ws)
      return reply.code(404).send({ error: "workspace_not_found" });
    const r = await pool.assemblePrompt(ids, ws, mode);
    return { text: r.text, parts: r.parts, chars: r.text.length };
  });

  // 立即同步提示词基线：只处理空闲会话，运行中的返回 busy（压缩后会自动重建）。
  app.post<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/prompt/sync",
    async (req, reply) => {
      const r = await pool.rebase(req.params.id);
      if (r === "not_found")
        return reply.code(404).send({ error: "not_found" });
      return { result: r };
    },
  );

  app.post("/api/v1/prompt/sync", async () => pool.rebaseAll());

  app.get("/api/v1/prompt/conventions", async () => ({
    file: CONVENTIONS_FILE,
    content: conventions.read(),
  }));

  app.put("/api/v1/prompt/conventions", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const content =
      typeof body.content === "string" && body.content.length <= CONVENTIONS_MAX
        ? body.content
        : null;
    if (content === null) return bad(reply);
    conventions.write(content);
    return reply.code(204).send();
  });
}
