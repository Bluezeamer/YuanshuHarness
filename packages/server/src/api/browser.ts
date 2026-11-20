// 浏览器接口（工作区级）：页面列表与增删唤醒、操作权切换、接管答复、控制台与缩略图、引擎状态，以及一路只读的事件流。
// 画面与输入走页面级的流（api/browser-stream.ts）。认证由 /api/v1 作用域统一施加（含 WS 升级）。
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RawData } from "ws";
import { putIntoDirectory } from "../browser/downloads/deliver.js";
import type { PendingDownloads } from "../browser/downloads/pending.js";
import type { Engine } from "../browser/engine/engine.js";
import { LoginError, type LoginService } from "../browser/login/login.js";
import {
  resolveTarget,
  TargetError,
  type TargetOptions,
} from "../browser/net/target.js";
import type { PageRegistry } from "../browser/pages/registry.js";
import { PageError, type PageErrorCode } from "../browser/pages/types.js";
import type { Replay } from "../browser/replay/replay.js";
import type { ShowBus } from "../browser/show.js";
import { UPLOAD_MAX_TOTAL_BYTES } from "../browser/uploads/limits.js";
import type { PendingUploads } from "../browser/uploads/pending.js";
import { SERVER_HOST_ID } from "../env/host-id.js";
import type { ExecEnv } from "../env/types.js";
import { HttpError } from "../lib/http-error.js";
import { posInt, str } from "../lib/validate.js";
import type { Directory } from "../store/directories.js";
import { LOCAL_ENV_ID } from "../store/environments.js";
import { attachmentDisposition } from "./lib/download.js";
import { bad, notFound, toHttp } from "./lib/reply.js";
import { isPing, startHeartbeat } from "./lib/ws.js";
import { DEFAULTS } from "./sessions.js";

const OPEN = 1;
const TARGET_MAX = 4096;
// 用户在界面上回答对话框时 prompt 输入的上限（与工具层 TYPE_MAX 同一量级）。
const DIALOG_TEXT_MAX = 10000;
// 请求体上限 = 内容上限 + multipart 的框架开销（边界、头）：多给 1 MB 富余。
const FORM_MAX_BYTES = UPLOAD_MAX_TOTAL_BYTES + 1024 * 1024;

/** 请求体超过上限：在流上中止，不让超大请求撑爆内存。 */
class TooLarge extends Error {}

/** 边数边限：累计超过 FORM_MAX_BYTES 就让流报错中止。 */
function countedBody(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > limit) return cb(new TooLarge("请求体太大"));
      cb(null, chunk);
    },
  });
}

/** 解析 multipart 体，取出字段名 files 的文件（名字与字节）。 */
async function readFormFiles(
  body: Readable,
  contentType: string,
): Promise<{ name: string; buffer: Buffer }[]> {
  const stream = body.pipe(countedBody(FORM_MAX_BYTES));
  // 解析中途出错时 pipe 的另一端要跟着收，否则流会一直挂着；超限中止时也不再读后面的 body。
  body.on("error", (err) => stream.destroy(err));
  stream.on("error", () => body.destroy());
  const form = await new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { "content-type": contentType },
  }).formData();
  const files: { name: string; buffer: Buffer }[] = [];
  for (const item of form.getAll("files"))
    if (item instanceof File)
      files.push({
        name: item.name,
        buffer: Buffer.from(await item.arrayBuffer()),
      });
  return files;
}

const STATUS: Record<PageErrorCode, number> = {
  not_found: 404,
  user_controlling: 409,
  busy: 409,
  user_page: 403,
  limit: 409,
  context_failed: 502,
  dialog_pending: 409,
};

// 登录态的错误：这类页面没有站点可言（400），浏览器里还没有可存的东西（409）。
const LOGIN_STATUS: Record<LoginError["code"], number> = {
  no_site: 400,
  no_state: 409,
};

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof PageError)
    return reply
      .code(STATUS[err.code])
      .send({ error: err.code, message: err.message });
  if (err instanceof TargetError) return bad(reply, "bad_target", err.message);
  if (err instanceof LoginError)
    return reply
      .code(LOGIN_STATUS[err.code])
      .send({ error: err.code, message: err.message });
  throw err;
}

