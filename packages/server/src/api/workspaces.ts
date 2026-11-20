import { posix } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isObject } from "../lib/validate.js";
import { presetCardIds } from "../prompt/compose.js";
import { AGENTS_FILE } from "../session/agents-md.js";
import { renderAgentsMd } from "../session/agents-md-presets.js";
import type { SessionPool } from "../session/pool.js";
import type { WorkspaceLifecycle } from "../session/workspace-lifecycle.js";
import {
  WorkspaceError,
  type WorkspaceService,
} from "../session/workspaces.js";
import type { PromptCardStore } from "../store/prompt-cards.js";
import type { PromptPresetStore } from "../store/prompt-presets.js";
import { bad, notFound, toHttp } from "./lib/reply.js";

// 请求体上限；超出由 Fastify 直接返回 413。
const MAX_BODY_BYTES = 256 * 1024;

// 重排请求的条数上限：只为挡住异常载荷。
const REORDER_MAX = 1000;

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= REORDER_MAX &&
  v.every((id) => typeof id === "string");

// 布局冲突要带上服务端当前值（revision 与 document）。
function workspaceError(err: unknown, reply: FastifyReply) {
  if (
    err instanceof WorkspaceError &&
    err.code === "revision_conflict" &&
    err.current !== undefined
  )
    return reply.code(409).send(err.current);
  return toHttp(reply, err);
}

// 读不到（不存在、没权限）都当「没有这份文件」
async function readOrNull(read: () => Promise<string>): Promise<string | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export function workspacesApi(
  app: FastifyInstance,
  opts: {
    service: WorkspaceService;
    lifecycle: WorkspaceLifecycle;
    // 项目 AGENTS.md 的写入：预设拼成文本，落到工作区主目录（取环境与根路径同 session/pool.ts）
    presets: PromptPresetStore;
    cards: PromptCardStore;
    pool: SessionPool;
  },
): void {
  const { service, lifecycle, presets, cards, pool } = opts;
  const limit = { bodyLimit: MAX_BODY_BYTES };

  app.get("/api/v1/workspaces", async () => ({ workspaces: service.list() }));

  app.post("/api/v1/workspaces", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    try {
      const r = await service.create({
        directories: body.directories,
        name: body.name,
        description: body.description,
        defaults: body.defaults,
      });
      return reply.code(r.created ? 201 : 200).send(r.workspace);
    } catch (err) {
      return workspaceError(err, reply);
    }
  });

  // 静态路径先于 /:id 注册；重排请求不会被当成 id=reorder。
  app.put("/api/v1/workspaces/reorder", async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    if (!isIdList(body.ids)) return bad(reply, "bad_request");
    try {
      service.reorder(body.ids);
      return reply.code(204).send();
    } catch (err) {
      return workspaceError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req, reply) => {
      const view = service.get(req.params.id);
      return view ?? notFound(reply);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      try {
        return await service.update(req.params.id, body);
      } catch (err) {
        return workspaceError(err, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/layout",
    async (req, reply) => {
      try {
        return service.layout(req.params.id);
      } catch (err) {
        return workspaceError(err, reply);
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/layout",
    limit,
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      try {
        return service.putLayout(
          req.params.id,
          body.baseRevision,
          body.document,
        );
      } catch (err) {
        return workspaceError(err, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/removal-preview",
    async (req, reply) => {
      try {
        return lifecycle.removalPreview(req.params.id);
      } catch (err) {
        return workspaceError(err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id",
    async (req, reply) => {
      try {
        await lifecycle.remove(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return workspaceError(err, reply);
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/directories",
    limit,
    async (req, reply) => {
      const body = isObject(req.body) ? req.body : {};
      try {
        return await lifecycle.setDirectories(req.params.id, {
          directories: body.directories,
          dryRun: body.dryRun,
        });
      } catch (err) {
        return workspaceError(err, reply);
      }
    },
  );

  /**
   * 把一份「项目 AGENTS.md」预设写进主目录的 `AGENTS.md`：只用于创建工作区时起个头，
   * 之后文件归项目自己。已有内容时不带 mode 给 409，由人决定覆盖还是追加。
   */
  app.post<{ Params: { id: string } }>(
    "/api/v1/workspaces/:id/agents-md",
    async (req, reply) => {
      const ws = service.get(req.params.id);
      if (!ws) return notFound(reply);
      const body = isObject(req.body) ? req.body : {};
      const preset =
        typeof body.presetId === "string"
          ? presets.detail(body.presetId)
          : undefined;
      if (!preset || preset.kind !== "project-agentsmd")
        return bad(reply, "bad_preset");
      const primary = ws.directories.find((d) => d.role === "local");
      const ctx = primary ? pool.directoryContext(primary.id) : null;
      if (!ctx) return notFound(reply);
      const text = renderAgentsMd(preset, cards.getMany(presetCardIds(preset)));
      if (text === "") return bad(reply, "empty_preset");
      const file = posix.join(ctx.root, AGENTS_FILE);
      const current = await readOrNull(() =>
        ctx.env.readFile(file).then((b) => b.toString("utf8")),
      );
      const mode = body.mode;
      if (current !== null && current.trim() !== "") {
        if (mode !== "overwrite" && mode !== "append")
          return reply.code(409).send({ error: "file_exists" });
        await ctx.env.writeFile(
          file,
          mode === "overwrite"
            ? text
            : `${current.trimEnd()}\n\n${text.trimEnd()}\n`,
        );
      } else {
        await ctx.env.writeFile(file, text);
      }
      return { written: true, path: file };
    },
  );
}
