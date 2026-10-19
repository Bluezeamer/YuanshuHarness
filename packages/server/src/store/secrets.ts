import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

export const SECRET_KINDS = ["ssh_key", "password"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export const isSecretKind = (v: unknown): v is SecretKind =>
  typeof v === "string" && (SECRET_KINDS as readonly string[]).includes(v);

export const KEY_FILE = "secret.key";
const VALUE_MAX = 16 * 1024;

// 主密钥：数据目录下 32 字节随机数（hex），0600；不存在则生成。丢失即所有密码不可恢复。
export function loadMasterKey(dataDir: string): Buffer {
  const file = path.join(dataDir, KEY_FILE);
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (key.length !== 32) throw new Error(`${file} 不是有效的 32 字节密钥`);
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600, flag: "wx" });
  return key;
}

export interface SecretMeta {
  id: string;
  name: string;
  kind: SecretKind;
  createdAt: string;
}

type Row = { id: string; name: string; kind: string; created_at: string };
const toMeta = (r: Row): SecretMeta => ({
  id: r.id,
  name: r.name,
  kind: r.kind as SecretKind,
  createdAt: r.created_at,
});

// 密码库：AES-256-GCM，存 iv(12)+tag(16)+密文。值只能经 reveal 在 Server 内部取出，列表与 REST 永不返回。
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  list(): SecretMeta[] {
    return (
      this.db
        .prepare("SELECT id, name, kind, created_at FROM secrets ORDER BY created_at")
        .all() as Row[]
    ).map(toMeta);
  }

  get(id: string): SecretMeta | null {
    const r = this.db
      .prepare("SELECT id, name, kind, created_at FROM secrets WHERE id = ?")
      .get(id) as Row | undefined;
    return r ? toMeta(r) : null;
  }

  // 名称重复返回 null。
  create(name: string, kind: SecretKind, value: string): SecretMeta | null {
    if (value === "" || value.length > VALUE_MAX)
      throw new RangeError("secret value out of range");
    const row: Row = {
      id: uuidv7(),
      name,
      kind,
      created_at: new Date().toISOString(),
    };
    try {
      this.db
        .prepare(
          "INSERT INTO secrets (id, name, kind, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(row.id, name, kind, this.encrypt(value), row.created_at);
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
        return null;
      throw err;
    }
    return toMeta(row);
  }

  reveal(id: string): string | null {
    const r = this.db
      .prepare("SELECT ciphertext FROM secrets WHERE id = ?")
      .get(id) as { ciphertext: Buffer } | undefined;
    return r ? this.decrypt(r.ciphertext) : null;
  }

  // 被环境引用时外键拒绝，返回 "in_use"。
  remove(id: string): "ok" | "not_found" | "in_use" {
    try {
      const r = this.db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
      return r.changes > 0 ? "ok" : "not_found";
    } catch (err) {
      if ((err as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT"))
        return "in_use";
      throw err;
    }
  }

  private encrypt(plain: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  private decrypt(blob: Buffer): string {
    const d = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString(
      "utf8",
    );
  }
}
