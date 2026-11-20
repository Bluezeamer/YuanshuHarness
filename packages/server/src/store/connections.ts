import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";
import type { OsType } from "./environments.js";

// 连接就是 environments 表的一行，这里只管跳板、策略与主机密钥核对这几列（迁移见 db.ts 末尾）。

export const HOST_KEY_POLICIES = ["ask", "tofu"] as const;
export type HostKeyPolicy = (typeof HOST_KEY_POLICIES)[number];

export interface ConnectionPolicy {
  keepAlive: boolean;
  reuseSession: boolean;
  hostKey: HostKeyPolicy;
  proxyJumpFallback: boolean;
}

export const DEFAULT_POLICY: ConnectionPolicy = {
  keepAlive: true,
  reuseSession: true,
  hostKey: "ask",
  proxyJumpFallback: false,
};
// 迁移前就存在的环境没有 policy_json，保持它们原来的「首次自动记录」行为
const LEGACY_POLICY: ConnectionPolicy = { ...DEFAULT_POLICY, hostKey: "tofu" };

/** 跳板链最多几跳（A5）。 */
export const MAX_JUMP_DEPTH = 4;

export interface ConnectionRecord {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  os: OsType;
  secretId: string | null;
  jumpId: string | null;
  policy: ConnectionPolicy;
  /** 已信任的主机密钥指纹（库内格式 `算法:sha256 hex`）。 */
  hostKey: string | null;
  /** 校验被阻断时看到的新指纹；非空即「待核对」。 */
  hostKeyPending: string | null;
  /** 上次 trust 时被替换掉的旧指纹。 */
  hostKeyChangedFrom: string | null;
  hostKeyAcceptedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
}

type Row = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  os: string;
  secret_id: string | null;
  host_key: string | null;
  created_at: string;
  jump_id: string | null;
  policy_json: string | null;
  host_key_pending: string | null;
  host_key_changed_from: string | null;
  host_key_accepted_at: string | null;
  last_active_at: string | null;
};

const toRecord = (r: Row): ConnectionRecord => ({
  id: r.id,
  label: r.name,
  host: r.host,
  port: r.port,
  user: r.username,
  os: r.os as OsType,
  secretId: r.secret_id,
  jumpId: r.jump_id,
  policy: r.policy_json ? JSON.parse(r.policy_json) : LEGACY_POLICY,
  hostKey: r.host_key,
  hostKeyPending: r.host_key_pending,
  hostKeyChangedFrom: r.host_key_changed_from,
  hostKeyAcceptedAt: r.host_key_accepted_at,
  lastActiveAt: r.last_active_at,
  createdAt: r.created_at,
});

export interface ConnectionInput {
  label: string;
  host: string;
  port: number;
  user: string;
  os: OsType;
  secretId: string | null;
  jumpId: string | null;
  policy: ConnectionPolicy;
}

export type ConnectionPatch = Partial<ConnectionInput>;

export type JumpCheck =
  | { ok: true }
  | { ok: false; error: "jump_not_found" | "jump_cycle" | "jump_too_deep" };

