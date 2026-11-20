import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DeviceView } from "./store/devices.js";

// 路由选项 `config: { public: true }` 的公开路由（配对换令牌）不要求令牌。
declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface Cidr {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

// 前缀只接受十进制数字，不接受符号、空白或前导加号。
export function parseCidr(raw: string): Cidr | undefined {
  const m = /^([^/]+)\/([0-9]{1,3})$/.exec(raw);
  if (!m) return undefined;
  const [, address, p] = m as unknown as [string, string, string];
  const kind = net.isIP(address);
  if (kind === 0) return undefined;
  const prefix = Number(p);
  const family = kind === 4 ? "ipv4" : "ipv6";
  if (prefix > (kind === 4 ? 32 : 128)) return undefined;
  return { address, prefix, family };
}

export const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,}$/;

// 来源网段匹配。BlockList 对 IPv4 映射的 IPv6 地址与 IPv4 规则双向可比（plan 步骤 1 实测）。
export function createSourceMatcher(
  cidrs: string[],
): (remote: string | undefined) => boolean {
  const list = new net.BlockList();
  for (const raw of cidrs) {
    const c = parseCidr(raw);
    if (!c) throw new Error(`非法网段：${raw}`);
    list.addSubnet(c.address, c.prefix, c.family);
  }
  return (remote) => {
    if (!remote) return false;
    const addr = remote.split("%")[0] as string;
    const kind = net.isIP(addr);
    if (kind === 0) return false;
    return list.check(addr, kind === 4 ? "ipv4" : "ipv6");
  };
}

const BEARER_HEADER = /^Bearer ([^\s]+)$/i;
const WS_PREFIX = "bearer.";

// 会话 Cookie 名：iframe 里的子资源请求带不了自定义头，只能靠 Cookie 带上令牌。
export const SESSION_COOKIE = "ys_session";

// 会话 Cookie 的响应头值；HttpOnly 让脚本读不到，SameSite=Lax 挡掉跨站携带。
export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;

export const clearCookie = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// 从 Cookie 头里取会话令牌；同名多份时取第一个。
function cookieToken(header: string | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== SESSION_COOKIE) continue;
    const v = part.slice(i + 1).trim();
    // 与 TOKEN_PATTERN 同形，别把别的东西当令牌用
    if (TOKEN_PATTERN.test(v)) return v;
  }
  return undefined;
}

// 取出请求携带的令牌；WebSocket 升级另可取自子协议里的 bearer.<令牌> 项，普通请求可用会话 Cookie。
export function extractToken(headers: {
  authorization?: string | string[] | undefined;
  upgrade?: string | string[] | undefined;
  "sec-websocket-protocol"?: string | string[] | undefined;
  cookie?: string | string[] | undefined;
}): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const m = BEARER_HEADER.exec(auth);
    if (m) return m[1];
  }
  const upgrade = headers.upgrade;
  const proto = headers["sec-websocket-protocol"];
  if (
    typeof upgrade === "string" &&
    upgrade.toLowerCase() === "websocket" &&
    typeof proto === "string"
  ) {
    for (const item of proto.split(",")) {
      const v = item.trim();
      if (v.startsWith(WS_PREFIX) && v.length > WS_PREFIX.length)
        return v.slice(WS_PREFIX.length);
    }
  }
  const cookie = headers.cookie;
  return cookieToken(
    Array.isArray(cookie) ? cookie.join("; ") : (cookie ?? undefined),
  );
}

