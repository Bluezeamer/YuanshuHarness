// 会话附件接口：上传把原始 body 流式写进该会话隐藏的 attachment directory；读取校验路径必须在会话内。
// 鉴权由 /api/v1 作用域统一处理（与文件接口同一套）。
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { isInside } from "../permission/paths.js";
import {
  type AttachmentDirectories,
  mimeOfFile,
  readHead,
  resolveAttachmentPath,
} from "../session/attachments.js";
import type { SessionPool } from "../session/pool.js";
import { attachmentDisposition } from "./lib/download.js";

// 原始文件名上限：只用于展示，落盘名另行规范化。
const UPLOAD_NAME_MAX = 1024;
// 能直接在浏览器里跑脚本的类型：加 CSP sandbox，落在不透明源且不允许脚本。
const SANDBOXED = new Set(["text/html", "image/svg+xml"]);

export async function attachmentsApi(
  app: FastifyInstance,
  opts: { pool: SessionPool | null; attachments: AttachmentDirectories },
): Promise<void> {
  const { pool, attachments } = opts;
  const base = "/api/v1/sessions/:id/attachments";
  const env = attachments.env;

  // 会话必须存在；接口仍按会话 id 走，文件落在会话所属工作区的那一块（子会话与父看到同一块）。
  const sessionExists = (id: string): boolean => Boolean(pool?.info(id));

  // 原始 body 流式落盘：先写同目录临时名，成功再 rename；失败不留残文件。
  await app.register(async (up) => {
    up.removeAllContentTypeParsers();
    up.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    up.post<{ Params: { id: string }; Querystring: { name?: string } }>(
      base,
      async (req, reply) => {
        const sessionId = req.params.id;
        if (!sessionExists(sessionId))
          return reply.code(404).send({ error: "not_found" });
        const rawName = req.query.name;
        if (
          typeof rawName !== "string" ||
          rawName.trim() === "" ||
          rawName.length > UPLOAD_NAME_MAX
        )
          return reply.code(400).send({ error: "invalid_name" });
        const { relative, abs, safe } = await attachments.reserve(
          sessionId,
          rawName,
        );
        const tmp = `${abs}.${randomBytes(4).toString("hex")}.part`;
        // 文件头用于按魔数识别图片；其余内容不留在内存。
        let size = 0;
        const head: Buffer[] = [];
        let headLen = 0;
        const count = async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            const b = chunk as Buffer;
            size += b.length;
            if (headLen < 16) {
              const take = Math.min(16 - headLen, b.length);
              head.push(b.subarray(0, take));
              headLen += take;
            }
            yield b;
          }
        };
        let wrote = false;
        try {
          const out = await env.writeStream(tmp, { mode: 0o600 });
          wrote = true;
          await pipeline(req.body as Readable, count, out);
          // 流在 finish 时句柄可能尚未关闭，等 close 再改名
          if (!out.closed) await once(out, "close");
          await env.rename(tmp, abs);
          wrote = false;
          const mime = mimeOfFile(Buffer.concat(head), safe);
          return reply
            .code(201)
            .send({ name: rawName, mime, size, path: relative });
        } catch (err) {
          app.log.error({ err }, "附件上传失败");
          return reply.code(500).send({ error: "io_error" });
        } finally {
          if (wrote) await env.remove(tmp).catch(() => {});
        }
      },
    );
  });

  app.get<{
    Params: { id: string };
    Querystring: { path?: string; download?: string };
  }>(`${base}/content`, async (req, reply) => {
    const sessionId = req.params.id;
    if (!sessionExists(sessionId))
      return reply.code(404).send({ error: "not_found" });
    const ws = attachments.get(sessionId);
    const abs = ws ? resolveAttachmentPath(ws.path, req.query.path) : null;
    if (!ws || !abs) return reply.code(400).send({ error: "invalid_path" });
    try {
      const wsReal = (await env.realpath(ws.path)) ?? ws.path;
      const real = await env.realpath(abs);
      if (!real) {
        // 路径解析不了（不存在、悬空链接等）：存在就按越界拒绝，否则如实 404。
        return (await env.stat(abs))
          ? reply.code(400).send({ error: "invalid_path" })
          : reply.code(404).send({ error: "not_found" });
      }
      // 二次校验：符号链接解析后仍必须在会话目录内。
      if (!isInside(wsReal, real))
        return reply.code(400).send({ error: "invalid_path" });
      const st = await env.stat(real);
      if (!st) return reply.code(404).send({ error: "not_found" });
      if (!st.isFile) return reply.code(400).send({ error: "not_a_file" });
      const mime = mimeOfFile(
        await readHead(env, real, st.size),
        path.basename(real),
      );
      reply
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
      if (SANDBOXED.has(mime))
        reply.header("Content-Security-Policy", "sandbox");
      if (req.query.download === "1")
        reply.header(
          "Content-Disposition",
          attachmentDisposition(path.basename(real)),
        );
      if (st.size === 0) return reply.header("Content-Length", 0).send("");
      return reply
        .header("Content-Length", st.size)
        .send(await env.readStream(real));
    } catch (err) {
      app.log.error({ err }, "附件读取失败");
      return reply.code(500).send({ error: "io_error" });
    }
  });
}
