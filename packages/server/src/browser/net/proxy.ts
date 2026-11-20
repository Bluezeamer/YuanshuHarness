// 浏览器唯一出口：HTTP + CONNECT 代理，同时做转发、沙箱（拒内网）与授权（上下文令牌）。
// 普通 HTTP 用 absolute-form 转发，CONNECT 双向 pipe 原始字节（https 与 WebSocket 都走 CONNECT）。
import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type http from "node:http";
import httpMod from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { ExecEnv } from "../../env/types.js";
import { outboundHeaders, TunnelAgent } from "../../lib/tunnel-http.js";
import { isBlockedAddress } from "./blocklist.js";
import { parseVirtualHost } from "./hostnames.js";
import { DENY_HEADER, serveFile } from "./static.js";

export type DenyCode =
  | "auth"
  | "blocked_address"
  | "unknown_host"
  | "service_denied"
  | "file_denied"
  | "unresolvable"
  | "unsupported";

export interface ProxyContext {
  /** 裸 localhost / 127.0.0.1 / [::1] 指向哪个环境；null 表示一律拒绝 */
  loopbackEnvId: string | null;
  allowService(envId: string, port: number): boolean;
  allowFile(envId: string, realPath: string): boolean | Promise<boolean>;
}

export interface ProxyDeps {
  env(envId: string): ExecEnv | null;
  /** 测试注入；默认 node:dns 的 lookup */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** 公网拨号，测试注入以断言「连的是已校验的 IP」；默认 net.connect。 */
  dial?: (address: string, port: number) => net.Socket;
  /** 每次拒绝时回调（审计 / 提示用） */
  onDeny?(info: { code: DenyCode; host: string; detail?: string }): void;
}

export interface Registration {
  readonly token: string;
  unregister(): void;
}

export interface Proxy {
  /** 监听 127.0.0.1 的随机端口 */
  readonly port: number;
  register(ctx: ProxyContext): Registration;
  /** 关监听并断开所有连接 */
  close(): Promise<void>;
}

const REALM = 'Basic realm="yuanshu"';

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const DENY_TEXT: Record<Exclude<DenyCode, "auth">, string> = {
  blocked_address:
    "该地址落在内网、回环、链路本地或保留网段，浏览器代理不允许访问",
  unknown_host: "找不到这个主机：它既不是已登记的环境，也不是允许的公网地址",
  service_denied: "当前上下文不允许访问这个主机上的这个端口",
  file_denied:
    "该文件不在这个工作区的目录里，或是密钥、凭据一类的敏感文件，浏览器代理不允许读取",
  unresolvable: "域名解析失败",
  unsupported: "浏览器代理不支持这种请求",
};

/** 拒绝码翻成给人和模型看的中文（导航被拒时界面与工具共用这一份）。 */
export function denyText(code: string): string {
  if (code === "auth") return "浏览器代理认证失败（上下文令牌失效）";
  return (
    (DENY_TEXT as Record<string, string | undefined>)[code] ??
    `浏览器代理拒绝了这次访问：${code}`
  );
}

/** 上游连接方式：环境的转发通道，或已校验 IP 的直接连接。 */
type Upstream =
  | { kind: "tunnel"; open: () => Promise<Duplex> }
  | { kind: "direct"; address: string; port: number };

/** 主机名归一：小写、去方括号、去末尾点。 */
const normalizeHost = (host: string) =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// 从请求行里取主机名，取不到返回 null（只用于拒绝时的审计字段）。
function hostOf(raw: string): string | null {
  try {
    return normalizeHost(new URL(raw).hostname);
  } catch {
    return null;
  }
}

// CONNECT 的 authority：`host:port` / `[v6]:port`
function splitAuthority(raw: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:[\]]+):([0-9]{1,5})$/.exec(raw.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: normalizeHost(m[1] as string), port };
}

