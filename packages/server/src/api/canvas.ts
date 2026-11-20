// 灵感画布的 HTTP 接口：参数校验与错误映射在这里，业务全在 canvas/repo.ts。
// 路径一律相对 `.canvas/`（`dir` 是目录绝对路径，`:envId` 是主机 id）。
import { once } from "node:events";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseCanvas } from "../canvas/format.js";
import {
  classify,
  insideCanvas,
  isCleanPath,
  isFolderPath,
  notePathOf,
  sanitizeName,
} from "../canvas/layout.js";
import { type LinkService, parseHttpUrl } from "../canvas/link.js";
import {
  CanvasError,
  type CanvasRepo,
  type CanvasService,
} from "../canvas/service.js";
import type { ThumbService } from "../canvas/thumb.js";
import type { EnvHub } from "../env/hub.js";
import type { ExecEnv } from "../env/types.js";
import { isObject } from "../lib/validate.js";
import { pathOf } from "../permission/paths.js";
import { FILE_READ_MAX, parseRange } from "./files.js";
import { intParam, shaParam } from "./lib/file-baseline.js";
import { bad, notFound, toHttp } from "./lib/reply.js";

// 画布里能直接播放的音视频（扩展名 → Content-Type）。图片走缩略图接口，不在这里。
const MEDIA_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
};

export interface AssetLimits {
  /** 粘贴 / 拖入的单个文件的字节上限 */
  uploadMaxBytes: number;
  /** 超过它的资源放进 `_large/`、不进画布的 git 历史 */
  gitMaxBytes: number;
}

export interface CanvasApiDeps {
  canvas: CanvasService;
  hub: EnvHub;
  thumbs: ThumbService;
  /** 网页链接卡片的标题、摘要、封面 */
  links: LinkService;
  /** 每次上传现取（设置里改了下一次就生效）；缺省 500MB / 5MB */
  assetLimits?: () => AssetLimits;
}

