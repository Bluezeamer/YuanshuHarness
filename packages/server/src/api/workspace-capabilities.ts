import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import {
  CAPABILITY_KINDS,
  type CapabilityKind,
  type CapabilityStore,
} from "../store/capabilities.js";
import type { McpStore } from "../store/mcp.js";
import type { SkillStore } from "../store/skills.js";
import type { WorkspaceStore } from "../store/workspaces.js";
import { bad, notFound } from "./lib/reply.js";

export interface WorkspaceCapabilityDeps {
  workspaces: WorkspaceStore;
  capabilities: CapabilityStore;
  skills: SkillStore;
  mcp: McpStore;
}

// 工作区级能力分配：勾了哪个 skill / MCP 就在该工作区的会话里额外开启（全局项每个会话默认生效）。
export async function registerWorkspaceCapabilityRoutes(
  app: FastifyInstance,
  deps: WorkspaceCapabilityDeps,
): Promise<void> {
  const { workspaces, capabilities, skills, mcp } = deps;

  const view = (workspaceId: string) => ({
    skill: capabilities.list(workspaceId, "skill"),
    mcp: capabilities.list(workspaceId, "mcp"),
  });

  // 库里已不存在时返回错误码与名字（消息里点名）。
  const unknown = (kind: CapabilityKind, name: string): string | null => {
    if (kind === "skill") return skills.get(name) ? null : "unknown_skill";
    return mcp.get(name) ? null : "unknown_mcp";
  };

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/capabilities",
    async (req, reply) =>
      workspaces.get(req.params.id) ? view(req.params.id) : notFound(reply),
  );

  // 整体替换；body 里缺的那一类不动。
  app.put<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/capabilities",
    async (req, reply) => {
      if (!workspaces.get(req.params.id)) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      for (const kind of CAPABILITY_KINDS) {
        const names = body[kind];
        if (names === undefined) continue;
        if (!Array.isArray(names) || !names.every((n) => typeof n === "string"))
          return bad(reply, "invalid_names", `${kind} 须为字符串数组`);
        for (const name of names as string[]) {
          const problem = unknown(kind, name);
          if (problem) return bad(reply, problem, name);
        }
      }
      for (const kind of CAPABILITY_KINDS) {
        const names = body[kind];
        if (names !== undefined)
          capabilities.set(req.params.id, kind, names as string[]);
      }
      return view(req.params.id);
    },
  );
}
