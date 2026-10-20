import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

export const LOCAL_ENV_ID = "local";
export const OS_TYPES = ["posix", "windows"] as const;
export type OsType = (typeof OS_TYPES)[number];
export const isOsType = (v: unknown): v is OsType =>
  typeof v === "string" && (OS_TYPES as readonly string[]).includes(v);

export interface Environment {
  id: string;
  name: string;
  kind: "local" | "ssh";
  host: string | null;
  port: number | null;
  username: string | null;
  os: OsType;
  secretId: string | null;
  /** 首次连接记录的主机密钥指纹（`算法:sha256 hex`）；未连过或已清除为 null。 */
  hostKey: string | null;
  createdAt: string;
}

export interface EnvironmentInput {
  name: string;
  host: string;
  port: number;
  username: string;
  os: OsType;
  secretId: string | null;
}

/** PATCH 内容：hostKey 只能清除（置 null）；改 host 或 port 时也会一并清除。 */
export type EnvironmentPatch = Partial<EnvironmentInput> & {
  hostKey?: null;
};

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
};
const toEnv = (r: Row): Environment => ({
  id: r.id,
  name: r.name,
  kind: "ssh",
  host: r.host,
  port: r.port,
  username: r.username,
  os: r.os as OsType,
  secretId: r.secret_id,
  hostKey: r.host_key,
  createdAt: r.created_at,
});

const LOCAL: Environment = {
  id: LOCAL_ENV_ID,
  name: "本机",
  kind: "local",
  host: null,
  port: null,
  username: null,
  os: process.platform === "win32" ? "windows" : "posix",
  secretId: null,
  hostKey: null,
  createdAt: "",
};

const isUnique = (err: unknown) =>
  (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";

// 环境登记：本机环境是隐含的（id=local，不入表），其余均为 ssh 环境。
export class EnvironmentStore {
  constructor(private readonly db: Db) {}

  list(): Environment[] {
    const rows = this.db
      .prepare("SELECT * FROM environments ORDER BY created_at")
      .all() as Row[];
    return [LOCAL, ...rows.map(toEnv)];
  }

  get(id: string): Environment | null {
    if (id === LOCAL_ENV_ID) return LOCAL;
    const r = this.db
      .prepare("SELECT * FROM environments WHERE id = ?")
      .get(id) as Row | undefined;
    return r ? toEnv(r) : null;
  }

  // 名称重复返回 null；secretId 不存在由外键抛出（调用方先校验）。
  create(input: EnvironmentInput): Environment | null {
    const id = uuidv7();
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO environments (id, name, host, port, username, os, secret_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.host,
          input.port,
          input.username,
          input.os,
          input.secretId,
          createdAt,
        );
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
    return this.get(id);
  }

  // 返回 undefined=不存在，null=名称重复。
  update(id: string, patch: EnvironmentPatch): Environment | null | undefined {
    const cur = this.get(id);
    if (!cur || cur.kind === "local") return undefined;
    const { hostKey: _clear, ...fields } = patch;
    const next = { ...cur, ...fields };
    // 指纹属于具体的 host:port，目标变了旧指纹就没有意义
    const keepKey =
      patch.hostKey !== null &&
      next.host === cur.host &&
      next.port === cur.port;
    try {
      this.db
        .prepare(
          `UPDATE environments SET name=?, host=?, port=?, username=?, os=?, secret_id=?, host_key=? WHERE id=?`,
        )
        .run(
          next.name,
          next.host,
          next.port,
          next.username,
          next.os,
          next.secretId,
          keepKey ? cur.hostKey : null,
          id,
        );
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
    return this.get(id);
  }

  // accept-new：只在尚无指纹时写入，已记录的指纹不会被连接路径覆盖。
  setHostKey(id: string, hostKey: string): void {
    this.db
      .prepare(
        "UPDATE environments SET host_key = ? WHERE id = ? AND host_key IS NULL",
      )
      .run(hostKey, id);
  }

  // 有 workspace 引用时返回 "in_use"。
  remove(id: string): "ok" | "not_found" | "in_use" {
    if (id === LOCAL_ENV_ID) return "in_use";
    const used = this.db
      .prepare("SELECT count(*) AS n FROM workspaces WHERE environment_id = ?")
      .get(id) as { n: number };
    if (used.n > 0) return "in_use";
    const r = this.db.prepare("DELETE FROM environments WHERE id = ?").run(id);
    return r.changes > 0 ? "ok" : "not_found";
  }
}