const isUnique = (err: unknown) =>
  (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";

export class ConnectionStore {
  constructor(private readonly db: Db) {}

  list(): ConnectionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM environments ORDER BY created_at, id")
        .all() as Row[]
    ).map(toRecord);
  }

  get(id: string): ConnectionRecord | null {
    const r = this.db
      .prepare("SELECT * FROM environments WHERE id = ?")
      .get(id) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  /** 直接以 id 为跳板的下游（不含更远的）。 */
  dependants(id: string): ConnectionRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM environments WHERE jump_id = ? ORDER BY created_at, id",
        )
        .all(id) as Row[]
    ).map(toRecord);
  }

  /** 递归下游（广度优先，不含自己）。库里不会有环，visited 只是兜底。 */
  descendants(id: string): ConnectionRecord[] {
    const out: ConnectionRecord[] = [];
    const seen = new Set([id]);
    for (let queue = [id]; queue.length > 0; ) {
      const next: string[] = [];
      for (const cur of queue)
        for (const d of this.dependants(cur)) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          out.push(d);
          next.push(d.id);
        }
      queue = next;
    }
    return out;
  }

  /** 从最外层跳板到直接跳板的有序链（不含自己）；遇到环或悬空引用时截断。 */
  chain(id: string): ConnectionRecord[] {
    const out: ConnectionRecord[] = [];
    const seen = new Set([id]);
    let cur = this.get(id)?.jumpId ?? null;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const rec = this.get(cur);
      if (!rec) break;
      out.unshift(rec);
      cur = rec.jumpId;
    }
    return out;
  }

  /** 校验把 id 的跳板设为 jumpId 是否合法：存在、不成环、链深不超限。id=null 表示新建。 */
  checkJump(id: string | null, jumpId: string): JumpCheck {
    if (!this.get(jumpId)) return { ok: false, error: "jump_not_found" };
    if (
      id !== null &&
      (jumpId === id || this.descendants(id).some((d) => d.id === jumpId))
    )
      return { ok: false, error: "jump_cycle" };
    // 链深 = 上游链长 + 1（自己的直接跳板）；下游整条也要算进去，改动后最长一条仍不超限
    const upstream = this.chain(jumpId).length + 1;
    const downstream = id === null ? 0 : this.depthBelow(id);
    if (upstream + downstream > MAX_JUMP_DEPTH)
      return { ok: false, error: "jump_too_deep" };
    return { ok: true };
  }

  private depthBelow(id: string): number {
    let depth = 0;
    for (let level = this.dependants(id); level.length > 0; depth++)
      level = level.flatMap((d) => this.dependants(d.id));
    return depth;
  }

  // 名称重复返回 null；secretId / jumpId 不存在由调用方先校验。
  create(input: ConnectionInput): ConnectionRecord | null {
    const id = uuidv7();
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO environments (id, name, host, port, username, os, secret_id, created_at, jump_id, policy_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.label,
          input.host,
          input.port,
          input.user,
          input.os,
          input.secretId,
          createdAt,
          input.jumpId,
          JSON.stringify(input.policy),
        );
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
    return this.get(id);
  }

  // 返回 undefined=不存在，null=名称重复。改 host/port 作废旧主机密钥记录（含待核对与历史）。
  update(
    id: string,
    patch: ConnectionPatch,
  ): ConnectionRecord | null | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    const moved = next.host !== cur.host || next.port !== cur.port;
    try {
      this.db
        .prepare(
          `UPDATE environments SET name=?, host=?, port=?, username=?, os=?, secret_id=?, jump_id=?, policy_json=?,
             host_key=?, host_key_pending=?, host_key_changed_from=?, host_key_accepted_at=? WHERE id=?`,
        )
        .run(
          next.label,
          next.host,
          next.port,
          next.user,
          next.os,
          next.secretId,
          next.jumpId,
          JSON.stringify(next.policy),
          moved ? null : cur.hostKey,
          moved ? null : cur.hostKeyPending,
          moved ? null : cur.hostKeyChangedFrom,
          moved ? null : cur.hostKeyAcceptedAt,
          id,
        );
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
    return this.get(id);
  }

  /** 引用该密钥的连接（密钥库的 referencedBy）。 */
  usersOfSecret(secretId: string): Array<{ id: string; label: string }> {
    return this.db
      .prepare(
        "SELECT id, name AS label FROM environments WHERE secret_id = ? ORDER BY name",
      )
      .all(secretId) as Array<{ id: string; label: string }>;
  }

  /** 引用该连接的目录数量。 */
  directoryCount(id: string): number {
    return (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM directories WHERE environment_id = ?",
        )
        .get(id) as { n: number }
    ).n;
  }

  /** 删除；调用方先确认没有下游和目录引用。 */
  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM environments WHERE id = ?").run(id).changes >
      0
    );
  }

  /** 校验被阻断时记下看到的指纹（待核对）。 */
  setPending(id: string, fingerprint: string): void {
    this.db
      .prepare("UPDATE environments SET host_key_pending = ? WHERE id = ?")
      .run(fingerprint, id);
  }

  /** 接受待核对的指纹：旧值写进 changed_from（首次记录没有旧值，保持为空）。 */
  trust(id: string, at: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE environments SET host_key_changed_from = host_key, host_key = host_key_pending,
           host_key_pending = NULL, host_key_accepted_at = ?
         WHERE id = ? AND host_key_pending IS NOT NULL`,
      )
      .run(at, id);
    return r.changes > 0;
  }

  /** 校验通过（指纹与记录一致）时清掉过期的待核对状态。 */
  clearPending(id: string): void {
    this.db
      .prepare("UPDATE environments SET host_key_pending = NULL WHERE id = ?")
      .run(id);
  }

  touchActive(id: string, at: string): void {
    this.db
      .prepare("UPDATE environments SET last_active_at = ? WHERE id = ?")
      .run(at, id);
  }
}