// 两侧先取摘要再比较：长度恒定，不会因长度不同提前返回。
export function tokenMatches(expected: string, given: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

export interface RateLimitOptions {
  now: () => number;
  maxFailures: number;
  banMs: number;
  staleMs: number;
  capacity: number;
}

export const RATE_LIMIT_DEFAULTS: Omit<RateLimitOptions, "now"> = {
  maxFailures: 10,
  banMs: 60_000,
  staleMs: 10 * 60_000,
  capacity: 4096,
};

interface Entry {
  failures: number;
  lastFailure: number;
  bannedUntil: number;
}

// 按来源记录令牌失败。不使用定时器，过期与封禁到期都在访问时惰性判断。
export class FailureLimiter {
  private readonly table = new Map<string, Entry>();

  constructor(private readonly o: RateLimitOptions) {}

  get size(): number {
    return this.table.size;
  }

  // 返回剩余封禁整秒数（向上取整）；未封禁返回 0。
  blockedFor(source: string): number {
    const rec = this.live(source);
    if (!rec || rec.bannedUntil <= this.o.now()) return 0;
    return Math.ceil((rec.bannedUntil - this.o.now()) / 1000);
  }

  fail(source: string): void {
    const now = this.o.now();
    const rec = this.live(source) ?? this.insert(source, now);
    rec.failures += 1;
    rec.lastFailure = now;
    if (rec.failures >= this.o.maxFailures)
      rec.bannedUntil = now + this.o.banMs;
  }

  succeed(source: string): void {
    this.table.delete(source);
  }

  // 取出仍有效的记录：过期或封禁已到期的记录视为不存在（计数从零开始）。
  private live(source: string): Entry | undefined {
    const rec = this.table.get(source);
    if (!rec) return undefined;
    const now = this.o.now();
    const banExpired = rec.bannedUntil > 0 && rec.bannedUntil <= now;
    if (banExpired || now - rec.lastFailure > this.o.staleMs) {
      this.table.delete(source);
      return undefined;
    }
    return rec;
  }

  private insert(source: string, now: number): Entry {
    if (this.table.size >= this.o.capacity) {
      for (const [k, v] of this.table) {
        if (now - v.lastFailure > this.o.staleMs) this.table.delete(k);
      }
      if (this.table.size >= this.o.capacity) {
        const oldest = this.table.keys().next().value;
        if (oldest !== undefined) this.table.delete(oldest);
      }
    }
    const rec: Entry = { failures: 0, lastFailure: now, bannedUntil: 0 };
    this.table.set(source, rec);
    return rec;
  }
}

// 浏览器带的 Origin（页面脚本发的请求与 WebSocket 都有）必须与请求的 Host 是同一个主机与端口：
// 会话 Cookie 不分端口，同主机别的端口上的页面（转发出来的服务等）带着它也能打进来，要靠这一条拦。
// 反代改写了 Host 时看它给的 X-Forwarded-Host（页面脚本改不了请求头），再不行就走受信来源清单。
// 没有 Origin 的请求（命令行、同源的普通 GET）不在此列。
export function originAllowed(
  headers: {
    origin?: string | string[] | undefined;
    host?: string | string[] | undefined;
    "x-forwarded-host"?: string | string[] | undefined;
  },
  trusted: ReadonlySet<string>,
): boolean {
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // 含 "null"（沙箱 iframe、file:）
  }
  if (trusted.has(url.origin)) return true;
  const one = (v: string | string[] | undefined) =>
    typeof v === "string" ? v.split(",")[0]?.trim().toLowerCase() : undefined;
  return (
    url.host === one(headers.host) ||
    url.host === one(headers["x-forwarded-host"])
  );
}

export interface AuthOptions {
  token?: string;
  allowCidrs: string[];
  /** 额外放行的页面来源（scheme://host[:port]），Origin 与 Host 对不上又确属自己人时用 */
  trustedOrigins?: string[];
  limiter?: Partial<RateLimitOptions>;
  /** 手机设备令牌：全局令牌不匹配时再查它 */
  devices?: { verify(token: string): DeviceView | null };
}

/** 这个请求是谁发来的：全局令牌（桌面）还是某台设备（手机）。没配令牌的回环模式也算全局。 */
export type AuthInfo =
  | { kind: "global" }
  | { kind: "device"; device: DeviceView };

// 身份只活在一次请求里，按请求对象挂，用完随请求被回收。
const identities = new WeakMap<FastifyRequest, AuthInfo>();

export function authOf(req: FastifyRequest): AuthInfo {
  return identities.get(req) ?? { kind: "global" };
}

// 检查顺序固定：来源网段 → Origin → 限流 → 令牌，每一步失败即返回。
export function createAuthHook(opts: AuthOptions) {
  const inSource = opts.allowCidrs.length
    ? createSourceMatcher(opts.allowCidrs)
    : null;
  const trusted = new Set(opts.trustedOrigins ?? []);
  const limiter = new FailureLimiter({
    now: Date.now,
    ...RATE_LIMIT_DEFAULTS,
    ...opts.limiter,
  });

  const hook = async (req: FastifyRequest, reply: FastifyReply) => {
    const source = req.socket.remoteAddress;
    if (inSource && !inSource(source)) {
      return reply.code(403).send({ error: "forbidden_source" });
    }
    if (!originAllowed(req.headers, trusted)) {
      const origin = String(req.headers.origin);
      req.log.warn({ origin, host: req.headers.host }, "拒绝了来源不符的请求");
      return reply.code(403).send({
        error: "forbidden_origin",
        message: `请求来自 ${origin}，与 Server 地址不一致；确属自己人（比如反代改写了 Host）时，把它加进 YUANSHU_TRUSTED_ORIGINS。`,
      });
    }
    if (opts.token === undefined) return;

    const key = source ?? "unknown";
    const wait = limiter.blockedFor(key);
    if (wait > 0) {
      return reply
        .code(429)
        .header("Retry-After", String(wait))
        .send({ error: "too_many_attempts" });
    }
    // 公开路由（配对换令牌）不要求令牌，失败计数由路由自己按配对码记；封禁照样生效。
    if (req.routeOptions.config?.public === true) return;

    const given = extractToken(req.headers);
    if (given !== undefined && tokenMatches(opts.token, given)) {
      limiter.succeed(key);
      identities.set(req, { kind: "global" });
      return;
    }
    const device =
      given === undefined ? null : (opts.devices?.verify(given) ?? null);
    if (device) {
      limiter.succeed(key);
      identities.set(req, { kind: "device", device });
      return;
    }
    limiter.fail(key);
    return reply
      .code(401)
      .header("WWW-Authenticate", "Bearer")
      .send({ error: "unauthorized" });
  };
  return { hook, limiter };
}
