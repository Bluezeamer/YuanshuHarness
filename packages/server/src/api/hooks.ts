import type { FastifyInstance } from "fastify";
import { POINTS } from "../hooks/points.js";
import { type HookCtx, type HookRuntime, hookCtx } from "../hooks/runtime.js";
import { isObject } from "../lib/validate.js";
import type { DirectoryStore } from "../store/directories.js";
import { type Hook, type HookStore, parseHookInput } from "../store/hooks.js";
import { bad, notFound } from "./lib/reply.js";

export interface HooksApiDeps {
  hooks: HookStore;
  directories: DirectoryStore;
  runtime: HookRuntime;
}

const asBody = (h: Hook) => ({
  name: h.name,
  point: h.point,
  matcher: h.matcher,
  command: h.command,
  timeoutSec: h.timeoutSec,
  enabled: h.enabled,
  directoryId: h.directoryId,
});

// 用户可配置 hook 的 REST（ADR-0085）。增删改与试跑只在这里；模型没有对应工具。
export async function hooksApi(
  app: FastifyInstance,
  deps: HooksApiDeps,
): Promise<void> {
  const { hooks, directories, runtime } = deps;

  app.get("/api/v1/hooks", async () => ({
    hooks: hooks.list(),
    points: POINTS,
  }));

  app.post("/api/v1/hooks", async (req, reply) => {
    const input = parseHookInput(req.body);
    if (typeof input === "string") return bad(reply, "invalid_hook", input);
    if (input.directoryId !== null && !directories.get(input.directoryId))
      return bad(reply, "unknown_directory");
    return reply.code(201).send(hooks.create(input));
  });

  app.put<{ Params: { id: string } }>(
    "/api/v1/hooks/:id",
    async (req, reply) => {
      const cur = hooks.get(req.params.id);
      if (!cur) return notFound(reply);
      // 字段可部分给出：与现有值合并后整体校验。
      const patch = isObject(req.body) ? req.body : {};
      const input = parseHookInput({ ...asBody(cur), ...patch });
      if (typeof input === "string") return bad(reply, "invalid_hook", input);
      if (input.directoryId !== null && !directories.get(input.directoryId))
        return bad(reply, "unknown_directory");
      return hooks.update(cur.id, input) ?? notFound(reply);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/hooks/:id",
    async (req, reply) =>
      hooks.remove(req.params.id) ? reply.code(204).send() : notFound(reply),
  );

  // 试跑：用给定（缺省为点位样例）载荷执行一次，不看 matcher 与启用状态；审计里带 test 标记。
  app.post<{ Params: { id: string } }>(
    "/api/v1/hooks/:id/test",
    async (req, reply) => {
      const hook = hooks.get(req.params.id);
      if (!hook) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      if (body.payload !== undefined && !isObject(body.payload))
        return bad(reply, "invalid_payload", "payload 须为对象");
      const ws =
        (hook.directoryId ? directories.get(hook.directoryId) : undefined) ??
        directories.getDefault();
      if (!ws) return bad(reply, "no_directory", "没有可用的 directory");
      const ctx: HookCtx = hookCtx(ws, "");
      return runtime.test(
        hook,
        ctx,
        body.payload as Record<string, unknown> | undefined,
      );
    },
  );
}
