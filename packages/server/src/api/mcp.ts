import type { FastifyInstance, FastifyReply } from "fastify";
import type { McpRuntime } from "../mcp/runtime.js";
import type { CapabilityStore } from "../store/capabilities.js";
import { type McpConfig, type McpStore, parseMcpConfig } from "../store/mcp.js";
import type { SecretStore } from "../store/secrets.js";
import type { WorkspaceStore } from "../store/workspaces.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (reply: FastifyReply, error = "bad_request", message?: string) =>
  reply.code(400).send(message === undefined ? { error } : { error, message });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: "not_found" });

// 名字会拼进工具名 mcp__<name>__<tool>，只允许字母数字下划线连字符。
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface McpApiDeps {
  mcp: McpStore;
  secrets: SecretStore;
  capabilities: CapabilityStore;
  workspaces: WorkspaceStore;
  runtime: McpRuntime;
}

// 引用的密码库条目必须存在；返回问题说明。
function secretProblem(config: McpConfig, secrets: SecretStore) {
  const entries = config.transport === "stdio" ? config.env : config.headers;
  for (const e of entries)
    if (e.secretId !== undefined && !secrets.get(e.secretId))
      return `${e.key}：密码库里没有 ${e.secretId}`;
  return null;
}

// 能力库 MCP 的 REST（ADR-0056）：登记 CRUD、刷新工具列表、workspace 级分配。
export async function mcpApi(
  app: FastifyInstance,
  deps: McpApiDeps,
): Promise<void> {
  const { mcp, secrets, capabilities, workspaces, runtime } = deps;

  const view = (name: string) => {
    const m = mcp.get(name);
    return m && { ...m, status: runtime.status(name) ?? null };
  };

  app.get("/api/v1/mcp", async () => ({
    servers: mcp.list().map((m) => view(m.name)),
  }));

  app.post("/api/v1/mcp", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (typeof body.name !== "string" || !NAME_RE.test(body.name))
      return bad(reply, "invalid_name", "名称须为 1–32 位字母数字、_ 或 -");
    const config = parseMcpConfig(body.config);
    if (typeof config === "string") return bad(reply, "invalid_config", config);
    const p = secretProblem(config, secrets);
    if (p) return bad(reply, "invalid_config", p);
    const created = mcp.create(body.name, config);
    if (!created) return reply.code(409).send({ error: "name_exists" });
    return reply.code(201).send(view(created.name));
  });

  app.put<{ Params: { name: string } }>(
    "/api/v1/mcp/:name",
    async (req, reply) => {
      if (!mcp.get(req.params.name)) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      const config = parseMcpConfig(body.config);
      if (typeof config === "string")
        return bad(reply, "invalid_config", config);
      const p = secretProblem(config, secrets);
      if (p) return bad(reply, "invalid_config", p);
      mcp.update(req.params.name, config);
      await runtime.forget(req.params.name);
      return view(req.params.name);
    },
  );

  app.delete<{ Params: { name: string } }>(
    "/api/v1/mcp/:name",
    async (req, reply) => {
      if (!mcp.remove(req.params.name)) return notFound(reply);
      await runtime.forget(req.params.name);
      return reply.code(204).send();
    },
  );

  // 连上 server 重新列出工具；连不上返回 502 与原因，登记本身不受影响。
  app.post<{ Params: { name: string } }>(
    "/api/v1/mcp/:name/refresh",
    async (req, reply) => {
      if (!mcp.get(req.params.name)) return notFound(reply);
      const r = await runtime.refresh(req.params.name);
      if (!r.ok)
        return reply
          .code(502)
          .send({ error: "mcp_unavailable", message: r.error });
      return view(req.params.name);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/mcp",
    async (req, reply) =>
      workspaces.get(req.params.id)
        ? { names: capabilities.list(req.params.id, "mcp") }
        : notFound(reply),
  );

  // 整体替换；对新建/恢复的会话生效。
  app.put<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/mcp",
    async (req, reply) => {
      if (!workspaces.get(req.params.id)) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      const names = body.names;
      if (!Array.isArray(names) || !names.every((n) => typeof n === "string"))
        return bad(reply, "invalid_names");
      for (const n of names)
        if (!mcp.get(n)) return bad(reply, "unknown_mcp", n);
      capabilities.set(req.params.id, "mcp", names);
      return { names: capabilities.list(req.params.id, "mcp") };
    },
  );
}
