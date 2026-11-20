import { randomInt } from "node:crypto";

/** 配对码有效期：5 分钟。 */
export const PAIRING_TTL_MS = 5 * 60_000;

// 去掉容易看混的 0/O、1/I/L，剩下 31 个字符；8 位约 40 位熵。
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const MAX_CODES = 20;

interface Entry {
  expiresAt: number;
}

// 配对码只在内存里：重启后未使用的码失效，重新点「添加设备」即可。没有定时器，过期在访问时顺手清掉。
export class PairingCodes {
  private readonly codes = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  create(): { code: string; expiresAt: string } {
    this.sweep();
    // 并发多个配对窗时最多留 20 个，超过丢最早的
    if (this.codes.size >= MAX_CODES) {
      const oldest = this.codes.keys().next().value;
      if (oldest !== undefined) this.codes.delete(oldest);
    }
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += ALPHABET.charAt(randomInt(ALPHABET.length));
    }
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.codes.set(code, { expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** 一次性：有效就删掉并返回 true；过期、不存在、已用过都是 false。 */
  redeem(raw: string): boolean {
    this.sweep();
    const code = raw.trim().toUpperCase();
    if (!this.codes.delete(code)) return false;
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
  }
}