export function startProxy(deps: ProxyDeps): Promise<Proxy> {
  const reject = (code: DenyCode, host: string, detail?: string) => {
    deps.onDeny?.(
      detail === undefined ? { code, host } : { code, host, detail },
    );
  };
  const lookup: NonNullable<ProxyDeps["lookup"]> =
    deps.lookup ??
    (async (host) =>
      (await dnsLookup(host, { all: true, verbatim: true })).map((r) => ({
        address: r.address,
        family: r.family,
      })));

  // 令牌只存摘要：内存快照、日志里都拿不到能直接用的令牌。
  const contexts = new Map<string, ProxyContext>();
  const sockets = new Set<net.Socket>();

  function contextOf(req: http.IncomingMessage): ProxyContext | null {
    const raw = req.headers["proxy-authorization"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") return null;
    const m = /^Basic\s+(\S+)$/i.exec(value.trim());
    if (!m) return null;
    const decoded = Buffer.from(m[1] as string, "base64").toString("utf8");
    const at = decoded.indexOf(":");
    if (at <= 0) return null;
    return contexts.get(sha256(decoded.slice(0, at))) ?? null;
  }

  function denyHttp(
    res: http.ServerResponse,
    code: DenyCode,
    host: string,
    detail?: string,
  ) {
    reject(code, host, detail);
    const body = code === "auth" ? "浏览器代理认证失败" : DENY_TEXT[code];
    res.writeHead(code === "auth" ? 407 : 403, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      [DENY_HEADER]: code,
      ...(code === "auth" ? { "Proxy-Authenticate": REALM } : {}),
    });
    res.end(body);
  }

  function denyConnect(
    socket: Duplex,
    code: DenyCode,
    host: string,
    detail?: string,
  ) {
    reject(code, host, detail);
    socket.write(
      [
        `HTTP/1.1 ${code === "auth" ? "407 Proxy Authentication Required" : "403 Forbidden"}`,
        `${DENY_HEADER}: ${code}`,
        ...(code === "auth" ? [`Proxy-Authenticate: ${REALM}`] : []),
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );
    socket.end();
  }

  /**
   * 公网目标先解析再校验：被拦的地址直接忽略，只连通过校验的第一个 IP，都被拦才拒绝；
   * 连接阶段不再解析（防 DNS 重绑定）。不能「混一个被拦的就整体拒绝」：透明代理（fake-ip 的 DNS）
   * 常给 AAAA 一个 fc00::/7 地址，那样所有公网站点都打不开。拨的永远是校验过的 IP，所以忽略不构成风险。
   */
  async function publicAddress(
    host: string,
    port: number,
  ): Promise<Upstream | DenyCode> {
    if (net.isIP(host) !== 0)
      return isBlockedAddress(host)
        ? "blocked_address"
        : { kind: "direct", address: host, port };
    let rows: { address: string }[];
    try {
      rows = await lookup(host);
    } catch {
      return "unresolvable";
    }
    if (rows.length === 0) return "unresolvable";
    const first = rows.find((r) => !isBlockedAddress(r.address));
    if (first === undefined) return "blocked_address";
    return { kind: "direct", address: first.address, port };
  }

  /** 按主机名决定怎么连上游：虚拟主机名走环境，其余按公网规则校验。 */
  async function upstreamFor(
    host: string,
    port: number,
    ctx: ProxyContext,
  ): Promise<Upstream | DenyCode> {
    const virtual = parseVirtualHost(host);
    if (virtual?.kind === "file") return "unsupported";
    if (virtual?.kind === "service" || LOOPBACK.has(host)) {
      const envId = virtual ? virtual.envId : ctx.loopbackEnvId;
      if (envId === null) return "blocked_address";
      const env = deps.env(envId);
      if (env === null) return "unknown_host";
      if (!ctx.allowService(envId, port)) return "service_denied";
      const openTcp = env.openTcp?.bind(env);
      if (!openTcp) return "unsupported";
      return { kind: "tunnel", open: () => openTcp(port) };
    }
    if (host.endsWith(".localhost")) return "unknown_host";
    return publicAddress(host, port);
  }

  // 两处公网拨号（普通 HTTP、CONNECT）都经这里，拨的永远是校验过的 IP 字面量。
  const dial =
    deps.dial ??
    ((address: string, port: number) => net.connect({ host: address, port }));

  function connectDirect({ address, port }: { address: string; port: number }) {
    return new Promise<Duplex>((ok, fail) => {
      const s = dial(address, port);
      s.once("connect", () => ok(s));
      s.once("error", fail);
    });
  }

  /** 流式转发普通 HTTP 请求，响应直接写回客户端。 */
  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    upstream: Upstream,
    options: http.RequestOptions,
  ) {
    const out = httpMod.request(
      {
        ...options,
        method: req.method,
        // 两种上游都由我们自己拨号：公网连已校验的 IP，环境用 openTcp 提供的连接。
        // 不能用 agent:false——它会忽略 createConnection，请求退化成按 host 直连。
        agent: new TunnelAgent(
          upstream.kind === "direct"
            ? () => Promise.resolve(dial(upstream.address, upstream.port))
            : upstream.open,
        ),
      },
      (r) => {
        res.writeHead(
          r.statusCode ?? 502,
          r.statusMessage,
          outboundHeaders(r.headers),
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
      const body = `连接上游失败：${err.code ?? err.message}`;
      res.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(body)),
        "Cache-Control": "no-store",
      });
      res.end(body);
    });
    req.pipe(out);
    // 客户端中途断开就中止上游；正常写完的 close 不动它
    req.on("aborted", () => out.destroy());
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
    });
  }

  async function handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const raw = req.url ?? "";
    const ctx = contextOf(req);
    if (ctx === null) {
      // 认证先于解析：没有令牌的请求一律 407，连它是给谁发的都不必判
      denyHttp(res, "auth", hostOf(raw) ?? raw);
      return;
    }
    let url: URL;
    try {
      // 代理收到的是 absolute-form；相对地址说明客户端没把它当代理用
      url = new URL(raw);
    } catch {
      denyHttp(res, "unsupported", raw, "普通请求必须带完整地址");
      return;
    }
    const host = normalizeHost(url.hostname);

    const virtual = parseVirtualHost(host);
    // 文件主机：只处理普通 HTTP，交给静态文件服务
    if (virtual?.kind === "file") {
      const env = deps.env(virtual.envId);
      if (env === null) {
        denyHttp(res, "unknown_host", host);
        return;
      }
      let filePath: string;
      try {
        filePath = decodeURIComponent(url.pathname);
      } catch {
        denyHttp(res, "unsupported", host, "路径无法解码");
        return;
      }
      const code = await serveFile(
        {
          env,
          path: filePath,
          method: req.method ?? "GET",
          allow: (real) => ctx.allowFile(virtual.envId, real),
        },
        res,
      );
      if (code !== null) reject(code, host, filePath);
      return;
    }

    // https 的公网地址浏览器会用 CONNECT，普通请求里出现说明不是代理流量
    if (url.protocol !== "http:") {
      denyHttp(res, "unsupported", host, "普通请求只支持 http");
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const upstream = await upstreamFor(host, port, ctx);
    if (typeof upstream === "string") {
      denyHttp(res, upstream, host, `${host}:${port}`);
      return;
    }
    forward(req, res, upstream, {
      path: `${url.pathname}${url.search}`,
      // 上游看到的 Host 仍是浏览器请求里的那个（虚拟主机名或公网域名）
      headers: outboundHeaders(req.headers, url.host),
    });
  }

  async function handleConnect(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    const raw = req.url ?? "";
    const ctx = contextOf(req);
    const target = splitAuthority(raw);
    const host = target?.host ?? raw;
    if (ctx === null) {
      denyConnect(socket, "auth", host);
      return;
    }
    if (target === null) {
      denyConnect(socket, "unsupported", host, "CONNECT 要写成 主机:端口");
      return;
    }

    const upstream = await upstreamFor(target.host, target.port, ctx);
    if (typeof upstream === "string") {
      denyConnect(socket, upstream, target.host, `${host}:${target.port}`);
      return;
    }

    let remote: Duplex;
    try {
      remote =
        upstream.kind === "tunnel"
          ? await upstream.open()
          : await connectDirect(upstream);
    } catch {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      socket.end();
      return;
    }

    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) remote.write(head);
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
  }

  const server = httpMod.createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  });
  server.on("connect", (req, socket, head) => {
    void handleConnect(req, socket, head).catch(() => socket.destroy());
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise<Proxy>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      const { port } = server.address() as net.AddressInfo;
      ok({
        port,
        register(ctx) {
          const token = randomBytes(24).toString("base64url");
          const key = sha256(token);
          contexts.set(key, ctx);
          return {
            token,
            unregister: () => {
              contexts.delete(key);
            },
          };
        },
        async close() {
          for (const s of sockets) s.destroy();
          sockets.clear();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