export async function canvasApi(
  app: FastifyInstance,
  opts: CanvasApiDeps,
): Promise<void> {
  const { canvas, hub, thumbs, links } = opts;
  const assetLimits =
    opts.assetLimits ??
    (() => ({
      uploadMaxBytes: 500 * 1024 * 1024,
      gitMaxBytes: 5 * 1024 * 1024,
    }));
  const base = "/api/v1/canvas/:envId";
  type Params = { envId: string };
  type Query = {
    dir?: string;
    name?: string;
    path?: string;
    sha?: string;
    limit?: string;
    expect_mtime?: string;
    expect_sha256?: string;
    file?: string;
    v?: string;
    /** 引用别的主机上的文件：那台主机的环境 id；file 此时是那台主机上的绝对路径 */
    host?: string;
  };

  /** 取环境、校验 dir 是已存在的目录、拿到这个目录的仓库。失败时已发出响应，返回 null。 */
  const target = async (
    reply: FastifyReply,
    envId: string,
    dir: unknown,
  ): Promise<{ env: ExecEnv; repo: CanvasRepo; dir: string } | null> => {
    const env = hub.get(envId);
    if (!env) {
      reply.code(404).send({ error: "env_not_found" });
      return null;
    }
    const pm = pathOf(env);
    if (
      typeof dir !== "string" ||
      dir === "" ||
      dir.length > 4096 ||
      dir.includes("\0") ||
      !pm.isAbsolute(dir)
    ) {
      bad(reply, "invalid_path");
      return null;
    }
    // 副本已经是权威（接入时校验过）：不再为每个请求去问远端
    if (!canvas.adopted(envId, dir)) {
      const st = await env.stat(dir).catch(() => null);
      if (!st) {
        reply.code(404).send({ error: "not_found", message: "目录不存在" });
        return null;
      }
      if (!st.isDirectory) {
        bad(reply, "not_a_directory");
        return null;
      }
    }
    try {
      return {
        env: canvas.envFor(envId, dir),
        repo: canvas.repo(envId, dir),
        dir,
      };
    } catch (err) {
      toHttp(reply, err);
      return null;
    }
  };

  const cardPath = (reply: FastifyReply, raw: unknown): string | null => {
    if (typeof raw !== "string" || !insideCanvas(raw)) {
      bad(reply, "invalid_path");
      return null;
    }
    const kind = classify(raw).kind;
    if (kind !== "card" && kind !== "note") {
      bad(
        reply,
        "invalid_path",
        "path 必须是灵感卡（<画布>.cards/<卡片>.md）或笔记（.md）",
      );
      return null;
    }
    return raw;
  };

  /**
   * 画布节点（与笔记）能显示的文件：项目文件引用（`../…`，必须落在项目目录之内）、这块画布自己的资源
   * （`<画布>.assets/…`）、笔记的图片（`<文件夹>/.assets/<笔记名>/…`），或别的主机（或目录之外）上的文件（带 host，file 是绝对路径）。
   * 返回读它用的环境与绝对路径；不合格返回 null，主机取不到返回 "unreachable"。
   */
  const mediaOf = (
    t: { env: ExecEnv; dir: string },
    envId: string,
    file: unknown,
    host: unknown,
  ): { env: ExecEnv; envId: string; abs: string } | "unreachable" | null => {
    if (typeof file !== "string" || file.includes("\0")) return null;
    if (typeof host === "string" && host !== "") {
      const env = hub.get(host);
      if (env === null) return "unreachable";
      return pathOf(env).isAbsolute(file)
        ? { env, envId: host, abs: file }
        : null;
    }
    const pm = pathOf(t.env);
    const abs = pm.resolve(t.dir, ".canvas", file);
    if (file.startsWith("../")) {
      const rel = pm.relative(t.dir, abs);
      return rel === "" || rel === ".." || rel.startsWith(`..${pm.sep}`)
        ? null
        : { env: t.env, envId, abs };
    }
    const kind = classify(file).kind;
    return (kind === "asset" || kind === "noteAsset") && insideCanvas(file)
      ? { env: t.env, envId, abs }
      : null;
  };

  const expectOf = (q: Query) => {
    const mtimeMs = intParam(q.expect_mtime);
    const sha256 = shaParam(q.expect_sha256);
    return mtimeMs === null && sha256 === null
      ? undefined
      : {
          ...(mtimeMs === null ? {} : { mtimeMs }),
          ...(sha256 === null ? {} : { sha256 }),
        };
  };

  // 解析好的请求体：文本按原样，JSON 按对象。
  const bodyText = async (raw: unknown): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const c of raw as AsyncIterable<Buffer>)
      chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };

  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/boards`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      try {
        const st = await t.repo.status();
        const tree = st.ready
          ? await t.repo.listTree()
          : { folders: [], boards: [], notes: [] };
        return { ...st, ...tree };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  // 远端同步的状态（本机环境没有副本，mirror 为 null）
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/mirror`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      return { mirror: canvas.mirrorStatus(req.params.envId, t.dir) };
    },
  );

  app.post<{ Params: Params; Querystring: Query }>(
    `${base}/boards`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const body = isObject(req.body) ? req.body : {};
      if (body.name !== undefined && typeof body.name !== "string")
        return bad(reply, "invalid_name");
      try {
        const name = await t.repo.createBoard(
          typeof body.name === "string" ? body.name : "",
        );
        return reply.code(201).send({ name });
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  // 新建一篇笔记：path 是相对 .canvas/ 的路径（可带子文件夹，缺 .md 补上）；已存在 409
  app.post<{ Params: Params; Querystring: Query }>(
    `${base}/notes`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const body = isObject(req.body) ? req.body : {};
      if (typeof body.path !== "string") return bad(reply, "invalid_name");
      if (body.text !== undefined && typeof body.text !== "string")
        return bad(reply, "bad_request");
      const made = notePathOf(body.path);
      if ("error" in made) return bad(reply, "invalid_name", made.error);
      try {
        await t.repo.createNote(
          made.path,
          typeof body.text === "string" ? body.text : "",
        );
        return reply.code(201).send({ path: made.path });
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/board`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const name = req.query.name;
      if (typeof name !== "string" || !isCleanPath(name))
        return bad(reply, "invalid_name");
      try {
        const read = await t.repo.readBoard(name);
        return {
          name,
          canvas: read.doc,
          baseline: read.baseline,
          files: read.files,
          mediaRev: thumbs.rev(),
        };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  // 请求体里的基线：格式不对当作没带
  const expectBody = (v: unknown) => {
    if (!isObject(v)) return undefined;
    const mtimeMs =
      typeof v.mtimeMs === "number" && Number.isFinite(v.mtimeMs)
        ? Math.round(v.mtimeMs)
        : null;
    const sha256 = shaParam(v.sha256);
    return mtimeMs === null && sha256 === null
      ? undefined
      : {
          ...(mtimeMs === null ? {} : { mtimeMs }),
          ...(sha256 === null ? {} : { sha256 }),
        };
  };

  // 批量保存：界面点「保存」时画布文档、改过的卡片、新卡片一次请求落盘（卡片正文可能不小，放宽请求体上限）
  app.post<{ Params: Params; Querystring: Query }>(
    `${base}/save`,
    { bodyLimit: 32 * 1024 * 1024 },
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const body = isObject(req.body) ? req.body : {};
      const name = body.board;
      if (typeof name !== "string" || !isCleanPath(name))
        return bad(reply, "invalid_name");
      const list = (v: unknown): Record<string, unknown>[] | null =>
        v === undefined ? [] : Array.isArray(v) && v.every(isObject) ? v : null;
      const edits = list(body.edits);
      const created = list(body.created);
      if (
        edits === null ||
        created === null ||
        !edits.every(
          (e) => typeof e.path === "string" && typeof e.text === "string",
        ) ||
        !created.every(
          (c) => typeof c.nodeId === "string" && typeof c.text === "string",
        )
      )
        return bad(reply, "invalid_body");
      let doc: ReturnType<typeof parseCanvas> | undefined;
      if (body.doc !== undefined) {
        if (!isObject(body.doc)) return bad(reply, "invalid_body");
        try {
          doc = parseCanvas(JSON.stringify(body.doc));
        } catch {
          return reply.code(422).send({ error: "format" });
        }
      }
      try {
        const expect = expectBody(body.expect);
        return await t.repo.saveBatch(name, {
          ...(doc ? { doc } : {}),
          ...(expect ? { expect } : {}),
          edits: edits.map((e) => {
            const x = expectBody(e.expect);
            return {
              path: e.path as string,
              text: e.text as string,
              ...(x ? { expect: x } : {}),
            };
          }),
          created: created.map((c) => ({
            nodeId: c.nodeId as string,
            text: c.text as string,
          })),
        });
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  // 两个 PUT 都要收 JSON 与纯文本：只在这个作用域里换掉内容类型解析器。
  await app.register(async (up) => {
    up.removeAllContentTypeParsers();
    up.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    up.put<{ Params: Params; Querystring: Query }>(
      `${base}/board`,
      async (req, reply) => {
        const t = await target(reply, req.params.envId, req.query.dir);
        if (!t) return;
        const name = req.query.name;
        if (typeof name !== "string" || !isCleanPath(name))
          return bad(reply, "invalid_name");
        let doc: ReturnType<typeof parseCanvas>;
        try {
          doc = parseCanvas(await bodyText(req.body));
        } catch {
          return reply.code(422).send({ error: "format" });
        }
        try {
          return {
            baseline: await t.repo.saveBoard(name, doc, expectOf(req.query)),
          };
        } catch (err) {
          return toHttp(reply, err);
        }
      },
    );

    /** 把请求体（原始字节流）写进临时文件 tmp，超过上限就中止；返回字节数 */
    const receiveBody = async (
      env: ExecEnv,
      body: Readable,
      tmp: string,
      limits: AssetLimits,
    ): Promise<number> => {
      let size = 0;
      const count = async function* (chunks: AsyncIterable<Buffer>) {
        for await (const c of chunks) {
          size += c.length;
          if (size > limits.uploadMaxBytes)
            throw new CanvasError("too_large", "文件太大", {
              max: limits.uploadMaxBytes,
            });
          yield c;
        }
      };
      const out = await env.writeStream(tmp);
      await pipeline(body, count, out);
      // sftp 写流在 finish 时句柄可能尚未关闭，等 close 再改名
      if (!out.closed) await once(out, "close");
      return size;
    };

    // 笔记里的图片：存进笔记所在文件夹的 .assets/<笔记名>/，不是画布节点；返回相对 .canvas/ 的路径，由界面写成相对笔记的链接。
    up.put<{
      Params: Params;
      Querystring: Query & { note?: string; name?: string };
    }>(`${base}/note-asset`, async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const { note, name } = req.query;
      if (typeof note !== "string" || !insideCanvas(note))
        return bad(reply, "invalid_path");
      if (
        typeof name !== "string" ||
        name === "" ||
        name.length > 255 ||
        name.includes("\0")
      )
        return bad(reply, "invalid_name");
      const limits = assetLimits();
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limits.uploadMaxBytes)
        return reply.code(413).send({
          error: "too_large",
          size: declared,
          max: limits.uploadMaxBytes,
        });
      let tmp: string | null = null;
      try {
        tmp = (await t.repo.startNoteAsset(note)).tmp;
        const size = await receiveBody(
          t.env,
          req.body as Readable,
          tmp,
          limits,
        );
        const made = await t.repo.finishNoteAsset(note, tmp, {
          name,
          size,
          gitMaxBytes: limits.gitMaxBytes,
        });
        tmp = null;
        return reply.code(201).send({ ...made, size });
      } catch (err) {
        if (tmp !== null) await t.repo.discardAsset(tmp);
        return toHttp(reply, err);
      }
    });

    // 粘贴 / 拖进画布的文件：原始字节流式落到资源文件夹，成功后节点也放进画布文档。
    // 上传不占画布的串行队列（只有开头建文件夹、结尾落位置两小段在队列里）。
    up.put<{
      Params: Params;
      Querystring: Query & {
        board?: string;
        x?: string;
        y?: string;
        w?: string;
        h?: string;
      };
    }>(`${base}/asset`, async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const { board, name } = req.query;
      if (typeof board !== "string" || !isCleanPath(board))
        return bad(reply, "invalid_name");
      if (
        typeof name !== "string" ||
        name === "" ||
        name.length > 255 ||
        name.includes("\0")
      )
        return bad(reply, "invalid_name");
      const num = (v: string | undefined) =>
        v === undefined || v === "" ? null : Number(v);
      const x = num(req.query.x);
      const y = num(req.query.y);
      const w = num(req.query.w);
      const h = num(req.query.h);
      if ([x, y, w, h].some((n) => n !== null && !Number.isFinite(n)))
        return bad(reply, "invalid_position");
      const limits = assetLimits();
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limits.uploadMaxBytes)
        return reply.code(413).send({
          error: "too_large",
          size: declared,
          max: limits.uploadMaxBytes,
        });
      let tmp: string | null = null;
      try {
        tmp = (await t.repo.startAsset(board)).tmp;
        const size = await receiveBody(
          t.env,
          req.body as Readable,
          tmp,
          limits,
        );
        const made = await t.repo.finishAsset(board, tmp, {
          name,
          size,
          gitMaxBytes: limits.gitMaxBytes,
          ...(x !== null && y !== null
            ? { at: { x: Math.round(x), y: Math.round(y) } }
            : {}),
          ...(w !== null && h !== null
            ? { nodeSize: { w: Math.round(w), h: Math.round(h) } }
            : {}),
        });
        tmp = null;
        return reply.code(201).send({ ...made, size });
      } catch (err) {
        if (tmp !== null) await t.repo.discardAsset(tmp);
        return toHttp(reply, err);
      }
    });

    up.put<{ Params: Params; Querystring: Query }>(
      `${base}/card`,
      async (req, reply) => {
        const t = await target(reply, req.params.envId, req.query.dir);
        if (!t) return;
        const path = cardPath(reply, req.query.path);
        if (path === null) return;
        try {
          const baseline = await t.repo.saveCard(
            path,
            await bodyText(req.body),
            expectOf(req.query),
          );
          return { baseline };
        } catch (err) {
          return toHttp(reply, err);
        }
      },
    );
  });

  app.patch<{ Params: Params; Querystring: Query }>(
    `${base}/board`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const name = req.query.name;
      if (typeof name !== "string" || !isCleanPath(name))
        return bad(reply, "invalid_name");
      const body = isObject(req.body) ? req.body : {};
      // to：新的完整画布名（可以换文件夹）；name：只改最后一段
      if (typeof body.to === "string") {
        if (!isCleanPath(body.to)) return bad(reply, "invalid_name");
        try {
          return { name: await t.repo.moveBoard(name, body.to) };
        } catch (err) {
          return toHttp(reply, err);
        }
      }
      if (typeof body.name !== "string" || sanitizeName(body.name) === "")
        return bad(reply, "invalid_name");
      try {
        return { name: await t.repo.renameBoard(name, body.name) };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.delete<{ Params: Params; Querystring: Query }>(
    `${base}/board`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const name = req.query.name;
      if (typeof name !== "string" || !isCleanPath(name))
        return bad(reply, "invalid_name");
      try {
        await t.repo.deleteBoard(name);
        return { ok: true };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  // ---- 笔记、文件夹：树里的新建、改名 / 挪动、删除 ----

  const notePathParam = (reply: FastifyReply, raw: unknown): string | null => {
    if (
      typeof raw !== "string" ||
      !insideCanvas(raw) ||
      classify(raw).kind !== "note"
    ) {
      bad(reply, "invalid_path", "path 必须是笔记（.md）");
      return null;
    }
    return raw;
  };
  const folderParam = (reply: FastifyReply, raw: unknown): string | null => {
    if (typeof raw !== "string" || !isFolderPath(raw)) {
      bad(reply, "invalid_path", "不是合法的文件夹路径");
      return null;
    }
    return raw;
  };

  app.patch<{ Params: Params; Querystring: Query }>(
    `${base}/note`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = notePathParam(reply, req.query.path);
      if (path === null) return;
      const body = isObject(req.body) ? req.body : {};
      if (typeof body.to !== "string") return bad(reply, "invalid_name");
      const made = notePathOf(body.to);
      if ("error" in made) return bad(reply, "invalid_name", made.error);
      try {
        if (made.path !== path) await t.repo.moveNote(path, made.path);
        return { path: made.path };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.delete<{ Params: Params; Querystring: Query }>(
    `${base}/note`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = notePathParam(reply, req.query.path);
      if (path === null) return;
      try {
        await t.repo.deleteNote(path);
        return { ok: true };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.post<{ Params: Params; Querystring: Query }>(
    `${base}/folders`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const body = isObject(req.body) ? req.body : {};
      const path = folderParam(reply, body.path);
      if (path === null) return;
      try {
        await t.repo.createFolder(path);
        return reply.code(201).send({ path });
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.patch<{ Params: Params; Querystring: Query }>(
    `${base}/folder`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = folderParam(reply, req.query.path);
      if (path === null) return;
      const body = isObject(req.body) ? req.body : {};
      const to = folderParam(reply, body.to);
      if (to === null) return;
      try {
        await t.repo.moveFolder(path, to);
        return { path: to };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.delete<{ Params: Params; Querystring: Query }>(
    `${base}/folder`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = folderParam(reply, req.query.path);
      if (path === null) return;
      try {
        await t.repo.deleteFolder(path);
        return { ok: true };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  // 谁引用了这篇笔记 / 这块画布（删除前的确认框用）；画布的路径带 .canvas 后缀
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/refs`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = req.query.path;
      if (typeof path !== "string") return bad(reply, "invalid_path");
      try {
        return await t.repo.referrers(path);
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/card`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = cardPath(reply, req.query.path);
      if (path === null) return;
      try {
        const { text, baseline } = await t.repo.readCard(path);
        return reply
          .header("Content-Type", "text/plain; charset=utf-8")
          .header("X-File-Mtime", String(baseline.mtimeMs))
          .header("X-File-Sha256", baseline.sha256)
          .header("Cache-Control", "no-store")
          .send(text);
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.post<{ Params: Params; Querystring: Query }>(
    `${base}/cards`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const body = isObject(req.body) ? req.body : {};
      if (typeof body.board !== "string" || !isCleanPath(body.board))
        return bad(reply, "invalid_name");
      if (body.name !== undefined && typeof body.name !== "string")
        return bad(reply, "invalid_name");
      if (body.text !== undefined && typeof body.text !== "string")
        return bad(reply, "bad_request");
      if (body.at !== undefined) {
        const at = body.at;
        if (
          !isObject(at) ||
          typeof at.x !== "number" ||
          typeof at.y !== "number"
        )
          return bad(reply, "invalid_position");
      }
      try {
        const made = await t.repo.createCard(body.board, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.text === "string" ? { text: body.text } : {}),
          ...(isObject(body.at)
            ? { at: { x: body.at.x as number, y: body.at.y as number } }
            : {}),
        });
        return reply.code(201).send(made);
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.patch<{ Params: Params; Querystring: Query }>(
    `${base}/card`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = cardPath(reply, req.query.path);
      if (path === null) return;
      const body = isObject(req.body) ? req.body : {};
      if (typeof body.name !== "string" || sanitizeName(body.name) === "")
        return bad(reply, "invalid_name");
      try {
        return { path: await t.repo.renameCard(path, body.name) };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.delete<{ Params: Params; Querystring: Query }>(
    `${base}/card`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = cardPath(reply, req.query.path);
      if (path === null) return;
      try {
        await t.repo.deleteCard(path);
        return { ok: true };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.delete<{ Params: Params; Querystring: Query }>(
    `${base}/asset`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = req.query.path;
      if (
        typeof path !== "string" ||
        !insideCanvas(path) ||
        classify(path).kind !== "asset"
      )
        return bad(reply, "invalid_path");
      try {
        await t.repo.deleteAsset(path);
        return { ok: true };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/image`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      // 项目文件引用与画布自己的资源；卡片是 markdown，走 /card。
      const m = mediaOf(t, req.params.envId, req.query.file, req.query.host);
      if (m === null) return bad(reply, "invalid_path");
      if (m === "unreachable")
        return reply.code(503).send({ error: "host_unreachable" });
      try {
        const r = await thumbs.get(m.env, m.envId, m.abs);
        reply
          .header("Content-Type", r.mime)
          .header("ETag", `"${r.etag}"`)
          .header("X-Canvas-Image", r.kind)
          .header(
            "Cache-Control",
            req.query.v === undefined
              ? "no-cache"
              : "private, max-age=31536000, immutable",
          );
        // svg 能跑脚本：与文件接口一致地落到不透明源。
        if (r.mime === "image/svg+xml")
          reply
            .header("Content-Security-Policy", "sandbox")
            .header("X-Content-Type-Options", "nosniff");
        return reply.send(r.data);
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  // 网页链接卡片的信息：Server 去抓页面开头一段（不带 cookie）；抓不到也是 200，failed 为 true，界面退回只显示地址
  app.get<{ Params: Params; Querystring: { url?: string } }>(
    `${base}/link`,
    async (req, reply) => {
      const raw = req.query.url;
      const u =
        typeof raw === "string" && raw.length <= 2048
          ? parseHttpUrl(raw)
          : null;
      if (!u) return bad(reply, "invalid_url");
      const meta = await links.get(u.href);
      return reply
        .header(
          "Cache-Control",
          meta.failed ? "no-store" : "private, max-age=3600",
        )
        .send(meta);
    },
  );

  // 音视频：带 Range 的流式读（本机与 SSH 主机一样），浏览器边下边播、能拖进度条；
  // 每次响应最多 FILE_READ_MAX，更长的区间浏览器会接着再要。
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/media`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const m = mediaOf(t, req.params.envId, req.query.file, req.query.host);
      if (m === null) return bad(reply, "invalid_path");
      if (m === "unreachable")
        return reply.code(503).send({ error: "host_unreachable" });
      const { abs } = m;
      const name = pathOf(m.env).basename(abs).toLowerCase();
      const type = MEDIA_TYPES[name.slice(name.lastIndexOf(".") + 1)];
      if (type === undefined)
        return reply.code(415).send({ error: "unsupported" });
      try {
        const st = await m.env.stat(abs).catch(() => null);
        if (st?.isFile !== true) return notFound(reply);
        const range = parseRange(req.headers.range, st.size);
        if (range === "unsatisfiable")
          return reply
            .code(416)
            .header("Content-Range", `bytes */${st.size}`)
            .send({ error: "range_not_satisfiable" });
        reply
          .header("Content-Type", type)
          .header("Accept-Ranges", "bytes")
          .header("X-Content-Type-Options", "nosniff")
          .header(
            "Cache-Control",
            req.query.v === undefined
              ? "no-cache"
              : "private, max-age=31536000, immutable",
          );
        if (st.size === 0) return reply.header("Content-Length", 0).send("");
        const part = range
          ? {
              start: range.start,
              end: Math.min(range.end, range.start + FILE_READ_MAX - 1),
            }
          : null;
        if (part)
          reply
            .code(206)
            .header(
              "Content-Range",
              `bytes ${part.start}-${part.end}/${st.size}`,
            )
            .header("Content-Length", part.end - part.start + 1);
        else reply.header("Content-Length", st.size);
        return reply.send(await m.env.readStream(abs, part ?? undefined));
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/history`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = req.query.path;
      if (
        path !== undefined &&
        (typeof path !== "string" || !insideCanvas(path))
      )
        return bad(reply, "invalid_path");
      const limit = intParam(req.query.limit);
      try {
        const commits = await t.repo.history(
          typeof path === "string" ? path : undefined,
          limit ?? undefined,
        );
        return { commits };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/history/version`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const path = req.query.path;
      const sha = req.query.sha;
      if (typeof path !== "string" || !insideCanvas(path))
        return bad(reply, "invalid_path");
      if (typeof sha !== "string") return bad(reply, "invalid_sha");
      try {
        const text = await t.repo.version(sha, path);
        return reply
          .header("Content-Type", "text/plain; charset=utf-8")
          .header("Cache-Control", "no-store")
          .send(text);
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.post<{ Params: Params; Querystring: Query }>(
    `${base}/restore`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      const body = isObject(req.body) ? req.body : {};
      if (typeof body.path !== "string" || !insideCanvas(body.path))
        return bad(reply, "invalid_path");
      if (typeof body.sha !== "string") return bad(reply, "invalid_sha");
      try {
        return { sha: await t.repo.restore(body.path, body.sha) };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );

  app.post<{ Params: Params; Querystring: Query }>(
    `${base}/undo`,
    async (req, reply) => {
      const t = await target(reply, req.params.envId, req.query.dir);
      if (!t) return;
      try {
        const r = await t.repo.undoLastAgent();
        if (!r.ok)
          return toHttp(reply, new CanvasError("undo_failed", r.reason));
        return { sha: r.sha };
      } catch (err) {
        return toHttp(reply, err);
      }
    },
  );
}
