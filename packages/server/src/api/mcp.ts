import type { FastifyInstance, FastifyReply } from "fastify";
import { isObject } from "../lib/validate.js";
import { MCP_NAME_RE, parseMcpJson, toConf } from "../mcp/conf.js";
import { parseSource } from "../mcp/pin.js";
import { mcpReferences } from "../mcp/refs.js";
import type { McpRuntime, PinResult } from "../mcp/runtime.js";
import { isPolicy } from "../permission/tool-matrix.js";
import type { CapabilityStore } from "../store/capabilities.js";
import {
  type McpConfig,
  type McpServerMeta,
  type McpStore,
  parseMcpConfig,
} from "../store/mcp.js";
import type { PromptPresetStore } from "../store/prompt-presets.js";
import type { SecretStore } from "../store/secrets.js";
import type { WorkspaceStore } from "../store/workspaces.js";
import { bad, notFound } from "./lib/reply.js";

export interface McpApiDeps {
  mcp: McpStore;
  secrets: SecretStore;
  workspaces: WorkspaceStore;
  capabilities: CapabilityStore;
  runtime: McpRuntime;
  // 改名时用来查谁在引用旧名；缺省只查 workspace 分配。
  presets?: PromptPresetStore;
}

const NO_DESCRIPTION = "来源未提供描述";
const BATCH_MAX = 200;
const BATCH_ACTIONS = [
  "pin",
  "check",
  "enable",
  "disable",
  "uninstall",
] as const;
type BatchAction = (typeof BATCH_ACTIONS)[number];

// 引用的密码库条目必须存在；返回问题说明。
function secretProblem(config: McpConfig, secrets: SecretStore) {
  const entries = config.transport === "stdio" ? config.env : config.headers;
  for (const e of entries)
    if (e.secretId !== undefined && !secrets.get(e.secretId))
      return `${e.key}：密码库里没有 ${e.secretId}`;
  return null;
}

// 试装 / 版本解析失败时的 HTTP 状态：无网络 503，包不存在 422，试装跑不起来 502。
const PIN_STATUS = {
  not_pinnable: 400,
  invalid_version: 400,
  network_unavailable: 503,
  package_not_found: 422,
  resolve_failed: 502,
  run_failed: 502,
} as const;

