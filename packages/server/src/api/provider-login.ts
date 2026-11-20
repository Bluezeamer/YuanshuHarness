import type { FastifyInstance, FastifyReply } from "fastify";
import { isObject } from "../lib/validate.js";
import type { Catalog } from "../provider/catalog.js";
import type { CredentialDeps } from "../provider/credentials.js";
import type { LoginManager, LoginState } from "../provider/login.js";
import { buildView, type ProviderView } from "../provider/view.js";
import type { ProviderRecord, ProviderStore } from "../store/providers.js";
import type { SecretStore } from "../store/secrets.js";
import { bad, notFound } from "./lib/reply.js";
import { blankRecord } from "./providers.js";

export interface ProviderLoginApiOpts {
  catalog: Catalog;
  providers: ProviderStore;
  secrets: SecretStore;
  login: LoginManager;
}

/** 能否走订阅登录；不能时给出响应用的错误码。 */
function unsupported(
  catalog: Catalog,
  providers: ProviderStore,
  id: string,
): "not_found" | "oauth_unsupported" | null {
  const rec = providers.get(id);
  if (rec?.custom) return "oauth_unsupported";
  if (!rec && !catalog.has(id)) return "not_found";
  return catalog.methods(id).includes("oauth") ? null : "oauth_unsupported";
}

function reject(
  reply: FastifyReply,
  error: "not_found" | "oauth_unsupported",
): FastifyReply {
  return error === "not_found"
    ? notFound(reply)
    : reply.code(400).send({ error });
}

/** 登录成功后记下这条供应商的认证方式；没有记录就现建一条。 */
export function markOauth(
  catalog: Catalog,
  providers: ProviderStore,
  id: string,
): void {
  const now = new Date().toISOString();
  const rec: ProviderRecord = providers.get(id) ?? {
    ...blankRecord(id, now),
    method: catalog.defaultMethod(id),
  };
  providers.save({ ...rec, method: "oauth", updatedAt: now });
}

export async function providerLoginApi(
  app: FastifyInstance,
  opts: ProviderLoginApiOpts,
): Promise<void> {
  const { catalog, providers, secrets, login } = opts;
  const deps: CredentialDeps = { catalog, providers, secrets };

  app.post<{ Params: { id: string } }>(
    "/api/v1/providers/:id/login",
    async (req, reply) => {
      const err = unsupported(catalog, providers, req.params.id);
      if (err) return reject(reply, err);
      return reply.code(201).send(login.start(req.params.id));
    },
  );

  app.get<{ Params: { id: string; loginId: string } }>(
    "/api/v1/providers/:id/login/:loginId",
    async (req, reply) => {
      const state: LoginState | null = login.get(
        req.params.id,
        req.params.loginId,
      );
      return state ?? notFound(reply);
    },
  );

  app.post<{ Params: { id: string; loginId: string } }>(
    "/api/v1/providers/:id/login/:loginId/answer",
    async (req, reply) => {
      if (
        !isObject(req.body) ||
        typeof req.body.promptId !== "string" ||
        typeof req.body.value !== "string"
      )
        return bad(reply);
      const { promptId, value } = req.body;
      if (!login.answer(req.params.id, req.params.loginId, promptId, value))
        return notFound(reply);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; loginId: string } }>(
    "/api/v1/providers/:id/login/:loginId",
    async (req, reply) => {
      // 已结束的登录再取消照样 204；只有从来没有过的登录才是 404。
      if (!login.cancel(req.params.id, req.params.loginId))
        return notFound(reply);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/providers/:id/logout",
    async (req, reply): Promise<ProviderView | FastifyReply> => {
      const id = req.params.id;
      const err = unsupported(catalog, providers, id);
      if (err) return reject(reply, err);
      await login.logout(id);
      const rec = providers.get(id);
      // 订阅登录凭据已清掉，认证方式回到缺省（API Key）。
      if (rec?.method === "oauth")
        providers.save({
          ...rec,
          method: catalog.defaultMethod(id),
          updatedAt: new Date().toISOString(),
        });
      return buildView(deps, id, providers.get(id));
    },
  );
}
