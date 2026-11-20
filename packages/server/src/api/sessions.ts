import type { FastifyInstance, FastifyReply } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { EnvHub } from "../env/hub.js";
import type { GoalContent } from "../session/goal-driver.js";
import { SessionLibrary } from "../session/library.js";
import {
  PoolError,
  type SessionEntry,
  type SessionPool,
} from "../session/pool.js";
import { StateError } from "../session/session-state.js";
import {
  pageMessages,
  readCompactions,
  readNotices,
} from "../store/history.js";
import type { ConfigBody } from "../store/session-configs.js";
import type { WorkspaceDefaults } from "../store/workspaces.js";
import type { WatchHub } from "../watch/hub.js";
import { failIfOverloaded, startHeartbeat } from "./lib/ws.js";
import { configError, registerSessionConfig } from "./session-config.js";
import { libraryError, registerSessionLibrary } from "./session-library.js";
import { registerSessionModes } from "./session-modes.js";
import { registerSessionTree } from "./session-tree.js";

export interface SessionsApiOptions {
  pool: SessionPool | null;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  maxBufferedBytes: number;
  maxPendingBytes: number;
  /** 文件变更监听中枢（有限感知刷新）；没接就没有 fs.changed 推送 */
  watcher?: WatchHub | null;
  /** 用来校验 watch 命令里的环境 id 是否可用 */
  envs?: EnvHub | null;
  /** 工作区的新会话默认配置（稀疏，引用已失效的字段已剔除）；不存在返回 null */
  workspaceDefaults?:
    | ((workspaceId: string) => WorkspaceDefaults | null)
    | null;
}

export const DEFAULTS = {
  pingIntervalMs: 30_000,
  pongTimeoutMs: 10_000,
  maxBufferedBytes: 64 * 1024 * 1024,
  maxPendingBytes: 50 * 1024 * 1024,
  maxPayloadBytes: 50 * 1024 * 1024,
};

type AckError = { code: string; message: string };

const OPEN = 1;
// 附件数量上限：只为挡住异常载荷，正常使用远小于它。
const MAX_ATTACHMENTS = 100;
// 命令 id 由客户端生成，会被原样回显进 ack，所以必须有界。
const MAX_CMD_ID_LEN = 256;
const MAX_ATTACHMENT_PATH_LEN = 4096;
// 一个会话同时盯的路径上限：就是「展开的目录 + 打开的预览文件」，正常远小于它。
const MAX_WATCH_PATHS = 100;
const rawSize = (raw: RawData): number =>
  Array.isArray(raw)
    ? raw.reduce((n, b) => n + b.length, 0)
    : "byteLength" in raw
      ? raw.byteLength
      : 0;

// 客户端只传附件路径引用；name/mime/size 一律不采信，服务端按磁盘重算。
function parseAttachments(value: unknown): { path: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const out: { path: string }[] = [];
  for (const v of value) {
    const a = v as { path?: unknown } | null;
    if (
      !a ||
      typeof a.path !== "string" ||
      a.path === "" ||
      a.path.length > MAX_ATTACHMENT_PATH_LEN
    )
      return null;
    out.push({ path: a.path });
  }
  return out;
}

