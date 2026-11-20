// `<环境>.files.localhost` 的静态文件服务：经 ExecEnv 读文件，本机与远端通用，不在目标机起进程。
// 能看哪些文件由调用方注入的 allow 决定，这里只管取文件、给类型、流式写回。
import type http from "node:http";
import path from "node:path";
import { contentType } from "mime-types";
import type { ExecEnv } from "../../env/types.js";
import type { DenyCode } from "./proxy.js";

const posix = path.posix;

/** 拒绝码响应头：代理与静态文件服务共用，引擎读它给 agent 明确的失败原因。 */
export const DENY_HEADER = "X-Yuanshu-Deny";

export interface ServeFileArgs {
  env: ExecEnv;
  /** URL 里的绝对路径（已解码） */
  path: string;
  method: string;
  /** 真实路径（已跟随符号链接）→ 是否允许读 */
  allow(realPath: string): boolean | Promise<boolean>;
}

const text = (
  res: http.ServerResponse,
  status: number,
  body: string,
  deny?: DenyCode,
) => {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(deny === undefined ? {} : { [DENY_HEADER]: deny }),
  });
  res.end(body);
};

/**
 * 处理一次文件请求，自己写完响应。返回拒绝码（调用方据此审计），正常响应或 404 返回 null。
 */
export async function serveFile(
  args: ServeFileArgs,
  res: http.ServerResponse,
): Promise<DenyCode | null> {
  const { env, method } = args;
  // 路径穿越在这里先收口：`..` 归一化后再交给 realpath
  let target = posix.normalize(args.path);
  if (!target.startsWith("/")) {
    text(res, 404, "文件不存在（只接受绝对路径）");
    return null;
  }

  if (env.os === "windows") {
    text(res, 403, "Windows 主机暂不支持浏览文件", "unsupported");
    return "unsupported";
  }

  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    text(res, 405, "文件只支持 GET 与 HEAD", "unsupported");
    return "unsupported";
  }

  const notFound = () => {
    text(res, 404, "文件不存在");
    return null;
  };

  let real = await env.realpath(target);
  if (real === null) return notFound();

  const stat = await env.stat(real);
  if (stat === null) return notFound();

  if (stat.isDirectory) {
    // 目录默认页；没有 index.html 就当不存在（不列目录）
    target = posix.join(real, "index.html");
    real = await env.realpath(target);
    if (real === null) return notFound();
    const index = await env.stat(real);
    if (index === null || !index.isFile) return notFound();
    return send(args, res, real, index.size);
  }

  if (!stat.isFile) {
    text(res, 404, "不是普通文件");
    return null;
  }
  return send(args, res, real, stat.size);
}

async function send(
  { env, method, allow }: ServeFileArgs,
  res: http.ServerResponse,
  real: string,
  size: number,
): Promise<DenyCode | null> {
  if (!(await allow(real))) {
    text(res, 403, "无权读取该文件", "file_denied");
    return "file_denied";
  }

  res.writeHead(200, {
    // contentType 见到 `/` 会当成 MIME 类型原样返回，所以先取扩展名
    "Content-Type":
      contentType(posix.extname(real)) || "application/octet-stream",
    "Content-Length": String(size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  if (method === "HEAD") {
    res.end();
    return null;
  }

  const stream = await env.readStream(real).catch(() => null);
  if (stream === null) {
    // 头已经发出去了，只能中断
    res.destroy();
    return null;
  }
  stream.pipe(res);
  // 读流出错时响应已无法纠正，销毁它让客户端知道失败
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  return null;
}
