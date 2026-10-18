import type { FastifyInstance, FastifyReply } from "fastify";
import type { Doc, WorkbenchStore } from "../store/workbench.js";

// 请求体上限；超出由 Fastify 直接返回 413。
export const MAX_BODY_BYTES = 256 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// 文档只校验到"带整数 version 的对象"，内部结构归客户端。
const isDoc = (v: unknown): v is Doc =>
  isObject(v) && Number.isSafeInteger(v.version);

const isRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function bad(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error });
}

export async function workbenchApi(
  app: FastifyInstance,
  opts: { store: WorkbenchStore },
): Promise<void> {
  const { store } = opts;
  const limit = { bodyLimit: MAX_BODY_BYTES };

  app.get("/api/v1/workbench", async () => store.get());

  app.put("/api/v1/workbench", limit, async (req, reply) => {
    const body = req.body;
    if (
      !isObject(body) ||
      !isRevision(body.baseRevision) ||
      !isDoc(body.document)
    )
      return bad(reply, "invalid_body");
    const r = store.put(body.baseRevision, body.document);
    if (r.ok) return { revision: r.revision };
    return reply.code(409).send(r.current);
  });

  app.get("/api/v1/saved-layouts", async () => ({
    layouts: store.listSaved(),
  }));

  app.post("/api/v1/saved-layouts", limit, async (req, reply) => {
    const body = req.body;
    if (!isObject(body) || !isDoc(body.document))
      return bad(reply, "invalid_body");
    const created = store.createSaved(body.document);
    return reply.code(201).send({ id: created.id, revision: created.revision });
  });

  app.put<{ Params: { id: string } }>(
    "/api/v1/saved-layouts/:id",
    limit,
    async (req, reply) => {
      const body = req.body;
      if (
        !isObject(body) ||
        !isRevision(body.baseRevision) ||
        !isDoc(body.document)
      )
        return bad(reply, "invalid_body");
      const r = store.putSaved(req.params.id, body.baseRevision, body.document);
      if (r === null) return reply.code(404).send({ error: "not_found" });
      if (r.ok) return { revision: r.revision };
      return reply.code(409).send(r.current);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/saved-layouts/:id",
    async (req, reply) => {
      if (!store.deleteSaved(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}
