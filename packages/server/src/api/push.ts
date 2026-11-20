import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authOf } from "../auth.js";
import { isObject } from "../lib/validate.js";
import type { PushNotifier } from "../push/notifier.js";
import {
  DELAY_MAX_SEC,
  DELAY_MIN_SEC,
  isPushPolicy,
  type PushPrefs,
  type PushStore,
} from "../store/push.js";
import { bad, notFound } from "./lib/reply.js";

// 手机推送：订阅、通知偏好、测试推送。全部只给设备令牌——偏好跟着设备走，桌面的全局令牌没有订阅。
const ENDPOINT_MAX = 2048;
const KEY_MAX = 200;

const PREF_KEYS = ["blocked", "error", "done", "policy", "delaySec"] as const;

const checkPrefs = (body: Record<string, unknown>): string | null => {
  if (PREF_KEYS.every((k) => body[k] === undefined)) return "没有可改的字段";
  for (const k of ["blocked", "error", "done"] as const)
    if (body[k] !== undefined && typeof body[k] !== "boolean")
      return "开关要是布尔值";
  if (body.policy !== undefined && !isPushPolicy(body.policy))
    return "策略要是 always / unwatched / delay";
  const delay = body.delaySec;
  if (
    delay !== undefined &&
    !(
      typeof delay === "number" &&
      Number.isInteger(delay) &&
      delay >= DELAY_MIN_SEC &&
      delay <= DELAY_MAX_SEC
    )
  )
    return `延迟要是 ${DELAY_MIN_SEC}–${DELAY_MAX_SEC} 的整数秒`;
  return null;
};

// 浏览器给的一定是 https；放行 http 只为本地假推送端点能测。
const isEndpoint = (v: unknown): v is string => {
  if (typeof v !== "string" || v === "" || v.length > ENDPOINT_MAX)
    return false;
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const isKey = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && v.length <= KEY_MAX;

export async function pushApi(
  app: FastifyInstance,
  opts: { store: PushStore; notifier: PushNotifier; publicKey: string },
): Promise<void> {
  const { store, notifier, publicKey } = opts;

  // 与 devicesApi 的 globalOnly 反过来：这里只认设备令牌。
  const deviceOnly = (
    req: FastifyRequest,
    reply: FastifyReply,
  ): { id: string } | null => {
    const auth = authOf(req);
    if (auth.kind === "device") return auth.device;
    void reply.code(403).send({ error: "forbidden" });
    return null;
  };

  app.get("/api/v1/push", async (req, reply) => {
    const device = deviceOnly(req, reply);
    if (!device) return reply;
    const row = store.get(device.id);
    return { publicKey, subscribed: row !== null, prefs: row?.prefs ?? null };
  });

  app.put<{
    Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  }>("/api/v1/push/subscription", async (req, reply) => {
    const device = deviceOnly(req, reply);
    if (!device) return reply;
    const body = isObject(req.body) ? req.body : {};
    const keys = isObject(body.keys) ? body.keys : {};
    if (!isEndpoint(body.endpoint))
      return bad(reply, "bad_request", "订阅地址不合法");
    if (!isKey(keys.p256dh) || !isKey(keys.auth))
      return bad(reply, "bad_request", "订阅密钥不合法");
    store.upsert(device.id, {
      endpoint: body.endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
    return reply.code(204).send();
  });

  app.delete("/api/v1/push/subscription", async (req, reply) => {
    const device = deviceOnly(req, reply);
    if (!device) return reply;
    store.remove(device.id);
    return reply.code(204).send();
  });

  app.patch<{ Body: Partial<PushPrefs> }>(
    "/api/v1/push/prefs",
    async (req, reply) => {
      const device = deviceOnly(req, reply);
      if (!device) return reply;
      const body = isObject(req.body) ? req.body : {};
      const problem = checkPrefs(body);
      if (problem) return bad(reply, "bad_request", problem);
      // 只取认识的字段：body 里的其它键不进库、也不回给前端。
      const patch: Partial<PushPrefs> = {};
      for (const k of PREF_KEYS)
        if (body[k] !== undefined)
          (patch as Record<string, unknown>)[k] = body[k];
      const prefs = store.setPrefs(device.id, patch);
      if (!prefs) return notFound(reply);
      return prefs;
    },
  );

  app.post("/api/v1/push/test", async (req, reply) => {
    const device = deviceOnly(req, reply);
    if (!device) return reply;
    const result = await notifier.test(device.id);
    if (!result) return notFound(reply);
    if (!result.ok)
      return reply
        .code(502)
        .send({ error: "push_failed", message: result.error });
    return reply.code(204).send();
  });
}