// 能力库 MCP 的 REST（ADR-0056）：登记 CRUD、JSON 校验、试装固定、检测、批量。
export async function mcpApi(
  app: FastifyInstance,
  deps: McpApiDeps,
): Promise<void> {
  const { mcp, secrets, runtime } = deps;

  // 列表与详情的统一视图：旧字段原样保留，新字段追加。
  // version / pinned 从命令里的 pkg@版本 推出（成功试装才会写回），没有单独存。
  const toView = (m: McpServerMeta) => {
    const src = parseSource(m.config);
    return {
      ...m,
      description: m.description ?? NO_DESCRIPTION,
      transport: m.config.transport,
      conf: toConf(m),
      source: src ? { runtime: src.runtime, pkg: src.pkg } : null,
      version: src?.version ?? null,
      pinned: src?.version != null,
      status: runtime.status(m.name) ?? null,
    };
  };
  const view = (name: string) => {
    const m = mcp.get(name);
    return m && toView(m);
  };

  const jsonDeps = (editing?: string) => ({
    secretExists: (id: string) => secrets.get(id) !== undefined,
    conflict: (n: string) => mcp.conflict(n, editing),
  });

  // JSON 校验失败的统一响应：重名 409，其余 400；诊断逐条带上。
  const jsonFailure = (
    reply: FastifyReply,
    r: ReturnType<typeof parseMcpJson>,
  ) => {
    const errors = r.diagnostics.filter((d) => d.level === "error");
    const dup = errors.find((d) => d.code === "name_exists");
    const first = errors[0];
    return reply.code(dup ? 409 : 400).send({
      error: dup ? "name_exists" : "invalid_config",
      message: (dup ?? first)?.message,
      diagnostics: r.diagnostics,
    });
  };

  const pinFailure = (reply: FastifyReply, r: PinResult & { ok: false }) =>
    reply.code(PIN_STATUS[r.error]).send({
      error: r.error,
      message: r.message,
      ...(r.steps ? { steps: r.steps } : {}),
      server: view(r.name) ?? null,
    });

  app.get("/api/v1/mcp", async () => ({
    servers: mcp.list().map(toView),
  }));

  // 编辑器边输入边校验：逐条诊断，不落库。editing 是正在编辑的现有条目（重名判断排除它自己）。
  app.post("/api/v1/mcp/validate", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (body.json === undefined) return bad(reply, "invalid_json");
    const editing = typeof body.editing === "string" ? body.editing : undefined;
    const r = parseMcpJson(body.json, jsonDeps(editing));
    return {
      ok: r.ok,
      diagnostics: r.diagnostics,
      preview: r.draft?.preview ?? null,
    };
  });

  // 新增：{ json } 走 mcpServers 校验（名称取自 JSON 的键）；旧的 { name, config } 结构化入参照旧规则。
  app.post("/api/v1/mcp", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (body.json !== undefined) {
      const r = parseMcpJson(body.json, jsonDeps());
      if (!r.draft) return jsonFailure(reply, r);
      const created = mcp.create(r.draft.name, r.draft.config, r.draft.options);
      if (!created) return reply.code(409).send({ error: "name_exists" });
      return reply
        .code(201)
        .send({ ...view(created.name), diagnostics: r.diagnostics });
    }
    if (typeof body.name !== "string" || !MCP_NAME_RE.test(body.name))
      return bad(reply, "invalid_name", "名称须为 1–32 位字母数字、_ 或 -");
    const config = parseMcpConfig(body.config);
    if (typeof config === "string") return bad(reply, "invalid_config", config);
    const p = secretProblem(config, secrets);
    if (p) return bad(reply, "invalid_config", p);
    const hit = mcp.conflict(body.name);
    if (hit !== undefined)
      return reply.code(409).send({ error: "name_exists", conflictsWith: hit });
    const created = mcp.create(body.name, config);
    if (!created) return reply.code(409).send({ error: "name_exists" });
    return reply.code(201).send(view(created.name));
  });

  // 更新：{ json } 里的键就是名字，键变了即改名（A10：新增并删除，旧名被引用则 409 并列出位置）；
  // 旧的 { config } 只换连接配置。
  app.put<{ Params: { name: string } }>(
    "/api/v1/mcp/:name",
    async (req, reply) => {
      const old = req.params.name;
      if (!mcp.get(old)) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      if (body.json !== undefined) {
        const r = parseMcpJson(body.json, jsonDeps(old));
        if (!r.draft) return jsonFailure(reply, r);
        const d = r.draft;
        if (d.name === old) {
          mcp.update(old, d.config, d.options);
          await runtime.forget(old);
          return { ...view(old), diagnostics: r.diagnostics };
        }
        const refs = mcpReferences(old, { ...deps });
        if (refs.length > 0)
          return reply.code(409).send({
            error: "mcp_referenced",
            message: `${old} 正被 ${refs.length} 处引用，不能改名；先在这些位置移除引用`,
            references: refs,
          });
        if (!mcp.create(d.name, d.config, d.options))
          return reply.code(409).send({ error: "name_exists" });
        mcp.remove(old);
        await runtime.forget(old);
        return {
          ...view(d.name),
          renamedFrom: old,
          diagnostics: r.diagnostics,
        };
      }
      const config = parseMcpConfig(body.config);
      if (typeof config === "string")
        return bad(reply, "invalid_config", config);
      const p = secretProblem(config, secrets);
      if (p) return bad(reply, "invalid_config", p);
      mcp.update(old, config);
      await runtime.forget(old);
      return view(old);
    },
  );

  // 行级状态：审批档（allow|ask，作用于 mcp__<server>__* 全部工具）、启停与全局项。
  // 禁用即断开实例，之后新会话不再带它的工具。
  app.patch<{ Params: { name: string } }>(
    "/api/v1/mcp/:name",
    async (req, reply) => {
      if (!mcp.get(req.params.name)) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      if (body.approval !== undefined && !isPolicy(body.approval))
        return bad(reply, "invalid_approval", "approval 须为 allow / ask");
      if (body.enabled !== undefined && typeof body.enabled !== "boolean")
        return bad(reply, "invalid_enabled", "enabled 须为布尔值");
      if (body.global !== undefined && typeof body.global !== "boolean")
        return bad(reply, "invalid_global", "global 须为布尔值");
      mcp.patch(req.params.name, {
        ...(body.approval === undefined
          ? {}
          : { approval: body.approval as never }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.global === undefined ? {} : { global: body.global }),
      });
      if (body.enabled === false) await runtime.forget(req.params.name);
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

  // 检测：启动 → 握手 → 列工具，逐步 { state, ms, error? }；失败也是 200，结果里点名原因。
  app.post<{ Params: { name: string } }>(
    "/api/v1/mcp/:name/check",
    async (req, reply) => {
      if (!mcp.get(req.params.name)) return notFound(reply);
      const check = await runtime.check(req.params.name);
      return { ...check, server: view(req.params.name) };
    },
  );

  // 全部检测：只测已启用的，逐个串行，汇总就绪数。
  app.post("/api/v1/mcp/check-all", async () => {
    const r = await runtime.checkAll();
    return { ...r, servers: mcp.list().map(toView) };
  });

  // 试装并固定：成功才把 pkg@版本 写回命令；失败不写，仍是浮动。body.version 缺省取最新，指定旧版即回退并锁定。
  app.post<{ Params: { name: string } }>(
    "/api/v1/mcp/:name/try-pin",
    async (req, reply) => {
      if (!mcp.get(req.params.name)) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      if (body.version !== undefined && typeof body.version !== "string")
        return bad(reply, "invalid_version", "版本形如 x.y.z");
      const r = await runtime.tryPin(req.params.name, body.version);
      if (!r.ok) return pinFailure(reply, r);
      return {
        ok: true,
        version: r.version,
        latestVersion: r.latestVersion,
        resolveMs: r.resolveMs,
        check: r.check,
        server: view(r.name),
      };
    },
  );

  // 候选版本（最近若干个，标出当前与最新）。
  app.post<{ Params: { name: string } }>(
    "/api/v1/mcp/:name/versions",
    async (req, reply) => {
      if (!mcp.get(req.params.name)) return notFound(reply);
      const r = await runtime.versions(req.params.name);
      if ("ok" in r) return pinFailure(reply, r);
      return r;
    },
  );

  // 批量：逐项执行，部分失败不回滚其它项。卸载 = 断开实例并删除条目。
  app.post("/api/v1/mcp/batch", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const action = body.action as BatchAction;
    if (!BATCH_ACTIONS.includes(action))
      return bad(
        reply,
        "invalid_action",
        `action 须为 ${BATCH_ACTIONS.join(" / ")}`,
      );
    const names = body.names;
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.length > BATCH_MAX ||
      !names.every((n) => typeof n === "string")
    )
      return bad(reply, "invalid_names", `names 须为 1–${BATCH_MAX} 个名称`);
    const results: {
      name: string;
      ok: boolean;
      error?: string;
      message?: string;
      detail?: unknown;
    }[] = [];
    for (const name of new Set(names as string[])) {
      if (!mcp.get(name)) {
        results.push({ name, ok: false, error: "not_found" });
        continue;
      }
      if (action === "pin") {
        const r = await runtime.tryPin(name);
        results.push(
          r.ok
            ? { name, ok: true, detail: r }
            : {
                name,
                ok: false,
                error: r.error,
                message: r.message,
                detail: r,
              },
        );
      } else if (action === "check") {
        const r = await runtime.check(name);
        results.push({
          name,
          ok: r.ok,
          ...(r.ok
            ? {}
            : { error: "check_failed", message: r.handshake.error }),
          detail: r,
        });
      } else if (action === "uninstall") {
        mcp.remove(name);
        await runtime.forget(name);
        results.push({ name, ok: true });
      } else {
        mcp.patch(name, { enabled: action === "enable" });
        if (action === "disable") await runtime.forget(name);
        results.push({ name, ok: true });
      }
    }
    return {
      action,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
      results,
      servers: mcp.list().map(toView),
    };
  });
}
