import type { FastifyReply } from "fastify";
import { HttpError } from "../../lib/http-error.js";

// 路由里最常见的两种错误响应。其余状态码（409 带当前值、带 status 的变体等）各路由自己写。

export const bad = (
  reply: FastifyReply,
  error = "bad_request",
  message?: string,
) =>
  reply.code(400).send(message === undefined ? { error } : { error, message });

export const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: "not_found" });

/** 业务错误 → `{ error, message, ...extra }`；不是 HttpError 的原样抛出，交给 Fastify 记 500。 */
export function toHttp(reply: FastifyReply, err: unknown) {
  if (err instanceof HttpError)
    return reply
      .code(err.status)
      .send({ error: err.code, message: err.message, ...err.extra });
  throw err;
}
