import type { FastifyInstance } from "fastify";
import { Activator } from "../env/activation.js";
import { SERVER_HOST_ID } from "../env/host-id.js";
import type { EnvHub } from "../env/hub.js";
import { isObject, str } from "../lib/validate.js";
import { displayFingerprint } from "../ssh/fingerprint.js";
import type { AuditLog } from "../store/audit.js";
import {
  type ConnectionInput,
  type ConnectionPatch,
  type ConnectionPolicy,
  type ConnectionRecord,
  type ConnectionStore,
  DEFAULT_POLICY,
  HOST_KEY_POLICIES,
} from "../store/connections.js";
import { cleanName } from "../store/directories.js";
import { isOsType, LOCAL_ENV_ID } from "../store/environments.js";
import type { SecretStore } from "../store/secrets.js";
import { bad } from "./lib/reply.js";

const AUTH_KIND = { ssh_key: "key", password: "password" } as const;
const POLICY_BOOLS = [
  "keepAlive",
  "reuseSession",
  "proxyJumpFallback",
] as const;
// 这些字段变了就要换连接，激活中不许改
const LIVE_FIELDS = ["host", "port", "user", "os", "auth", "jump"] as const;

type Parsed =
  | { ok: true; value: ConnectionPatch }
  | { ok: false; error: string };

