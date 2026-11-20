// 经环境通道转发 HTTP / WebSocket 的共用件：逐跳头、出站头过滤，以及「每条请求一条环境连接」的 agent。
// 浏览器代理（browser/net/proxy.ts）与服务转发（forward/）都用这一份，别各写一套。
import type http from "node:http";
import httpMod from "node:http";
import type { Duplex } from "node:stream";

// 逐跳头不进上游也不回客户端；`Connection` 里点名的也要一并去掉。
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function outboundHeaders(
  raw: http.IncomingHttpHeaders,
  host?: string,
  options?: { upgrade?: boolean },
): http.OutgoingHttpHeaders {
  const drop = new Set(HOP_BY_HOP);
  const conn = raw.connection;
  if (typeof conn === "string")
    for (const name of conn.split(",")) drop.add(name.trim().toLowerCase());
  // 升级请求要自己写给上游，`Connection` 与 `Upgrade` 是协议的一部分，得留着
  if (options?.upgrade) {
    drop.delete("upgrade");
    drop.delete("connection");
  }
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || drop.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  if (host !== undefined) out.host = host;
  return out;
}

// 每条请求一条新连接，连接由环境的 openTcp 提供：不复用，也不让 http 模块自己拨号。
export class TunnelAgent extends httpMod.Agent {
  constructor(private readonly open: () => Promise<Duplex>) {
    super({ keepAlive: false });
  }

  override createConnection(
    _options: http.RequestOptions,
    oncreate: (err: Error | null, stream: Duplex) => void,
  ): Duplex | undefined {
    this.open().then(
      (socket) => oncreate(null, socket),
      (err: unknown) => oncreate(err as Error, undefined as never),
    );
    return undefined;
  }
}