export async function sessionsApi(
  app: FastifyInstance,
  opts: SessionsApiOptions,
): Promise<void> {
  const { pool } = opts;
  const library = pool ? new SessionLibrary(pool) : null;
  if (pool && library) {
    registerSessionLibrary(app, library);
    registerSessionTree(app, pool, library);
    registerSessionModes(app, pool);
  }
  if (pool?.configs) registerSessionConfig(app, pool, pool.configs);
  const sockets = new Set<WebSocket>();

  // 文件变更 → 推给该会话的所有订阅者。key 是会话 id（与 watch 命令一致）。
  // 监听按连接引用计数：最后一个上报过 watch 的连接断开时才真正退订。
  const watchRefs = new Map<string, number>();
  const offChanged =
    opts.watcher?.onChanged((key, env, paths) => {
      try {
        pool?.get(key)?.publish("fs.changed", { env, paths });
      } catch {
        // 会话已关闭等情况：丢一帧不影响别的会话
      }
    }) ?? null;
  if (offChanged) app.addHook("onClose", async () => offChanged());

  const loadFailed = (err: unknown, reply: FastifyReply) => {
    if (err instanceof PoolError && err.code === "load_failed") {
      app.log.error({ err }, "加载会话失败");
      return reply.code(500).send({ error: "session_load_failed" });
    }
    throw err;
  };

  app.post("/api/v1/sessions", async (req, reply) => {
    if (!pool?.canCreate) {
      return reply.code(501).send({ error: "no_session_backend" });
    }
    const body = req.body as
      | {
          directoryId?: unknown;
          directoryIds?: unknown;
          workspaceId?: unknown;
          promptPresetId?: unknown;
          modePresetIds?: unknown;
          config?: unknown;
        }
      | null
      | undefined;
    const directoryId = body?.directoryId;
    const directoryIds = body?.directoryIds;
    if (
      directoryIds !== undefined &&
      (!Array.isArray(directoryIds) ||
        !directoryIds.every((w) => typeof w === "string"))
    )
      return reply.code(400).send({ error: "bad_request" });
    if (directoryId !== undefined && typeof directoryId !== "string")
      return reply.code(400).send({ error: "bad_request" });
    const workspaceId = body?.workspaceId;
    if (workspaceId !== undefined && typeof workspaceId !== "string")
      return reply.code(400).send({ error: "bad_request" });
    // 工作区默认配置稀疏覆盖全局默认；只在此刻套用一次，之后不再跟随（W3）。
    // 工作区是否存在由 pool.create 校验（不存在 → bad_request），这里只管取默认值。
    const wsDefaults =
      workspaceId === undefined
        ? null
        : (opts.workspaceDefaults?.(workspaceId) ?? null);
    const promptPresetId = body?.promptPresetId ?? wsDefaults?.agentPresetId;
    if (promptPresetId !== undefined && typeof promptPresetId !== "string")
      return reply.code(400).send({ error: "bad_request" });
    const modePresetIds = body?.modePresetIds ?? wsDefaults?.modePresetIds;
    if (
      modePresetIds !== undefined &&
      (!Array.isArray(modePresetIds) ||
        !modePresetIds.every((m) => typeof m === "string"))
    )
      return reply.code(400).send({ error: "bad_request" });
    // 预设默认值（能力）：面板可以覆盖，没给就按预设来；权限档位没覆盖就跟随全局。
    const presets = pool.choosePresets({
      agentPresetId: promptPresetId ?? null,
    });
    const base: ConfigBody = {
      model: wsDefaults?.model
        ? { mode: "explicit", ...wsDefaults.model }
        : { mode: "follow-default" },
      capabilities: presets?.capabilities ?? null,
      permissionTier: wsDefaults?.permissionTier ?? null,
    };
    let config = base;
    if (body?.config !== undefined) {
      if (!pool.configs) return reply.code(400).send({ error: "bad_request" });
      try {
        config = pool.configs.parseNew(base, body.config);
      } catch (err) {
        return configError(err, reply);
      }
    }
    try {
      const info = await pool.create({
        ...(directoryId === undefined ? {} : { directoryId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(promptPresetId === undefined ? {} : { promptPresetId }),
        ...(modePresetIds === undefined
          ? {}
          : { modePresetIds: modePresetIds as string[] }),
        ...(directoryIds === undefined
          ? {}
          : { directoryIds: directoryIds as string[] }),
        config,
      });
      return reply.code(201).send({
        id: info.id,
        createdAt: info.createdAt,
        directoryId: info.directoryId,
        workspaceId: pool.workspaceIdOf(info.id),
        promptPresetId: info.promptPresetId,
        modePresetIds: info.modePresetIds,
        activeModeId: info.activeModeId,
      });
    } catch (err) {
      if (err instanceof PoolError && err.code === "bad_request")
        return reply.code(400).send({ error: "bad_request" });
      if (err instanceof PoolError)
        return reply.code(503).send({ error: err.code });
      app.log.error({ err }, "创建会话失败");
      return reply.code(500).send({ error: "session_create_failed" });
    }
  });

  app.get<{ Querystring: { status?: string; q?: string } }>(
    "/api/v1/sessions",
    async (req, reply) => {
      try {
        return { sessions: library?.list(req.query) ?? [] };
      } catch (err) {
        return libraryError(app, err, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id",
    async (req, reply) => {
      const view = library?.get(req.params.id);
      if (!view) return reply.code(404).send({ error: "not_found" });
      return view;
    },
  );

  // title 即 name 的别名；name 作为旧入参继续兼容。
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/v1/sessions/:id",
    async (req, reply) => {
      if (!library) return reply.code(404).send({ error: "not_found" });
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body))
        return reply.code(400).send({ error: "bad_request" });
      try {
        return await library.patch(req.params.id, body);
      } catch (err) {
        return libraryError(app, err, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/sessions/:id",
    async (req, reply) => {
      try {
        const r = await pool?.remove(req.params.id);
        if (!r || r === "not_found")
          return reply.code(404).send({ error: "not_found" });
        if (r === "running")
          return reply.code(409).send({ error: "session_running" });
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof PoolError && err.code === "delete_failed") {
          app.log.error({ err }, "删除会话文件失败");
          return reply.code(500).send({ error: "session_delete_failed" });
        }
        throw err;
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>("/api/v1/sessions/:id/messages", async (req, reply) => {
    try {
      const all = pool?.history(req.params.id);
      if (!all) return reply.code(404).send({ error: "not_found" });
      const page = pageMessages(all, req.query.before, req.query.limit);
      if (!page.ok) return reply.code(400).send({ error: "bad_request" });
      // 压缩锚点：afterIndex 是这段对话里该压缩条目之前的消息条数，前端据此插分割线。
      const file = pool?.sessionFile(req.params.id);
      const compactions = file
        ? readCompactions(file.file, file.dir, req.params.id).map((c) => ({
            afterIndex: c.afterIndex,
            seq: c.seq,
            summary: c.summary,
            tokensBefore: c.tokensBefore,
            createdAt: c.createdAt,
          }))
        : [];
      // 卡片（后台任务回调、目标）：与 compactions 一样不随分页变，每次给整条分支的
      const notices = file
        ? readNotices(file.file, file.dir, req.params.id)
        : [];
      return {
        messages: page.messages,
        nextBefore: page.nextBefore,
        compactions,
        notices,
      };
    } catch (err) {
      return loadFailed(err, reply);
    }
  });

  app.get<{ Params: { id: string; index: string } }>(
    "/api/v1/sessions/:id/messages/:index",
    async (req, reply) => {
      if (!/^(0|[1-9][0-9]*)$/.test(req.params.index))
        return reply.code(400).send({ error: "bad_request" });
      try {
        const all = pool?.history(req.params.id);
        if (!all) return reply.code(404).send({ error: "not_found" });
        const m = all[Number(req.params.index)];
        if (!m) return reply.code(404).send({ error: "not_found" });
        return m;
      } catch (err) {
        return loadFailed(err, reply);
      }
    },
  );

  // 长期目标 / 任务清单 / 最近一次压缩；实时变化走 WS 的 goal.updated / plan.updated / context.compacted。
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/state",
    async (req, reply) => {
      if (!pool?.info(req.params.id))
        return reply.code(404).send({ error: "not_found" });
      return pool.stateOf(req.params.id);
    },
  );

  // 右栏上下文：读取的文件、已加载的 skill 与 MCP；文件表变化时 WS 推 context.updated，客户端据此重新拉取。
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/context",
    async (req, reply) =>
      pool?.contextOf(req.params.id) ??
      reply.code(404).send({ error: "not_found" }),
  );

  // 刷新上下文（原地，输入框的 /reload）：重读约定文件、同步技能、重连 MCP、重抓主机登录环境、重建前缀。
  // 运行中不动（409）。连接是后台建的，结果看 /context。
  app.post<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/reload",
    async (req, reply) => {
      try {
        const r = (await pool?.refreshContext(req.params.id)) ?? "not_found";
        if (r === "not_found")
          return reply.code(404).send({ error: "not_found" });
        if (r === "busy")
          return reply.code(409).send({ error: "session_running" });
        return { status: "reloaded" };
      } catch (err) {
        app.log.error({ err }, "刷新上下文失败");
        return reply.code(500).send({
          error: "reload_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/stream",
    {
      websocket: true,
      // 升级之前加载并拒绝：不存在的会话得到普通 404，加载失败得到 500，而不是先握手再关闭。
      preValidation: async (req, reply) => {
        try {
          if (!(await pool?.acquire(req.params.id)))
            return reply.code(404).send({ error: "not_found" });
        } catch (err) {
          return loadFailed(err, reply);
        }
      },
    },
    (socket, req) => {
      const entry = pool?.get(req.params.id);
      if (!entry) {
        socket.close(1008, "not_found");
        return;
      }
      serve(socket, entry);
    },
  );

  function serve(socket: WebSocket, entry: SessionEntry): void {
    sockets.add(socket);

    const writeRaw = (text: string): void => {
      if (socket.readyState !== OPEN) throw new Error("socket closed");
      failIfOverloaded(
        socket,
        Buffer.byteLength(text),
        opts.maxBufferedBytes,
        true,
      );
      socket.send(text);
    };
    const subscriber = {
      send: writeRaw,
      close: () => socket.close(1001, "session_deleted"),
    };
    let unsubscribe = () => {};
    // 这个连接是否上报过 watch（退订时要按连接计数放行）
    let watched = false;

    const ack = (
      id: unknown,
      error?: AckError,
      data?: Record<string, unknown>,
    ): void => {
      const frame = error
        ? { type: "ack", ...(id === undefined ? {} : { id }), ok: false, error }
        : { type: "ack", id, ok: true, ...(data ? { data } : {}) };
      try {
        writeRaw(JSON.stringify(frame));
      } catch {
        // 连接已不可写，命令的效果仍然保留。
      }
    };

    const stopHeartbeat = startHeartbeat(
      socket,
      opts.pingIntervalMs,
      opts.pongTimeoutMs,
    );

    // 命令队列：按到达顺序逐条处理；连接关闭时直接丢弃未处理的消息，释放其内存。
    const queue: Array<{ raw: RawData; isBinary: boolean; size: number }> = [];
    let draining = false;
    let pending = 0;

    // 必须先于 subscribe 安装：首帧（大快照）就可能触发背压断开。
    socket.on("close", () => {
      stopHeartbeat();
      unsubscribe();
      if (watched) {
        const left = (watchRefs.get(entry.id) ?? 1) - 1;
        if (left <= 0) {
          watchRefs.delete(entry.id);
          opts.watcher?.release(entry.id);
        } else {
          watchRefs.set(entry.id, left);
        }
      }
      sockets.delete(socket);
      queue.length = 0;
      pending = 0;
    });

    try {
      unsubscribe = entry.subscribe(subscriber);
    } catch {
      // 首帧写入失败（背压或连接已关）：连接已被关闭，清理由 close 事件完成。
    }

    // 同一连接的命令严格按到达顺序执行：stop 未完成时，后到的 send_message 不得抢先。
    // pending 是已收到但未处理完的字节；超限说明客户端发得比处理得快，断开而不是无界缓存。
    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        for (let m = queue.shift(); m; m = queue.shift()) {
          if (socket.readyState !== OPEN) {
            queue.length = 0;
            pending = 0;
            break;
          }
          try {
            await handle(m.raw, m.isBinary);
          } finally {
            pending = Math.max(0, pending - m.size);
          }
        }
      } finally {
        draining = false;
      }
    }
    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (socket.readyState !== OPEN) return;
      const size = rawSize(raw);
      pending += size;
      if (pending > opts.maxPendingBytes) {
        socket.close(1013, "overloaded");
        return;
      }
      queue.push({ raw, isBinary, size });
      void drain();
    });

    async function handle(raw: RawData, isBinary: boolean): Promise<void> {
      let msg: Record<string, unknown>;
      try {
        if (isBinary) throw new Error("binary");
        const parsed: unknown = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return ack(undefined, {
          code: "bad_request",
          message: "消息必须是 JSON 对象文本",
        });
      }
      const { id, type } = msg;
      if (typeof id !== "string" || id === "" || id.length > MAX_CMD_ID_LEN)
        return ack(undefined, {
          code: "bad_request",
          message: `id 必须是 1 到 ${MAX_CMD_ID_LEN} 个字符的字符串`,
        });
      try {
        switch (type) {
          case "send_message": {
            const attachments = parseAttachments(msg.attachments);
            if (typeof msg.text !== "string" || attachments === null)
              return ack(id, {
                code: "bad_request",
                message: "text 必须是字符串，attachments 必须是 {path} 数组",
              });
            if (!pool)
              return ack(id, { code: "internal", message: "没有会话后端" });
            await pool.sendUserMessage(
              entry.id,
              msg.text,
              attachments.map((a) => a.path),
            );
            return ack(id);
          }
          // 排队中的用户消息：index 是 queue.updated 的顺序（steering 在前、follow-up 在后）。
          // 只读取全文：queue.updated 里的文本为显示截断过，编辑前单独拉一次完整内容。
          case "get_queue":
            return ack(id, undefined, { queue: entry.queueTexts() });
          // 附件必填（可以是空数组）：始终重新解析，替换那条排队消息的文字与图片。
          case "edit_queue": {
            const attachments = parseAttachments(msg.attachments);
            if (
              typeof msg.index !== "number" ||
              typeof msg.text !== "string" ||
              msg.attachments === undefined ||
              attachments === null
            )
              return ack(id, {
                code: "bad_request",
                message:
                  "index 必须是数字，text 必须是字符串，attachments 必须是 {path} 数组",
              });
            if (!pool)
              return ack(id, { code: "internal", message: "没有会话后端" });
            const c = await pool.resolveContent(
              entry.id,
              msg.text,
              attachments.map((a) => a.path),
            );
            await entry.editQueue(msg.index, c.text, c.images);
            return ack(id);
          }
          case "remove_queue": {
            if (typeof msg.index !== "number")
              return ack(id, {
                code: "bad_request",
                message: "index 必须是数字",
              });
            await entry.removeQueue(msg.index);
            return ack(id);
          }
          // 回答弹窗：选项、文字、附件可以任意组合（至少一样，由弹窗表判）。
          // 给附件时先解析成用户内容（文字带标记行、图片随答复），只有 input: "rich" 的弹窗收。
          case "answer_prompt": {
            if (typeof msg.promptId !== "string" || msg.promptId === "")
              return ack(id, {
                code: "bad_request",
                message: "promptId 必须是字符串",
              });
            const attachments = parseAttachments(msg.attachments);
            if (attachments === null)
              return ack(id, {
                code: "bad_request",
                message: "attachments 必须是 {path} 数组",
              });
            if (attachments.length === 0) {
              entry.answerPrompt(msg.promptId, {
                optionId: msg.optionId,
                text: msg.text,
              });
              return ack(id);
            }
            if (!pool)
              return ack(id, { code: "internal", message: "没有会话后端" });
            const c = await pool.resolveContent(
              entry.id,
              typeof msg.text === "string" ? msg.text : "",
              attachments.map((a) => a.path),
            );
            entry.answerPrompt(msg.promptId, {
              optionId: msg.optionId,
              text: c.text,
              images: c.images,
              attached: true,
            });
            return ack(id);
          }
          case "stop":
            await entry.stop();
            return ack(id);
          case "resync":
            entry.resync(subscriber);
            return ack(id);
          // 探活：回前台时确认连接还活着，只要一个回执。
          case "ping":
            return ack(id);
          // 有限感知刷新：前端上报「现在要看哪些路径」（当前展开的目录 + 打开的预览文件），
          // 整体替换该会话的订阅集合；变化时服务端推 fs.changed。
          case "watch": {
            const watcher = opts.watcher;
            const envId = msg.env;
            if (!watcher)
              return ack(id, { code: "unsupported", message: "没有文件监听" });
            if (typeof envId !== "string" || envId === "")
              return ack(id, {
                code: "bad_request",
                message: "env 必须是非空字符串",
              });
            const raw = msg.paths;
            if (!Array.isArray(raw) || raw.length > MAX_WATCH_PATHS)
              return ack(id, {
                code: "bad_request",
                message: `paths 必须是数组，最多 ${MAX_WATCH_PATHS} 项`,
              });
            const paths: string[] = [];
            for (const v of raw) {
              if (typeof v !== "string" || !v.startsWith("/")) {
                return ack(id, {
                  code: "bad_request",
                  message: "paths 里每一项都必须是以 / 开头的绝对路径",
                });
              }
              paths.push(v);
            }
            if (paths.length > 0 && !opts.envs?.get(envId))
              return ack(id, { code: "bad_request", message: "环境不可用" });
            watcher.set(entry.id, envId, paths);
            if (!watched) {
              watched = true;
              watchRefs.set(entry.id, (watchRefs.get(entry.id) ?? 0) + 1);
            }
            return ack(id);
          }
          // 目标 / 压缩命令：不经过 send，自身不发起模型调用（compact 由 SDK 生成摘要除外）。
          // 附件经 resolveContent 解析出引用与图片；目标的文字用原文，不用带标记行的那份。
          case "set_goal": {
            if (typeof msg.text !== "string")
              return ack(id, {
                code: "bad_request",
                message: "text 必须是字符串",
              });
            const attachments = parseAttachments(msg.attachments);
            if (attachments === null)
              return ack(id, {
                code: "bad_request",
                message: "attachments 必须是 {path} 数组",
              });
            if (attachments.length === 0) {
              entry.goal.create(msg.text);
              return ack(id);
            }
            if (!pool)
              return ack(id, { code: "internal", message: "没有会话后端" });
            const c = await pool.resolveContent(
              entry.id,
              msg.text,
              attachments.map((a) => a.path),
            );
            entry.goal.create(msg.text, {
              attachments: c.attachments,
              images: c.images,
            });
            return ack(id);
          }
          case "edit_goal": {
            const maxRounds = msg.maxRounds;
            if (msg.text !== undefined && typeof msg.text !== "string")
              return ack(id, {
                code: "bad_request",
                message: "text 必须是字符串",
              });
            if (
              maxRounds !== undefined &&
              maxRounds !== null &&
              !(
                typeof maxRounds === "number" &&
                Number.isInteger(maxRounds) &&
                maxRounds >= 1
              )
            )
              return ack(id, {
                code: "bad_request",
                message: "maxRounds 必须是正整数或 null",
              });
            // attachments 出现即替换（空数组 = 清空附件）。
            const paths =
              msg.attachments === undefined
                ? undefined
                : parseAttachments(msg.attachments)?.map((a) => a.path);
            if (paths === undefined && msg.attachments !== undefined)
              return ack(id, {
                code: "bad_request",
                message: "attachments 必须是 {path} 数组",
              });
            if (
              typeof msg.text !== "string" &&
              maxRounds === undefined &&
              paths === undefined
            )
              return ack(id, {
                code: "bad_request",
                message: "至少要改一项：text、maxRounds 或 attachments",
              });
            let content: GoalContent | undefined;
            if (paths !== undefined) {
              if (!pool)
                return ack(id, { code: "internal", message: "没有会话后端" });
              const c = await pool.resolveContent(
                entry.id,
                typeof msg.text === "string" ? msg.text : "",
                paths,
              );
              content = { attachments: c.attachments, images: c.images };
            }
            entry.goal.edit({
              ...(typeof msg.text === "string" ? { text: msg.text } : {}),
              ...(maxRounds === undefined
                ? {}
                : { maxRounds: maxRounds as number | null }),
              ...(content === undefined ? {} : { content }),
            });
            return ack(id);
          }
          case "pause_goal":
            await entry.goal.pause();
            return ack(id);
          case "resume_goal":
            entry.goal.resume();
            return ack(id);
          case "clear_goal":
            entry.goal.clear();
            return ack(id);
          case "compact":
            entry.compact();
            return ack(id);
          default:
            return ack(id, {
              code: "unknown_command",
              message: `未知命令：${String(type)}`,
            });
        }
      } catch (err) {
        if (err instanceof PoolError || err instanceof StateError)
          return ack(id, { code: err.code, message: err.message });
        app.log.error({ err }, "命令执行失败");
        return ack(id, { code: "internal", message: "内部错误" });
      }
    }
  }

  // 停止时先断开全部连接，再释放全部会话，最后才轮到 HTTP 服务关闭。
  app.addHook("preClose", async () => {
    const open = [...sockets];
    const closed = open.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (s.readyState === 3) return resolve();
          s.once("close", () => resolve());
          s.close(1001, "server_shutdown");
          // 对端不配合关闭握手时不能让 stop() 一直等下去。
          const force = setTimeout(() => s.terminate(), 1000);
          s.once("close", () => clearTimeout(force));
        }),
    );
    pool?.dispose();
    await Promise.all(closed);
  });
}
