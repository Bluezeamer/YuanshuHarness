import type { FastifyInstance } from "fastify";
import { isObject, posInt } from "../lib/validate.js";
import type { AuditLog } from "../store/audit.js";
import {
  isRefResult,
  REF_PAGE_MAX,
  type ReferenceQuery,
  type ReferenceRecord,
  type ReferenceStore,
} from "../store/references.js";
import {
  checkVariable,
  cleanGroup,
  expiresAt,
  isExpired,
  isScopeKind,
  isVarTier,
  type SecretStore,
  type VariableInput,
  type VariableRecord,
} from "../store/secrets.js";
import type { WorkspaceVariableStore } from "../store/workspace-variables.js";
import type { WorkspaceStore } from "../store/workspaces.js";
import { bad } from "./lib/reply.js";

// 响应视图（IMPLEMENTATION §5.6 PrivateVariable）：只回遮罩值，可选字段无值时省略。
// purpose 是旧字段，与 desc 同值，旧客户端继续可用。
// workspaces 是启用这个变量的工作区（会话只看得到所属工作区启用了的变量）。
export function variableView(
  r: VariableRecord,
  now: number,
  workspaces: string[],
) {
  const exp = expiresAt(r);
  return {
    id: r.id,
    name: r.name,
    desc: r.purpose,
    purpose: r.purpose,
    group: r.group,
    workspaces,
    scopeKind: r.scopeKind,
    scopeTarget: r.scopeTarget,
    tier: r.tier,
    kind: r.kind,
    ...(r.valueMasked === null ? {} : { valueMasked: r.valueMasked }),
    ...(r.file ? { file: r.file } : {}),
    maskable: r.maskable,
    policy: r.policy,
    expiry: r.expiry,
    ...(exp === null ? {} : { expiresAt: new Date(exp).toISOString() }),
    expired: isExpired(r, now),
    owner: "user" as const,
    createdAt: r.createdAt,
    ...(r.rotatedAt ? { rotatedAt: r.rotatedAt } : {}),
    ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
  };
}

const referenceView = (r: ReferenceRecord) => ({
  id: String(r.id),
  name: r.name,
  directoryId: r.directoryId,
  hostId: r.hostId,
  ...(r.runId ? { runId: r.runId } : {}),
  toolCallId: r.toolCallId,
  at: r.at,
  result: r.result,
  ...(r.command ? { command: r.command } : {}),
});

