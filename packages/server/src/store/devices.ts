import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

// 手机设备：一台设备一个独立令牌，全局令牌不动。库里只存令牌的 SHA-256，明文只在 create 的返回值里出现一次。
export interface DeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

type Row = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

const toView = (r: Row): DeviceView => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// 「最近使用」只是个粗略统计：同一设备每分钟最多写一次库，别让每个请求都写盘。
const LAST_USED_WRITE_MS = 60_000;

export class DeviceStore {
  private readonly lastWrite = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(name: string): { device: DeviceView; token: string } {
    const token = randomBytes(32).toString("base64url");
    const device = {
      id: uuidv7(),
      name,
      createdAt: new Date(this.now()).toISOString(),
      lastUsedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO devices (id, name, token_hash, created_at, last_used_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(device.id, device.name, sha256(token), device.createdAt);
    return { device, token };
  }

  /** 命中返回设备并刷新最近使用；未命中返回 null。撤销后的下一个请求就靠它现查库变成 401。 */
  verify(token: string): DeviceView | null {
    const r = this.db
      .prepare(
        "SELECT id, name, created_at, last_used_at FROM devices WHERE token_hash = ?",
      )
      .get(sha256(token)) as Row | undefined;
    if (!r) return null;
    const now = this.now();
    const written = this.lastWrite.get(r.id);
    if (written === undefined || now - written >= LAST_USED_WRITE_MS) {
      this.lastWrite.set(r.id, now);
      r.last_used_at = new Date(now).toISOString();
      this.db
        .prepare("UPDATE devices SET last_used_at = ? WHERE id = ?")
        .run(r.last_used_at, r.id);
    }
    return toView(r);
  }

  list(): DeviceView[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, created_at, last_used_at FROM devices ORDER BY created_at, id",
      )
      .all() as Row[];
    return rows.map(toView);
  }

  get(id: string): DeviceView | null {
    const r = this.db
      .prepare(
        "SELECT id, name, created_at, last_used_at FROM devices WHERE id = ?",
      )
      .get(id) as Row | undefined;
    return r ? toView(r) : null;
  }

  remove(id: string): boolean {
    this.lastWrite.delete(id);
    return (
      this.db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0
    );
  }
}
