import type { Db } from "./db.js";

// 手机推送：VAPID 密钥（私钥封存后落库）与每台设备一条订阅 + 通知偏好。
// 撤销设备时由外键级联删订阅，这里不再删一次。

export const PUSH_POLICIES = ["always", "unwatched", "delay"] as const;
export type PushPolicy = (typeof PUSH_POLICIES)[number];
export const isPushPolicy = (v: unknown): v is PushPolicy =>
  typeof v === "string" && (PUSH_POLICIES as readonly string[]).includes(v);

export const DELAY_MIN_SEC = 5;
export const DELAY_MAX_SEC = 600;

export interface PushPrefs {
  blocked: boolean;
  error: boolean;
  done: boolean;
  policy: PushPolicy;
  delaySec: number;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRow extends PushSubscriptionInput {
  deviceId: string;
  prefs: PushPrefs;
  createdAt: string;
}

type Row = {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  on_blocked: number;
  on_error: number;
  on_done: number;
  policy: string;
  delay_sec: number;
  created_at: string;
};

const COLS = `device_id, endpoint, p256dh, auth, on_blocked, on_error, on_done, policy, delay_sec, created_at`;

const toRow = (r: Row): PushRow => ({
  deviceId: r.device_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  prefs: {
    blocked: r.on_blocked !== 0,
    error: r.on_error !== 0,
    done: r.on_done !== 0,
    policy: r.policy as PushPolicy,
    delaySec: r.delay_sec,
  },
  createdAt: r.created_at,
});

export class PushStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  vapid(): { publicKey: string; privateKey: Buffer } | null {
    const r = this.db
      .prepare("SELECT public_key, private_key FROM push_vapid WHERE id = 1")
      .get() as { public_key: string; private_key: Buffer } | undefined;
    return r ? { publicKey: r.public_key, privateKey: r.private_key } : null;
  }

  /** 只写一次：已经有密钥时什么都不做（浏览器按源认公钥，换钥等于让所有订阅作废）。 */
  saveVapid(publicKey: string, sealedPrivateKey: Buffer): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO push_vapid (id, public_key, private_key) VALUES (1, ?, ?)",
      )
      .run(publicKey, sealedPrivateKey);
  }

  /** 同一设备重订阅只换地址与密钥，通知偏好保留。 */
  upsert(deviceId: string, sub: PushSubscriptionInput): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint,
                                              p256dh = excluded.p256dh,
                                              auth = excluded.auth`,
      )
      .run(
        deviceId,
        sub.endpoint,
        sub.p256dh,
        sub.auth,
        new Date(this.now()).toISOString(),
      );
  }

  remove(deviceId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM push_subscriptions WHERE device_id = ?")
        .run(deviceId).changes > 0
    );
  }

  get(deviceId: string): PushRow | null {
    const r = this.db
      .prepare(`SELECT ${COLS} FROM push_subscriptions WHERE device_id = ?`)
      .get(deviceId) as Row | undefined;
    return r ? toRow(r) : null;
  }

  list(): PushRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM push_subscriptions ORDER BY created_at, device_id`,
      )
      .all() as Row[];
    return rows.map(toRow);
  }

  /** 部分更新；没有订阅返回 null。取值合法性由 api 层校验。 */
  setPrefs(deviceId: string, patch: Partial<PushPrefs>): PushPrefs | null {
    const cur = this.get(deviceId);
    if (!cur) return null;
    const prefs: PushPrefs = { ...cur.prefs, ...patch };
    this.db
      .prepare(
        `UPDATE push_subscriptions
         SET on_blocked = ?, on_error = ?, on_done = ?, policy = ?, delay_sec = ?
         WHERE device_id = ?`,
      )
      .run(
        prefs.blocked ? 1 : 0,
        prefs.error ? 1 : 0,
        prefs.done ? 1 : 0,
        prefs.policy,
        prefs.delaySec,
        deviceId,
      );
    return prefs;
  }
}