// 隐私变量登记接口（ADR-0050）。值只进不出：任何响应都不含 value，只给 valueMasked；
// 要看明文走 POST /variables/:id/reveal（显式动作，记审计）。
export async function variablesApi(
  app: FastifyInstance,
  opts: {
    secrets: SecretStore;
    audit: AuditLog;
    references?: ReferenceStore;
    workspaces: WorkspaceStore;
    workspaceVariables: WorkspaceVariableStore;
  },
): Promise<void> {
  const { secrets, audit, references, workspaces, workspaceVariables } = opts;

  // 解析请求体；partial=true 用于 PATCH（只处理出现的字段）。
  // 带 desc 的新建走新契约（名称只收新文法）；只带 purpose 的是旧客户端，规则不变。
  function parse(
    body: Record<string, unknown>,
    partial: boolean,
  ):
    | { ok: true; value: Partial<VariableInput> }
    | { ok: false; error: string } {
    const v: Partial<VariableInput> = {};
    const strict = !partial && body.desc !== undefined;
    if (!partial || body.name !== undefined) v.name = body.name as string;
    if (body.desc !== undefined) {
      if (typeof body.desc !== "string" || body.desc.trim() === "")
        return { ok: false, error: "invalid_desc" };
      v.purpose = body.desc.trim();
    } else if (!partial || body.purpose !== undefined)
      v.purpose = typeof body.purpose === "string" ? body.purpose : "";
    if (!partial || body.value !== undefined) v.value = body.value as string;
    if (body.kind !== undefined) v.kind = body.kind as VariableInput["kind"];
    if (body.fileName !== undefined) v.fileName = body.fileName as string;
    if (body.policy !== undefined)
      v.policy = body.policy as VariableInput["policy"];
    if (body.expiry !== undefined)
      v.expiry = body.expiry as VariableInput["expiry"];
    if (body.group !== undefined) {
      const group = body.group === null ? null : cleanGroup(body.group);
      if (body.group !== null && group === null)
        return { ok: false, error: "invalid_group" };
      v.group = group;
    }
    if (body.scopeKind !== undefined || !partial) {
      const k = body.scopeKind === undefined ? "any" : body.scopeKind;
      if (!isScopeKind(k)) return { ok: false, error: "invalid_scope" };
      v.scopeKind = k;
      v.scopeTarget =
        typeof body.scopeTarget === "string" ? body.scopeTarget : null;
    }
    if (body.tier !== undefined || !partial) {
      const t = body.tier === undefined ? "rules" : body.tier;
      if (!isVarTier(t)) return { ok: false, error: "invalid_tier" };
      v.tier = t;
    }
    let err = checkVariable(v, !partial, strict);
    if (err === "invalid_purpose" && body.desc !== undefined)
      err = "invalid_desc";
    return err ? { ok: false, error: err } : { ok: true, value: v };
  }

  const view = (id: string) => {
    const r = secrets.getVariableRecord(id);
    return r
      ? variableView(r, Date.now(), workspaceVariables.workspacesOf(id))
      : null;
  };

  // 请求体里的 id 清单：字符串数组。
  const isIdList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((id) => typeof id === "string");

  // 所有 id 都是已登记的工作区；没登记的那个返回它。
  const unknownWorkspace = (ids: readonly string[]): string | null =>
    ids.find((id) => workspaces.get(id) === undefined) ?? null;

  app.get("/api/v1/variables", async () => {
    const now = Date.now();
    // 列表一次取全启用关系，不逐个查。
    const enabled = workspaceVariables.byVariable();
    return {
      variables: secrets
        .listVariableRecords()
        .map((r) => variableView(r, now, enabled.get(r.id) ?? [])),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/variables/:id",
    async (req, reply) =>
      view(req.params.id) ?? reply.code(404).send({ error: "not_found" }),
  );

  app.post("/api/v1/variables", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const parsed = parse(body, false);
    if (!parsed.ok) return bad(reply, parsed.error);
    // 工作区 id 先校验：不合法就什么都不创建。
    const enabled = body.workspaces;
    if (
      enabled !== undefined &&
      (!isIdList(enabled) || unknownWorkspace(enabled) !== null)
    )
      return bad(reply, "invalid_workspace");
    const created = secrets.createVariable(parsed.value as VariableInput);
    if (created === "limit") return bad(reply, "limit_exceeded");
    if (!created) return reply.code(409).send({ error: "name_exists" });
    if (isIdList(enabled))
      workspaceVariables.setForVariable(created.id, enabled);
    return reply.code(201).send(view(created.id));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/variables/:id",
    async (req, reply) => {
      const parsed = parse(isObject(req.body) ? req.body : {}, true);
      if (!parsed.ok) return bad(reply, parsed.error);
      if (Object.keys(parsed.value).length === 0) return bad(reply);
      const cur = secrets.getVariableRecord(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      // 类型创建后不可改；文件名只对文件型有意义
      if (parsed.value.kind !== undefined && parsed.value.kind !== cur.kind)
        return bad(reply, "invalid_kind");
      if (parsed.value.fileName !== undefined && cur.kind !== "file")
        return bad(reply, "invalid_file");
      const r = secrets.updateVariable(req.params.id, parsed.value);
      if (r === undefined) return reply.code(404).send({ error: "not_found" });
      if (r === "limit") return bad(reply, "limit_exceeded");
      if (r === null) return reply.code(409).send({ error: "name_exists" });
      return view(req.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/variables/:id",
    async (req, reply) => {
      if (!secrets.removeVariable(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // 整份替换“哪些工作区启用了这个变量”。
  app.put<{ Params: { id: string } }>(
    "/api/v1/variables/:id/workspaces",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (!secrets.getVariable(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      if (
        !isIdList(body.workspaces) ||
        unknownWorkspace(body.workspaces) !== null
      )
        return bad(reply, "invalid_workspace");
      workspaceVariables.setForVariable(req.params.id, body.workspaces);
      return view(req.params.id);
    },
  );

  // 某个工作区启用了哪些变量（id 清单，升序）。
  const enabledView = (workspaceId: string) => ({
    variables: [...workspaceVariables.enabledIds(workspaceId)].sort(),
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/variables",
    async (req, reply) =>
      workspaces.get(req.params.id)
        ? enabledView(req.params.id)
        : reply.code(404).send({ error: "not_found" }),
  );

  // 整份替换某个工作区的启用清单。
  app.put<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/variables",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (!workspaces.get(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      if (
        !isIdList(body.variables) ||
        body.variables.some((id) => !secrets.getVariable(id))
      )
        return bad(reply, "invalid_variable");
      workspaceVariables.setForWorkspace(req.params.id, body.variables);
      return enabledView(req.params.id);
    },
  );

  // 改组名：新名不合法 400；旧组没有成员 404。改名到已存在的组名就是合并。
  app.put<{ Params: { name: string } }>(
    "/api/v1/variable-groups/:name",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      const to = cleanGroup(body.name);
      if (to === null) return bad(reply, "invalid_group");
      const renamed = secrets.renameVariableGroup(req.params.name, to);
      if (renamed === 0) return reply.code(404).send({ error: "not_found" });
      return { renamed };
    },
  );

  // 解散组：批量清空成员的组名。
  app.delete<{ Params: { name: string } }>(
    "/api/v1/variable-groups/:name",
    async (req, reply) => {
      if (secrets.dissolveVariableGroup(req.params.name) === 0)
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // 一次显式动作：返回明文并记一条审计（detail 只含名称与 id，不含值）。8 秒显示由前端做。
  app.post<{ Params: { id: string } }>(
    "/api/v1/variables/:id/reveal",
    async (req, reply) => {
      const r = secrets.revealVariable(req.params.id);
      if (!r) return reply.code(404).send({ error: "not_found" });
      audit.record({
        actor: "user",
        kind: "secret",
        summary: `reveal variable ${r.meta.name}`,
        detail: { op: "reveal", id: r.meta.id, name: r.meta.name },
      });
      reply.header("Cache-Control", "no-store");
      return {
        id: r.meta.id,
        name: r.meta.name,
        kind: r.meta.kind,
        value: r.value,
      };
    },
  );

  // 轮换：换新值，到期按 days 从此刻重新起算；文件型可顺带换文件名。
  app.post<{ Params: { id: string } }>(
    "/api/v1/variables/:id/rotate",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      const cur = secrets.getVariableRecord(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      const patch: Partial<VariableInput> = {
        value: body.value as string,
        ...(body.fileName === undefined
          ? {}
          : { fileName: body.fileName as string }),
      };
      const err = checkVariable(patch, true);
      if (err) return bad(reply, err);
      if (patch.fileName !== undefined && cur.kind !== "file")
        return bad(reply, "invalid_file");
      const r = secrets.updateVariable(req.params.id, patch);
      if (r === undefined) return reply.code(404).send({ error: "not_found" });
      if (typeof r === "string") return bad(reply, "limit_exceeded");
      audit.record({
        actor: "user",
        kind: "secret",
        summary: `rotate variable ${cur.name}`,
        detail: { op: "rotate", id: cur.id, name: cur.name },
      });
      return view(req.params.id);
    },
  );

  if (references) {
    app.get<{
      Querystring: {
        directory?: string;
        name?: string;
        result?: string;
        limit?: string;
        before?: string;
      };
    }>("/api/v1/references", async (req, reply) => {
      const { directory, name, result, limit, before } = req.query;
      const q: ReferenceQuery = {};
      if (directory !== undefined) q.directory = directory;
      if (name !== undefined) q.name = name;
      if (result !== undefined) {
        if (!isRefResult(result)) return bad(reply, "invalid_result");
        q.result = result;
      }
      if (limit !== undefined) {
        const n = posInt(limit, REF_PAGE_MAX);
        if (n === null) return bad(reply, "invalid_limit");
        q.limit = n;
      }
      if (before !== undefined) {
        const n = posInt(before);
        if (n === null) return bad(reply, "invalid_before");
        q.before = n;
      }
      const page = references.list(q);
      return {
        references: page.entries.map(referenceView),
        nextBefore: page.nextBefore,
      };
    });
  }
}
