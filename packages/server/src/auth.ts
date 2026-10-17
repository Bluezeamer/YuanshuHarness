import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";

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

// 取出请求携带的令牌；WebSocket 升级另可取自子协议里的 bearer.<令牌> 项。
export function extractToken(headers: {
  authorization?: string | string[] | undefined;
  upgrade?: string | string[] | undefined;
  "sec-websocket-protocol"?: string | string[] | undefined;
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
  return undefined;
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
    if (rec.failures >= this.o.maxFailures) rec.bannedUntil = now + this.o.banMs;
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

export interface AuthOptions {
  token?: string;
  allowCidrs: string[];
  limiter?: Partial<RateLimitOptions>;
}

// 检查顺序固定：来源网段 → 限流 → 令牌，每一步失败即返回。
export function createAuthHook(opts: AuthOptions) {
  const inSource = opts.allowCidrs.length
    ? createSourceMatcher(opts.allowCidrs)
    : null;
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
    if (opts.token === undefined) return;

    const key = source ?? "unknown";
    const wait = limiter.blockedFor(key);
    if (wait > 0) {
      return reply
        .code(429)
        .header("Retry-After", String(wait))
        .send({ error: "too_many_attempts" });
    }
    const given = extractToken(req.headers);
    if (given === undefined || !tokenMatches(opts.token, given)) {
      limiter.fail(key);
      return reply
        .code(401)
        .header("WWW-Authenticate", "Bearer")
        .send({ error: "unauthorized" });
    }
    limiter.succeed(key);
  };
  return { hook, limiter };
}
