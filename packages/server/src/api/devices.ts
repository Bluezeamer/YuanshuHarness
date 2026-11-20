// 设备接口：桌面添加 / 列出 / 撤销设备，手机用配对码换自己的令牌。认证由 /api/v1 作用域统一施加。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authOf, type FailureLimiter } from "../auth.js";
import type { DeviceConnections } from "../devices/connections.js";
import type { PairingCodes } from "../devices/pairing.js";
import { str } from "../lib/validate.js";
import type { DeviceStore } from "../store/devices.js";
import { bad, notFound } from "./lib/reply.js";

// 设备名：去首尾空白后 1–40 个字符，不含控制字符（换行会让列表与二维码页面变形）。
const NAME_MAX = 40;
const CONTROL = /\p{Cc}/u;

const cleanName = (raw: unknown): string | null => {
  const name = str(raw, NAME_MAX);
  return name && !CONTROL.test(name) ? name : null;
};

export async function devicesApi(
  app: FastifyInstance,
  opts: {
    devices: DeviceStore;
    pairing: PairingCodes;
    connections: DeviceConnections;
    limiter: FailureLimiter;
  },
): Promise<void> {
  const { devices, pairing, connections, limiter } = opts;

  // 与钩子里失败计数的 key 同一写法：配对码错了与令牌错了共用一个来源的计数
  const sourceOf = (req: FastifyRequest) =>
    req.socket.remoteAddress ?? "unknown";

  // 添加 / 列出 / 撤销设备只给桌面的全局令牌；手机自己的令牌不能管设备。
  const globalOnly = (req: FastifyRequest, reply: FastifyReply) => {
    if (authOf(req).kind === "global") return true;
    void reply.code(403).send({ error: "forbidden" });
    return false;
  };

  // 撤销时被掐的 socket 集合里可能就有正在回这次响应的连接（手机删自己时必然如此），
  // 所以先回完再断，否则客户端看不到 204 / 404。
  const disconnectAfterReply = (reply: FastifyReply, id: string) => {
    reply.raw.once("finish", () => connections.disconnect(id));
  };

  app.post("/api/v1/devices/pairing", async (req, reply) => {
    if (!globalOnly(req, reply)) return reply;
    return reply.code(201).send(pairing.create());
  });

  app.post<{ Body: { code?: unknown; name?: unknown } }>(
    "/api/v1/devices/pair",
    { config: { public: true } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { code?: unknown; name?: unknown };
      const name = cleanName(body.name);
      if (!name) return bad(reply, "bad_request", "设备名要 1–40 个字符");
      if (typeof body.code !== "string" || !pairing.redeem(body.code)) {
        limiter.fail(sourceOf(req));
        return reply
          .code(401)
          .header("WWW-Authenticate", "Bearer")
          .send({ error: "invalid_code" });
      }
      const created = devices.create(name);
      return reply.code(201).send(created);
    },
  );

  app.get("/api/v1/devices", async (req, reply) => {
    if (!globalOnly(req, reply)) return reply;
    return { devices: devices.list() };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/devices/:id",
    async (req, reply) => {
      if (!globalOnly(req, reply)) return reply;
      if (!devices.remove(req.params.id)) return notFound(reply);
      disconnectAfterReply(reply, req.params.id);
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/auth/whoami", async (req) => authOf(req));

  // 手机「退出此设备」：只删自己，断自己的连接。
  app.delete("/api/v1/devices/self", async (req, reply) => {
    const auth = authOf(req);
    if (auth.kind !== "device")
      return reply.code(403).send({ error: "forbidden" });
    devices.remove(auth.device.id);
    disconnectAfterReply(reply, auth.device.id);
    return reply.code(204).send();
  });
}