export async function browserApi(
  app: FastifyInstance,
  opts: {
    registry: PageRegistry;
    engine: Pick<Engine, "state" | "subscribe" | "ensure">;
    workspaceExists(id: string): boolean;
    /** 用户在地址栏输入的目标怎么解析（默认环境取该工作区的主目录所在环境）。 */
    targetOptions(workspaceKey: string): TargetOptions;
    replay: Pick<Replay, "sessions" | "steps" | "frame">;
    login: Pick<LoginService, "offer" | "save">;
    /** 用户页上挂起的下载：暂存与结算；三个路由都只用这两个。 */
    downloads: {
      pending: Pick<PendingDownloads, "stage" | "settle">;
      /** 本工作区的 directory（含 id、名称、环境） */
      directories(workspaceKey: string): Directory[];
      envOf(d: Directory): ExecEnv | null;
    };
    /** 用户页上挂起的上传选择器 */
    uploads: { pending: Pick<PendingUploads, "fill" | "cancel"> };
    /** 单个文件大小上限（字节），每次请求现取；下载与上传共用 */
    fileMaxBytes(): number;
    /** 工作区级的展示提示：browser_show 经它找到在线的界面。 */
    show: Pick<ShowBus, "subscribe">;
    /** 本工作区见过、且此刻在监听的端口（用户点一下就能开页面）。 */
    ports: {
      listening(
        workspaceKey: string,
      ): Promise<{ envId: string; port: number }[]>;
    };
    pingIntervalMs?: number;
    pongTimeoutMs?: number;
  },
): Promise<void> {
  const { registry, engine } = opts;
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULTS.pongTimeoutMs;

  const overview = (wid: string) => ({
    engine: engine.state(),
    pages: registry.list(wid),
    limits: registry.limitsView(),
  });

  /** 页面必须存在且属于这个工作区，否则一律 404（不泄露别的工作区有没有这个页面）。 */
  const pageIn = (wid: string, pid: string) => {
    const page = registry.get(pid);
    return page && page.workspaceKey === wid ? page : null;
  };

  app.get<{ Params: { wid: string } }>(
    "/api/v1/workspaces/:wid/browser",
    async (req, reply) => {
      if (!opts.workspaceExists(req.params.wid)) return notFound(reply);
      return overview(req.params.wid);
    },
  );

  // 用户自己开页面：起始就是手动操作，不参与会话的引用计数。
  app.post<{ Params: { wid: string }; Body: { target?: unknown } }>(
    "/api/v1/workspaces/:wid/browser/pages",
    async (req, reply) => {
      const { wid } = req.params;
      if (!opts.workspaceExists(wid)) return notFound(reply);
      const raw = req.body?.target;
      if (
        typeof raw !== "string" ||
        raw.trim() === "" ||
        raw.length > TARGET_MAX
      )
        return bad(reply, "bad_target", "地址不能为空，且不超过 4096 字符");
      try {
        const target = resolveTarget(raw, opts.targetOptions(wid));
        const opened = await registry.open({
          workspaceKey: wid,
          actor: null,
          url: target.url,
        });
        return reply.code(201).send(opened);
      } catch (err) {
        if (err instanceof PageError || err instanceof TargetError)
          return fail(reply, err);
        // 页面已登记在列表里，只是导航失败（连接被拒、证书错误等）。
        return reply.code(502).send({
          error: "navigation_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post<{ Params: { wid: string; pid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/wake",
    async (req, reply) => {
      const { wid, pid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      try {
        return await registry.activate(pid);
      } catch (err) {
        if (err instanceof PageError) return fail(reply, err);
        return reply.code(502).send({
          error: "wake_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post<{ Params: { wid: string; pid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/close",
    async (req, reply) => {
      const { wid, pid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      try {
        await registry.close(pid, "user");
        return reply.code(204).send();
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { wid: string; pid: string }; Body: { mode?: unknown } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/control",
    async (req, reply) => {
      const { wid, pid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      const mode = req.body?.mode;
      if (mode !== "user" && mode !== "agent")
        return bad(reply, "bad_mode", 'mode 必须是 "user" 或 "agent"');
      return registry.control(pid, mode);
    },
  );

  // 用户在页面横幅上答复 agent 的接管请求；与聊天里的提问卡片先到先得。
  app.post<{
    Params: { wid: string; pid: string };
    Body: { outcome?: unknown; reason?: unknown };
  }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/handoff",
    async (req, reply) => {
      const { wid, pid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      const { outcome, reason } = req.body ?? {};
      if (outcome !== "done" && outcome !== "refused")
        return bad(reply, "bad_outcome", 'outcome 必须是 "done" 或 "refused"');
      const answered = registry.answerHandoff(
        pid,
        outcome === "done"
          ? { kind: "done" }
          : {
              kind: "refused",
              reason: typeof reason === "string" ? reason.slice(0, 2000) : "",
            },
      );
      if (!answered)
        return reply.code(409).send({
          error: "no_handoff",
          message: "agent 当前没有在等这个页面的接管",
        });
      return reply.code(204).send();
    },
  );

  // 用户在页面上回答挂着的 JS 对话框：与 agent 的 browser_dialog 先到先得。不写审计（同其它界面接管动作）。
  app.post<{
    Params: { wid: string; pid: string };
    Body: { accept?: unknown; text?: unknown };
  }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/dialog",
    async (req, reply) => {
      const { wid, pid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      const accept = req.body?.accept;
      const text = req.body?.text;
      if (typeof accept !== "boolean")
        return bad(
          reply,
          "bad_accept",
          "accept 必须是 true（确定）或 false（取消）",
        );
      if (text !== undefined && typeof text !== "string")
        return bad(reply, "bad_text", "text 必须是字符串");
      if (typeof text === "string" && text.length > DIALOG_TEXT_MAX)
        return bad(
          reply,
          "bad_text",
          `text 最长 ${DIALOG_TEXT_MAX} 字符，现在 ${text.length} 字符`,
        );
      const answered = await opts.registry
        .peek(pid)
        ?.answerDialog(accept, text);
      if (!answered)
        return reply.code(409).send({
          error: "no_dialog",
          message:
            "这个页面现在没有等待回答的对话框（可能已被 agent 回答，或超时自动取消了）",
        });
      return reply.code(204).send();
    },
  );

  // —— 用户页上挂起的下载：保存到本机 / 放进工作区目录 / 丢弃 ——

  // 保存到本机：Server 暂存后把字节流给用户自己的浏览器，由它存盘（Server 与用户可能不在同一台机器）。
  app.get<{ Params: { wid: string; pid: string; did: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/downloads/:did",
    async (req, reply) => {
      const { wid, pid, did } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      let staged: { filename: string; path: string; size: number };
      try {
        staged = await opts.downloads.pending.stage(
          pid,
          did,
          opts.fileMaxBytes(),
        );
      } catch (err) {
        return toHttp(reply, err);
      }
      reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", attachmentDisposition(staged.filename))
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Length", staged.size)
        .header("Cache-Control", "no-store");
      // 整个响应真的发完才算「已保存到本机」；中途断开不结算，暂存留着让用户再点，最终由超时清掉。
      reply.raw.on("close", () => {
        if (reply.raw.writableFinished)
          void opts.downloads.pending.settle(pid, did, "已保存到本机");
      });
      return reply.send(createReadStream(staged.path));
    },
  );

  // 放进目录：写到该 directory 的根下（重名自动加序号），走那个目录的环境（可能是 ssh 远端）。
  app.post<{
    Params: { wid: string; pid: string; did: string };
    Body: { directoryId?: unknown };
  }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/downloads/:did/save",
    async (req, reply) => {
      const { wid, pid, did } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      const directoryId = str(req.body?.directoryId, 200);
      if (!directoryId)
        return bad(reply, "bad_directory", "要指定放进哪个目录");
      const dir = opts.downloads
        .directories(wid)
        .find((d) => d.id === directoryId);
      if (!dir) return bad(reply, "bad_directory", "这个目录不属于当前工作区");
      const env = opts.downloads.envOf(dir);
      if (!env)
        return reply.code(502).send({
          error: "env_unavailable",
          message: "目录所在的环境现在不可用",
        });
      let placed: { name: string; path: string };
      try {
        const staged = await opts.downloads.pending.stage(
          pid,
          did,
          opts.fileMaxBytes(),
        );
        placed = await putIntoDirectory(env, dir, staged);
      } catch (err) {
        // 写入失败不结算：暂存还在，用户可以改选别的名字 / 目录。
        if (err instanceof HttpError) return toHttp(reply, err);
        return reply.code(502).send({
          error: "write_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      await opts.downloads.pending.settle(pid, did, "已放进工作区目录");
      return { name: placed.name, path: placed.path, directory: dir.name };
    },
  );

  app.delete<{ Params: { wid: string; pid: string; did: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/downloads/:did",
    async (req, reply) => {
      const { wid, pid, did } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      const settled = await opts.downloads.pending.settle(pid, did, "用户丢弃");
      if (!settled) return notFound(reply);
      return reply.code(204).send();
    },
  );

  // —— 用户页上挂起的上传：用户选本机文件交给页面 / 取消 ——

  // 收文件：multipart/form-data，字段名 files。原始 body 自己解析，别影响本文件其它路由的 JSON 解析。
  await app.register(async (up) => {
    up.removeAllContentTypeParsers();
    up.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    up.post<{ Params: { wid: string; pid: string; uid: string } }>(
      "/api/v1/workspaces/:wid/browser/pages/:pid/uploads/:uid",
      async (req, reply) => {
        const { wid, pid, uid } = req.params;
        if (!pageIn(wid, pid)) return notFound(reply);
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.startsWith("multipart/form-data"))
          return bad(reply, "bad_form", "上传内容不是有效的表单");
        let files: { name: string; buffer: Buffer }[];
        try {
          files = await readFormFiles(req.body as Readable, contentType);
        } catch (err) {
          // 超限在流上就中止了，不把整个 body 读进内存。
          if (err instanceof TooLarge)
            return reply.code(413).send({
              error: "too_large",
              message: "文件合计超过 50 MB，浏览器一次接收不了",
            });
          return bad(reply, "bad_form", "上传内容不是有效的表单");
        }
        try {
          await opts.uploads.pending.fill(pid, uid, files, opts.fileMaxBytes());
        } catch (err) {
          return toHttp(reply, err);
        }
        return reply.code(204).send();
      },
    );
  });

  app.delete<{ Params: { wid: string; pid: string; uid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/uploads/:uid",
    async (req, reply) => {
      const { wid, pid, uid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      if (!opts.uploads.pending.cancel(pid, uid)) return notFound(reply);
      return reply.code(204).send();
    },
  );

  // —— 登录态：用户在页面里手动登录之后，前端问要不要提示保存 ——

  app.get<{ Params: { wid: string; pid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/login",
    async (req, reply) => {
      const { wid, pid } = req.params;
      const page = pageIn(wid, pid);
      if (!page) return notFound(reply);
      return opts.login.offer(wid, page.url);
    },
  );

  app.post<{ Params: { wid: string; pid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/login",
    async (req, reply) => {
      const { wid, pid } = req.params;
      const page = pageIn(wid, pid);
      if (!page) return notFound(reply);
      try {
        return await opts.login.save(wid, page.url);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // 休眠的页面没有控制台：给空列表，不唤醒。
  app.get<{ Params: { wid: string; pid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/console",
    async (req, reply) => {
      const { wid, pid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      return { entries: registry.peek(pid)?.console() ?? [] };
    },
  );

  app.get<{ Params: { wid: string; pid: string } }>(
    "/api/v1/workspaces/:wid/browser/pages/:pid/thumb",
    async (req, reply) => {
      const { wid, pid } = req.params;
      if (!pageIn(wid, pid)) return notFound(reply);
      const jpeg = registry.thumb(pid);
      if (!jpeg) return notFound(reply);
      return reply
        .header("Cache-Control", "no-store")
        .type("image/jpeg")
        .send(jpeg);
    },
  );

  // —— 端口发现：本工作区见过的端口里此刻真在听的那些，用户点一下就能开页面 ——

  app.get<{ Params: { wid: string } }>(
    "/api/v1/workspaces/:wid/browser/ports",
    async (req, reply) => {
      const { wid } = req.params;
      if (!opts.workspaceExists(wid)) return notFound(reply);
      const listening = await opts.ports.listening(wid);
      const ports = listening
        // target 是用户能直接在地址栏输入的写法（本机用 server 这个别名）。
        .map((e) => ({
          ...e,
          target: `${
            e.envId === LOCAL_ENV_ID ? SERVER_HOST_ID : e.envId
          }:${e.port}`,
        }))
        .sort((a, b) =>
          a.envId === b.envId ? a.port - b.port : a.envId < b.envId ? -1 : 1,
        );
      return { ports };
    },
  );

  // —— 回放：agent 动作之后的画面与说明，只读 ——

  app.get<{ Params: { wid: string } }>(
    "/api/v1/workspaces/:wid/browser/replay",
    async (req, reply) => {
      if (!opts.workspaceExists(req.params.wid)) return notFound(reply);
      return { sessions: opts.replay.sessions(req.params.wid) };
    },
  );

  app.get<{ Params: { wid: string; sid: string } }>(
    "/api/v1/workspaces/:wid/browser/replay/:sid",
    async (req, reply) => {
      const { wid, sid } = req.params;
      if (!opts.workspaceExists(wid)) return notFound(reply);
      const steps = opts.replay.steps(wid, sid);
      // 这个会话在本工作区里没有任何步：与不存在的页面一样当 404，不泄露别的工作区有没有它。
      if (steps.length === 0) return notFound(reply);
      return {
        steps: steps.map((s) => ({
          id: s.id,
          pageId: s.pageId,
          ts: s.ts,
          tool: s.tool,
          summary: s.summary,
          url: s.url,
          title: s.title,
        })),
      };
    },
  );

  app.get<{ Params: { wid: string; sid: string; stepId: string } }>(
    "/api/v1/workspaces/:wid/browser/replay/:sid/frames/:stepId",
    async (req, reply) => {
      const { wid, sid } = req.params;
      if (!opts.workspaceExists(wid)) return notFound(reply);
      const stepId = posInt(req.params.stepId);
      if (stepId === null) return notFound(reply);
      // 先经 replay.frame 在库里确认这一步属于这个工作区与会话，再让读文件；不拼路径直接读。
      const jpeg = opts.replay.frame(wid, sid, stepId);
      if (!jpeg) return notFound(reply);
      return reply
        .header("Cache-Control", "private, max-age=86400")
        .type("image/jpeg")
        .send(jpeg);
    },
  );

  // 引擎没装好或崩过时，界面的「重试」：后台装 / 启动，进度走事件流。
  app.post("/api/v1/browser/engine/ensure", async (_req, reply) => {
    void engine.ensure().catch(() => {});
    return reply.code(202).send({ engine: engine.state() });
  });

  // 工作区级事件流：连上先给整体快照，之后页面增删改与引擎状态变化。只读，客户端发什么都忽略。
  app.get<{ Params: { wid: string } }>(
    "/api/v1/workspaces/:wid/browser/events",
    {
      websocket: true,
      // 升级之前拒绝：不存在的工作区得到普通 404。
      preValidation: async (req, reply) => {
        if (!opts.workspaceExists(req.params.wid)) return notFound(reply);
      },
    },
    (socket, req) => {
      const { wid } = req.params;
      const send = (message: object) => {
        if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
      };
      // 先订阅再发快照：同一个同步段里完成，快照之后的变化一条不丢。
      const offPages = registry.subscribe((event) => {
        const key =
          event.type === "removed"
            ? event.workspaceKey
            : event.page.workspaceKey;
        if (key === wid) send({ type: "page", event });
      });
      const offEngine = engine.subscribe((state) =>
        send({ type: "engine", state }),
      );
      // 展示提示是一次性的：只到此刻连着的界面，不进快照、不重放。
      const offShow = opts.show.subscribe(wid, (show) =>
        send({ type: "show", show }),
      );
      send({ type: "snapshot", ...overview(wid) });

      const stopHeartbeat = startHeartbeat(
        socket,
        pingIntervalMs,
        pongTimeoutMs,
      );
      socket.on("close", () => {
        stopHeartbeat();
        offPages();
        offEngine();
        offShow();
      });
      socket.on("message", (raw: RawData, isBinary: boolean) => {
        if (isPing(raw, isBinary)) send({ type: "pong" });
      });
    },
  );
}