// 远程连接（S4a）：在 environments 之上加跳板链、策略、六步激活与主机密钥核对。
export async function connectionsApi(
  app: FastifyInstance,
  opts: {
    connections: ConnectionStore;
    secrets: SecretStore;
    hub: EnvHub;
    audit?: AuditLog;
  },
): Promise<void> {
  const { connections, secrets, hub, audit } = opts;
  const activator = new Activator(connections, hub, secrets, audit);
  const brief = (r: ConnectionRecord) => ({ id: r.id, label: r.label });
  const fp = (stored: string | null) =>
    stored ? displayFingerprint(stored) : null;

  function view(rec: ConnectionRecord) {
    const secret = rec.secretId ? secrets.get(rec.secretId) : null;
    const trusted = fp(rec.hostKey);
    const seen = fp(rec.hostKeyPending);
    return {
      id: rec.id,
      label: rec.label,
      host: rec.host,
      port: rec.port,
      user: rec.user,
      os: rec.os,
      auth: {
        kind: secret ? AUTH_KIND[secret.kind as keyof typeof AUTH_KIND] : null,
        secretId: rec.secretId,
      },
      // 直接跳板（至多一个，A5）；chain 是从最外层到直接跳板的完整链
      jump: rec.jumpId ? [rec.jumpId] : [],
      chain: connections.chain(rec.id).map(brief),
      dependants: connections.dependants(rec.id).map(brief),
      policy: rec.policy,
      status: activator.status(rec.id),
      hostKey: trusted && {
        ...trusted,
        changedFrom: fp(rec.hostKeyChangedFrom)?.fingerprint ?? null,
        acceptedAt: rec.hostKeyAcceptedAt,
      },
      hostKeyChange: seen && {
        old: trusted?.fingerprint ?? null,
        new: seen.fingerprint,
        oldType: trusted?.keyType ?? null,
        newType: seen.keyType,
        changedFrom: trusted?.fingerprint ?? null,
      },
      // 登记信息已改但连接还在用激活时的旧配置
      dirty: hub.isDirty(rec.id),
      lastActiveAt: rec.lastActiveAt,
      createdAt: rec.createdAt,
      activation: activator.activation(rec.id),
    };
  }

  const note = (id: string, summary: string, info?: string) =>
    audit?.record({
      actor: "user",
      kind: "env",
      environmentId: id,
      summary,
      detail: { op: "config", result: "ok", ...(info ? { info } : {}) },
    });

  function parsePolicy(v: unknown, base: ConnectionPolicy) {
    if (!isObject(v)) return null;
    const p = { ...base };
    for (const k of POLICY_BOOLS) {
      if (v[k] === undefined) continue;
      if (typeof v[k] !== "boolean") return null;
      p[k] = v[k];
    }
    if (v.hostKey !== undefined) {
      if (!HOST_KEY_POLICIES.includes(v.hostKey as never)) return null;
      p.hostKey = v.hostKey as ConnectionPolicy["hostKey"];
    }
    return p;
  }

  // 解析并校验字段；partial=true 用于 PATCH（只校验出现的字段）。cur 是被改的连接（新建为 null）。
  function parse(
    body: Record<string, unknown>,
    cur: ConnectionRecord | null,
  ): Parsed {
    const partial = cur !== null;
    const v: ConnectionPatch = {};
    if (!partial || body.label !== undefined) {
      const n = cleanName(body.label);
      if (n === null) return { ok: false, error: "invalid_label" };
      v.label = n;
    }
    if (!partial || body.host !== undefined) {
      const h = str(body.host, 253);
      if (h === null) return { ok: false, error: "invalid_host" };
      v.host = h;
    }
    if (!partial || body.user !== undefined) {
      const u = str(body.user, 64);
      if (u === null) return { ok: false, error: "invalid_user" };
      v.user = u;
    }
    if (!partial || body.port !== undefined) {
      const p = body.port === undefined ? 22 : body.port;
      if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535)
        return { ok: false, error: "invalid_port" };
      v.port = p as number;
    }
    if (!partial || body.os !== undefined) {
      const o = body.os === undefined ? "posix" : body.os;
      if (!isOsType(o)) return { ok: false, error: "invalid_os" };
      v.os = o;
    }
    if (!partial || body.auth !== undefined) {
      const a = isObject(body.auth) ? body.auth : null;
      const secret =
        a && typeof a.secretId === "string" ? secrets.get(a.secretId) : null;
      if (!a || !secret) return { ok: false, error: "invalid_auth" };
      if (
        a.kind !== undefined &&
        a.kind !== AUTH_KIND[secret.kind as keyof typeof AUTH_KIND]
      )
        return { ok: false, error: "auth_kind_mismatch" };
      v.secretId = secret.id;
    }
    if (!partial || body.policy !== undefined) {
      const p = parsePolicy(body.policy ?? {}, cur?.policy ?? DEFAULT_POLICY);
      if (!p) return { ok: false, error: "invalid_policy" };
      v.policy = p;
    }
    if (body.jump !== undefined) {
      if (
        !Array.isArray(body.jump) ||
        body.jump.length > 1 ||
        body.jump.some((j) => typeof j !== "string")
      )
        return { ok: false, error: "invalid_jump" };
      const jumpId = (body.jump[0] as string | undefined) ?? null;
      if (jumpId !== null) {
        const chk = connections.checkJump(cur?.id ?? null, jumpId);
        if (!chk.ok) return { ok: false, error: chk.error };
      }
      v.jumpId = jumpId;
    } else if (!partial) v.jumpId = null;
    return { ok: true, value: v };
  }

  app.get("/api/v1/connections", async () => ({
    // Server 所在主机：对外标识 server，对内仍是环境 id local（见 env/host-id.ts）
    server: {
      host: SERVER_HOST_ID,
      environmentId: LOCAL_ENV_ID,
      label: "本机",
    },
    connections: connections.list().map(view),
  }));

  app.get<{ Params: { id: string } }>(
    "/api/v1/connections/:id",
    async (req, reply) => {
      const rec = connections.get(req.params.id);
      return rec ? view(rec) : reply.code(404).send({ error: "not_found" });
    },
  );

  app.post("/api/v1/connections", async (req, reply) => {
    const parsed = parse(isObject(req.body) ? req.body : {}, null);
    if (!parsed.ok) {
      const code = parsed.error.startsWith("jump_") ? 409 : 400;
      return reply.code(code).send({ error: parsed.error });
    }
    const created = connections.create(parsed.value as ConnectionInput);
    if (!created) return reply.code(409).send({ error: "name_exists" });
    note(created.id, "新建连接");
    return reply.code(201).send(view(created));
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/connections/:id",
    async (req, reply) => {
      const cur = connections.get(req.params.id);
      if (!cur) return reply.code(404).send({ error: "not_found" });
      const body = isObject(req.body) ? req.body : {};
      const fields = Object.keys(body).filter((k) =>
        [...LIVE_FIELDS, "label", "policy"].includes(k),
      );
      if (fields.length === 0) return bad(reply);
      // 激活过程中地址类字段锁定；已激活的可以改，改动留到下次激活才生效（见 dirty）
      if (
        activator.status(cur.id) === "activating" &&
        fields.some((k) => (LIVE_FIELDS as readonly string[]).includes(k))
      )
        return reply.code(409).send({ error: "activating" });
      const parsed = parse(body, cur);
      if (!parsed.ok) {
        const code = parsed.error.startsWith("jump_") ? 409 : 400;
        return reply.code(code).send({ error: parsed.error });
      }
      const r = connections.update(cur.id, parsed.value);
      if (r === null) return reply.code(409).send({ error: "name_exists" });
      if (!r) return reply.code(404).send({ error: "not_found" });
      note(r.id, "修改配置", fields.join(", "));
      return view(r);
    },
  );

  // 已激活的连接要先断开；被别的连接当跳板、或有目录在用时拒绝（带引用者），不留悬空引用。
  app.delete<{ Params: { id: string } }>(
    "/api/v1/connections/:id",
    async (req, reply) => {
      const rec = connections.get(req.params.id);
      if (!rec) return reply.code(404).send({ error: "not_found" });
      const status = activator.status(rec.id);
      if (status === "active" || status === "activating")
        return reply.code(409).send({ error: "active" });
      const refs = connections.dependants(rec.id);
      if (refs.length > 0)
        return reply
          .code(409)
          .send({ error: "referenced", referencedBy: refs.map(brief) });
      const directories = connections.directoryCount(rec.id);
      if (directories > 0)
        return reply.code(409).send({ error: "in_use", directories });
      connections.remove(rec.id);
      hub.forget(rec.id);
      activator.forget(rec.id);
      // 连接记录没了，审计要留着：把它是谁写下来
      note(
        rec.id,
        "删除连接",
        `${rec.label} · ${rec.user}@${rec.host}:${rec.port}`,
      );
      return reply.code(204).send();
    },
  );

  // 立即返回 202 与初始进度，之后轮询 GET /connections/:id 的 activation。
  app.post<{ Params: { id: string } }>(
    "/api/v1/connections/:id/activate",
    async (req, reply) => {
      const r = activator.start(req.params.id);
      if (r.ok) {
        const rec = connections.get(req.params.id);
        return reply.code(202).send(rec && view(rec));
      }
      if (r.error === "not_found")
        return reply.code(404).send({ error: "not_found" });
      const rec = connections.get(req.params.id);
      return reply.code(409).send({
        error: r.error,
        ...(r.jump ? { jump: r.jump } : {}),
        ...(r.activating ? { activating: r.activating } : {}),
        ...(r.error === "verify_required" && rec
          ? { hostKeyChange: view(rec).hostKeyChange }
          : {}),
      });
    },
  );

  // 断开自己并递归暂停所有下游；deactivated 自己在最前。
  app.post<{ Params: { id: string } }>(
    "/api/v1/connections/:id/deactivate",
    async (req, reply) => {
      const all = activator.deactivate(req.params.id);
      if (!all) return reply.code(404).send({ error: "not_found" });
      const rec = connections.get(req.params.id);
      return { deactivated: all.map(brief), connection: rec && view(rec) };
    },
  );

  // 接受待核对的新指纹（首次询问或变更）；之后需再次 activate。
  app.post<{ Params: { id: string } }>(
    "/api/v1/connections/:id/trust",
    async (req, reply) => {
      const rec = connections.get(req.params.id);
      if (!rec) return reply.code(404).send({ error: "not_found" });
      if (rec.hostKeyPending === null)
        return reply.code(409).send({ error: "nothing_to_trust" });
      const first = rec.hostKey === null;
      const pending = fp(rec.hostKeyPending)?.fingerprint ?? "";
      connections.trust(rec.id, new Date().toISOString());
      audit?.record({
        actor: "user",
        kind: "env",
        environmentId: rec.id,
        summary: first ? "首次记录主机密钥" : "已信任新主机密钥",
        detail: { op: "trust", result: "ok", info: pending },
      });
      const next = connections.get(rec.id);
      return next && view(next);
    },
  );

  // 连接日志：现有审计里 kind=env 的记录，按 mock 的类型归类，新的在前。
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; before?: string };
  }>("/api/v1/connections/:id/log", async (req, reply) => {
    if (!connections.get(req.params.id))
      return reply.code(404).send({ error: "not_found" });
    const limit = Number(req.query.limit);
    const before = Number(req.query.before);
    const page = audit?.list({
      environment: req.params.id,
      kind: "env",
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : { limit: 100 }),
      ...(Number.isInteger(before) && before > 0 ? { before } : {}),
    }) ?? { entries: [], nextBefore: null };
    return {
      log: page.entries.map((e) => {
        const d = e.detail ?? {};
        const ok = d.result === "ok";
        const type =
          d.op === "activate" || d.op === "connect"
            ? ok
              ? "activate"
              : "fail"
            : d.op === "deactivate" || d.op === "drop" || d.op === "cancel"
              ? "disconnect"
              : d.op === "hostkey" || d.op === "trust"
                ? "hostkey"
                : "config";
        return {
          id: e.id,
          at: e.ts,
          type,
          text: e.summary,
          detail: typeof d.info === "string" ? d.info : "",
        };
      }),
      nextBefore: page.nextBefore,
    };
  });
}
