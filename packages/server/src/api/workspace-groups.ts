import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import {
  GROUP_NAME_MAX,
  GROUP_TONES,
  type WorkspaceGroup,
  type WorkspaceGroupStore,
} from "../store/workspace-groups.js";
import { bad, notFound } from "./lib/reply.js";

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function groupName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim();
  const len = [...name].length;
  return len >= 1 && len <= GROUP_NAME_MAX ? name : null;
}

export function workspaceGroupsApi(
  app: FastifyInstance,
  opts: { groups: WorkspaceGroupStore },
): void {
  const { groups } = opts;

  app.get("/api/v1/workspace-groups", async () => ({ groups: groups.list() }));

  app.post("/api/v1/workspace-groups", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const name = groupName(body.name);
    if (
      name === null ||
      (body.tone !== undefined && !isInt(body.tone, 0, GROUP_TONES - 1))
    )
      return bad(reply);
    return reply.code(201).send(
      groups.create({
        name,
        ...(body.tone === undefined ? {} : { tone: body.tone as number }),
      }),
    );
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/workspace-groups/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      const patch: Partial<Omit<WorkspaceGroup, "id">> = {};
      if (body.name !== undefined) {
        const name = groupName(body.name);
        if (name === null) return bad(reply);
        patch.name = name;
      }
      if (body.tone !== undefined) {
        if (!isInt(body.tone, 0, GROUP_TONES - 1)) return bad(reply);
        patch.tone = body.tone;
      }
      if (body.collapsed !== undefined) {
        if (typeof body.collapsed !== "boolean") return bad(reply);
        patch.collapsed = body.collapsed;
      }
      if (body.order !== undefined) {
        if (!isInt(body.order, 0, 2 ** 31 - 1)) return bad(reply);
        patch.order = body.order;
      }
      if (Object.keys(patch).length === 0) return bad(reply);
      return groups.update(req.params.id, patch) ?? notFound(reply);
    },
  );

  // 删分组只解散：组内工作区保留，group_id 置空。
  app.delete<{ Params: { id: string } }>(
    "/api/v1/workspace-groups/:id",
    async (req, reply) =>
      groups.remove(req.params.id) ? reply.code(204).send() : notFound(reply),
  );
}
