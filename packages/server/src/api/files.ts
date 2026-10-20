// 文件管理接口：对任意已登记环境，经 ExecEnv 原语读写。调用者是用户本人，不受 agent 权限档位约束；写类操作记审计。
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { EnvHub } from "../env/hub.js";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";
import { type AuditLog, auditSession } from "../store/audit.js";

/** 无 Range、非下载的整体响应上限；Range 响应的单次长度同样以它封顶。 */
export const FILE_READ_MAX = 64 * 1024 * 1024;
/** 文本预览（无 Range、非下载）最多返回的字节数；超出则截断并带 X-Truncated。 */
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;
export const LIST_MAX = 10000;
const STAT_BATCH = 32;

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
// 脚本类与 xml 一律按纯文本给出：浏览器不会执行，也不会当文档解析。
const TYPES: Record<string, string> = {
  html: HTML,
  htm: HTML,
  svg: "image/svg+xml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};
const TEXT_EXT = new Set(
  "txt log xml xhtml yaml yml toml ini conf cfg env js mjs cjs ts tsx jsx py rs go java c h cpp hpp cs rb php lua sh bash zsh fish sql diff patch gitignore lock".split(
    " ",
  ),
);
const TEXT_NAMES = new Set(["makefile", "dockerfile", "readme", "license"]);
// html 与 svg 直接打开时能跑脚本；sandbox 让它们落在不透明源且不允许脚本。pdf 不能加，Chrome 内置查看器会失效。
const SANDBOXED = new Set([HTML, "image/svg+xml"]);

function contentType(name: string, asText: boolean): string {
  if (asText) return TEXT;
  const lower = name.toLowerCase();
  const ext = lower.includes(".")
    ? lower.slice(lower.lastIndexOf(".") + 1)
    : "";
  return (
    TYPES[ext] ??
    (TEXT_EXT.has(ext) || TEXT_NAMES.has(lower)
      ? TEXT
      : "application/octet-stream")
  );
}

// 截断可能劈开末尾的多字节字符，回退到完整字符的边界。
function utf8End(b: Buffer): number {
  let i = b.length - 1;
  for (let n = 0; n < 3 && i > 0 && ((b[i] as number) & 0xc0) === 0x80; n++)
    i--;
  const lead = b[i] as number;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return b.length - i >= need ? b.length : i;
}

/** 只认单段 bytes 区间；多段或不认识的写法按没有 Range 处理（规范允许）。 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || size === 0 || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0
      ? "unsatisfiable"
      : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// 本机的 fs 错误与 sftp 错误（数字 code 或英文消息）归到同一组状态码。
function ioError(reply: FastifyReply, err: unknown) {
  const e = err as { code?: unknown; message?: string };
  const msg = e.message ?? String(err);
  const c = e.code;
  const send = (status: number, error: string) =>
    reply.code(status).send({ error, message: msg });
  if (c === "ENOENT" || c === 2 || /no such file/i.test(msg))
    return send(404, "not_found");
  if (
    c === "EACCES" ||
    c === "EPERM" ||
    c === 3 ||
    /permission denied/i.test(msg)
  )
    return send(403, "permission_denied");
  if (c === "ENOTEMPTY" || c === "EEXIST" || c === "ENOTDIR" || c === "EISDIR")
    return send(409, "conflict");
  return send(500, "io_error");
}

export async function filesApi(
  app: FastifyInstance,
  opts: { hub: EnvHub; audit?: AuditLog },
): Promise<void> {
  const { hub, audit } = opts;
  const base = "/api/v1/environments/:envId/files";
  type Params = { envId: string };

  const bad = (reply: FastifyReply, error = "bad_request", status = 400) =>
    reply.code(status).send({ error });

  // 取环境并规范化路径；失败时已发出响应，返回 null。
  const resolve = (
    reply: FastifyReply,
    envId: string,
    raw: unknown,
  ): { env: ExecEnv; pm: ReturnType<typeof pathOf>; p: string } | null => {
    const env = hub.get(envId);
    if (!env) {
      bad(reply, "env_not_found", 404);
      return null;
    }
    const pm = pathOf(env);
    if (
      typeof raw !== "string" ||
      raw.length > 4096 ||
      raw.includes("\0") ||
      !pm.isAbsolute(raw)
    ) {
      bad(reply, "invalid_path");
      return null;
    }
    return { env, pm, p: pm.resolve(raw) };
  };

  // 写类操作的审计：成功与 IO 失败都记，带耗时；sessionId 由调用方带上，用来归到会话时间线。
  async function track<T>(
    env: ExecEnv,
    op: string,
    target: string,
    sessionId: string | null,
    run: () => Promise<T>,
    base: Record<string, unknown> = {},
  ): Promise<T> {
    const t0 = Date.now();
    const rec = (result: "ok" | "error", extra: Record<string, unknown>) =>
      audit?.record({
        sessionId,
        actor: "user",
        kind: "file",
        environmentId: env.id,
        summary: `${op} ${target}`,
        detail: {
          op,
          target,
          result,
          durationMs: Date.now() - t0,
          ...base,
          ...extra,
        },
      });
    try {
      const v = await run();
      rec("ok", isObject(v) ? v : {});
      return v;
    } catch (err) {
      rec("error", { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  // 目录项与 stat 共用的描述：链接按目标定型，悬空链接记为 other 并带 broken。
  async function describe(env: ExecEnv, full: string, name: string) {
    const l = await env.lstat(full);
    if (!l) return null;
    let st = l;
    let symlink: string | undefined;
    let broken = false;
    if (l.isSymlink) {
      symlink = (await env.readlink(full)) ?? "";
      const t = await env.stat(full);
      if (t) st = t;
      else broken = true;
    }
    return {
      name,
      type: broken
        ? "other"
        : st.isDirectory
          ? "dir"
          : st.isFile
            ? "file"
            : "other",
      size: broken ? 0 : st.size,
      mtimeMs: st.mtimeMs,
      ...(symlink === undefined ? {} : { symlink }),
      ...(broken ? { broken: true } : {}),
    };
  }

  app.get<{ Params: Params; Querystring: { path?: string; hidden?: string } }>(
    `${base}/list`,
    async (req, reply) => {
      const r = resolve(reply, req.params.envId, req.query.path);
      if (!r) return;
      try {
        const st = await r.env.stat(r.p);
        if (!st) return bad(reply, "not_found", 404);
        if (!st.isDirectory) return bad(reply, "not_a_directory");
        const showHidden = req.query.hidden === "1";
        const names = (await r.env.readdir(r.p))
          .map((e) => e.name)
          .filter((n) => showHidden || !n.startsWith("."))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const truncated = names.length > LIST_MAX;
        const entries: NonNullable<Awaited<ReturnType<typeof describe>>>[] = [];
        for (let i = 0; i < Math.min(names.length, LIST_MAX); i += STAT_BATCH) {
          const batch = await Promise.all(
            names
              .slice(i, Math.min(i + STAT_BATCH, LIST_MAX))
              .map((n) => describe(r.env, r.pm.join(r.p, n), n)),
          );
          for (const e of batch) if (e) entries.push(e);
        }
        // 目录在前，同类按名字
        entries.sort(
          (a, b) => Number(b.type === "dir") - Number(a.type === "dir"),
        );
        const parent = r.pm.dirname(r.p);
        return {
          path: r.p,
          parent: parent === r.p ? null : parent,
          entries,
          truncated,
        };
      } catch (err) {
        return ioError(reply, err);
      }
    },
  );

  app.get<{ Params: Params; Querystring: { path?: string } }>(
    `${base}/stat`,
    async (req, reply) => {
      const r = resolve(reply, req.params.envId, req.query.path);
      if (!r) return;
      try {
        const d = await describe(r.env, r.p, r.pm.basename(r.p) || r.p);
        return d ? { path: r.p, ...d } : bad(reply, "not_found", 404);
      } catch (err) {
        return ioError(reply, err);
      }
    },
  );

  // 读取：文本与二进制同一条路径，按扩展名定 Content-Type；download=1 强制附件，as=text 强制纯文本。
  app.get<{
    Params: Params;
    Querystring: { path?: string; download?: string; as?: string };
  }>(`${base}/content`, async (req, reply) => {
    const r = resolve(reply, req.params.envId, req.query.path);
    if (!r) return;
    try {
      const st = await r.env.stat(r.p);
      if (!st) return bad(reply, "not_found", 404);
      if (!st.isFile) return bad(reply, "not_a_file");
      const download = req.query.download === "1";
      const name = r.pm.basename(r.p);
      const type = download
        ? "application/octet-stream"
        : contentType(name, req.query.as === "text");
      const isText =
        type.startsWith("text/") || type.startsWith("application/json");
      const range = parseRange(req.headers.range, st.size);
      if (range === "unsatisfiable")
        return reply
          .code(416)
          .header("Content-Range", `bytes */${st.size}`)
          .send({ error: "range_not_satisfiable" });
      const preview =
        !download && !range && isText && st.size > TEXT_PREVIEW_MAX;
      if (!download && !range && !preview && st.size > FILE_READ_MAX)
        return reply
          .code(413)
          .send({ error: "too_large", size: st.size, max: FILE_READ_MAX });
      const part = range
        ? {
            start: range.start,
            end: download
              ? range.end
              : Math.min(range.end, range.start + FILE_READ_MAX - 1),
          }
        : null;
      reply
        .header("Content-Type", type)
        .header("Accept-Ranges", "bytes")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
      if (SANDBOXED.has(type))
        reply.header("Content-Security-Policy", "sandbox");
      if (download)
        reply.header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
      if (st.size === 0) return reply.header("Content-Length", 0).send("");
      if (preview) {
        const stream = await r.env.readStream(r.p, {
          start: 0,
          end: TEXT_PREVIEW_MAX - 1,
        });
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        const head = Buffer.concat(chunks);
        const body = head.subarray(0, utf8End(head));
        return reply
          .header("X-Truncated", "1")
          .header("X-File-Size", st.size)
          .header("Content-Length", body.length)
          .send(body);
      }
      if (part)
        reply
          .code(206)
          .header("Content-Range", `bytes ${part.start}-${part.end}/${st.size}`)
          .header("Content-Length", part.end - part.start + 1);
      else reply.header("Content-Length", st.size);
      return reply.send(await r.env.readStream(r.p, part ?? undefined));
    } catch (err) {
      return ioError(reply, err);
    }
  });

  // 写入：原始 body 流式落到同目录临时名，写完再 rename 到位；中途失败或客户端断开不留残文件。
  await app.register(async (up) => {
    up.removeAllContentTypeParsers();
    up.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    up.put<{
      Params: Params;
      Querystring: { path?: string; overwrite?: string; sessionId?: string };
    }>(`${base}/content`, async (req, reply) => {
      const r = resolve(reply, req.params.envId, req.query.path);
      if (!r) return;
      const parent = r.pm.dirname(r.p);
      if (parent === r.p) return bad(reply, "invalid_path");
      const tmp = r.pm.join(
        parent,
        `.${r.pm.basename(r.p)}.${randomBytes(4).toString("hex")}.part`,
      );
      let wrote = false;
      try {
        const dir = await r.env.stat(parent);
        if (!dir) return bad(reply, "parent_missing", 404);
        if (!dir.isDirectory) return bad(reply, "invalid_path");
        const existing = await r.env.lstat(r.p);
        if (existing?.isDirectory) return bad(reply, "is_directory", 409);
        if (existing && req.query.overwrite !== "1")
          return bad(reply, "exists", 409);
        const res = await track(
          r.env,
          "write",
          r.p,
          auditSession(req.query.sessionId),
          async () => {
            let size = 0;
            const count = async function* (chunks: AsyncIterable<Buffer>) {
              for await (const c of chunks) {
                size += c.length;
                yield c;
              }
            };
            const out = await r.env.writeStream(tmp);
            wrote = true;
            await pipeline(req.body as Readable, count, out);
            // sftp 写流在 finish 时句柄可能尚未关闭，等 close 再改名
            if (!out.closed) await once(out, "close");
            await r.env.rename(tmp, r.p);
            wrote = false;
            return { size, created: !existing };
          },
        );
        return { path: r.p, ...res };
      } catch (err) {
        return ioError(reply, err);
      } finally {
        if (wrote) await r.env.remove(tmp).catch(() => {});
      }
    });
  });

  app.post<{ Params: Params }>(`${base}/mkdir`, async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const r = resolve(reply, req.params.envId, body.path);
    if (!r) return;
    try {
      if (await r.env.lstat(r.p)) return bad(reply, "exists", 409);
      await track(r.env, "mkdir", r.p, auditSession(body.sessionId), () =>
        r.env.mkdirp(r.p),
      );
      return reply.code(201).send({ path: r.p });
    } catch (err) {
      return ioError(reply, err);
    }
  });

  app.post<{ Params: Params }>(`${base}/rename`, async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const from = resolve(reply, req.params.envId, body.from);
    if (!from) return;
    const to = resolve(reply, req.params.envId, body.to);
    if (!to) return;
    try {
      if (!(await from.env.lstat(from.p))) return bad(reply, "not_found", 404);
      const target = await to.env.lstat(to.p);
      // 目录永不覆盖（不做合并）；文件仅在显式 overwrite 时替换
      if (target && (target.isDirectory || body.overwrite !== true))
        return bad(reply, "exists", 409);
      await track(
        from.env,
        "rename",
        from.p,
        auditSession(body.sessionId),
        () => from.env.rename(from.p, to.p),
        { to: to.p },
      );
      return { from: from.p, to: to.p };
    } catch (err) {
      return ioError(reply, err);
    }
  });

  app.delete<{
    Params: Params;
    Querystring: { path?: string; recursive?: string; sessionId?: string };
  }>(`${base}/entry`, async (req, reply) => {
    const r = resolve(reply, req.params.envId, req.query.path);
    if (!r) return;
    if (r.pm.dirname(r.p) === r.p) return bad(reply, "invalid_path");
    try {
      const st = await r.env.lstat(r.p);
      if (!st) return bad(reply, "not_found", 404);
      const recursive = req.query.recursive === "1";
      if (st.isDirectory && !recursive) return bad(reply, "recursive_required");
      await track(
        r.env,
        "delete",
        r.p,
        auditSession(req.query.sessionId),
        () => r.env.remove(r.p, recursive),
        { dir: st.isDirectory, recursive },
      );
      return reply.code(204).send();
    } catch (err) {
      return ioError(reply, err);
    }
  });
}
