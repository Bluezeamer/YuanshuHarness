// 浏览器登录态的管理接口（全局，不分工作区）：列出、开关、删一个、清空。
// 认证由 /api/v1 作用域统一施加；接口不返回任何 cookie / localStorage 内容。
import type { FastifyInstance } from "fastify";
import type { LoginService } from "../browser/login/login.js";
import { isObject } from "../lib/validate.js";
import { bad, notFound } from "./lib/reply.js";

export async function browserLoginsApi(
  app: FastifyInstance,
  opts: {
    login: Pick<LoginService, "list" | "setEnabled" | "remove" | "clear">;
  },
): Promise<void> {
  const { login } = opts;

  app.get("/api/v1/browser/logins", async () => ({ logins: login.list() }));

  app.patch<{ Params: { site: string } }>(
    "/api/v1/browser/logins/:site",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      if (typeof body.enabled !== "boolean") return bad(reply);
      const { site } = req.params;
      if (!(await login.setEnabled(site, body.enabled))) return notFound(reply);
      return { site, enabled: body.enabled };
    },
  );

  app.delete<{ Params: { site: string } }>(
    "/api/v1/browser/logins/:site",
    async (req, reply) => {
      if (!login.remove(req.params.site)) return notFound(reply);
      return reply.code(204).send();
    },
  );

  app.delete("/api/v1/browser/logins", async () => ({
    removed: login.clear(),
  }));
}
