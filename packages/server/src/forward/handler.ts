// 服务转发的出口：一个独立监听端口，把 HTTP 与 WebSocket 经环境的 openTcp 转给环境里 localhost:<port> 上的服务。
// 出口与 Server 同主机，浏览器会把会话 Cookie 带过来，所以没令牌一律拦下，转给上游前再把它摘掉。
import type http from "node:http";
import httpMod from "node:http";
import type { Duplex } from "node:stream";
import type { ExecEnv } from "../env/types.js";
import { TunnelAgent } from "../lib/tunnel-http.js";
import { downstreamHeaders, upstreamHeaders } from "./rewrite.js";

export interface ForwardTarget {
  envId: string;
  port: number;
}

export interface ForwardHandlerDeps {
  env(envId: string): ExecEnv | null;
  /** 请求是否带了有效的会话令牌；Server 没配令牌时恒为 true（由接线处决定）。 */
  authorize(headers: http.IncomingHttpHeaders): boolean;
}

export interface ForwardHandler {
  request(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: ForwardTarget,
  ): void;
  upgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: ForwardTarget,
  ): void;
}

const UNAUTHORIZED_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>需要登录</title></head>
<body style="font:16px/1.6 system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem">
<h1 style="font-size:1.25rem">需要登录</h1>
<p>请先在 Server 的页面里登录，再刷新这里。</p>
</body></html>`;

function plain(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(UNAUTHORIZED_HTML)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(UNAUTHORIZED_HTML);
}

/** 升级请求原样写给上游：请求行 + 改写后的头 + 空行，再补上客户端已经读到的字节。 */
function writeUpgrade(
  remote: Duplex,
  req: http.IncomingMessage,
  target: ForwardTarget,
  head: Buffer,
): void {
  const headers = upstreamHeaders(req.headers, target.port, { upgrade: true });
  // 升级头必须留着：去逐跳头时被摘掉了，这里补回原值
  if (req.headers.upgrade !== undefined) headers.upgrade = req.headers.upgrade;
  headers.connection = "Upgrade";
  const lines = [
    `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`,
    ...Object.entries(headers).flatMap(([name, value]) =>
      Array.isArray(value)
        ? value.map((v) => `${name}: ${v}`)
        : value === undefined
          ? []
          : [`${name}: ${String(value)}`],
    ),
    "",
    "",
  ];
  remote.write(lines.join("\r\n"));
  if (head.length > 0) remote.write(head);
}

export function createForwardHandler(deps: ForwardHandlerDeps): ForwardHandler {
  /** 环境与上游通道都就绪才能转；对象套对象让两种失败分得开（都回 502，说法不同）。 */
  function upstream(
    target: ForwardTarget,
  ): { openTcp: (port: number) => Promise<Duplex> } | string {
    const env = deps.env(target.envId);
    if (env === null || env.openTcp === undefined)
      return "这个环境现在连不上，或不支持转发";
    const openTcp = env.openTcp.bind(env);
    return { openTcp };
  }

  function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: ForwardTarget,
  ) {
    if (!deps.authorize(req.headers)) {
      unauthorized(res);
      return;
    }
    const up = upstream(target);
    if (typeof up === "string") {
      plain(res, 502, up);
      return;
    }

    const out = httpMod.request(
      {
        method: req.method,
        path: req.url ?? "/",
        headers: upstreamHeaders(req.headers, target.port),
        // 连接由环境的 openTcp 提供：不能 agent:false，那会让请求退化成按 host 直连
        agent: new TunnelAgent(() => up.openTcp(target.port)),
      },
      (r) => {
        res.writeHead(
          r.statusCode ?? 502,
          r.statusMessage,
          downstreamHeaders(r.headers, target.port, req.headers.host ?? ""),
        );
        r.pipe(res);
        r.on("error", () => res.destroy());
      },
    );
    out.on("error", (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      plain(res, 502, `连接上游失败：${err.code ?? err.message}`);
    });
    req.pipe(out);
    // 客户端中途断开就中止上游；正常写完的 close 不动它
    req.on("aborted", () => out.destroy());
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
    });
  }

  function handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: ForwardTarget,
  ) {
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\n\r\n`);
      socket.end();
    };
    if (!deps.authorize(req.headers)) {
      refuse("401 Unauthorized");
      return;
    }
    const up = upstream(target);
    if (typeof up === "string") {
      refuse("502 Bad Gateway");
      return;
    }

    up.openTcp(target.port).then(
      (remote) => {
        writeUpgrade(remote, req, target, head);
        remote.pipe(socket);
        socket.pipe(remote);
        // 出错就两侧一起拆；正常关闭则让对方 end 掉（销毁会丢掉还没写出去的字节）
        const teardown = () => {
          remote.destroy();
          socket.destroy();
        };
        const finish = (other: Duplex) => () => {
          if (!other.destroyed) other.end();
        };
        remote.on("error", teardown);
        socket.on("error", teardown);
        remote.on("close", finish(socket));
        socket.on("close", finish(remote));
      },
      () => refuse("502 Bad Gateway"),
    );
  }

  return {
    request: handleRequest,
    upgrade: handleUpgrade,
  };
}
