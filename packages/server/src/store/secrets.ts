import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

// 隐私变量（ADR-0050）：与凭据同表同加密，kind='variable'，不进凭据接口。
export const SCOPE_KINDS = ["any", "domain", "sudo"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const isScopeKind = (v: unknown): v is ScopeKind =>
  typeof v === "string" && (SCOPE_KINDS as readonly string[]).includes(v);

export const VAR_TIERS = ["rules", "auto", "full"] as const;
export type VarTier = (typeof VAR_TIERS)[number];
export const isVarTier = (v: unknown): v is VarTier =>
  typeof v === "string" && (VAR_TIERS as readonly string[]).includes(v);

// 占位符名：字母开头，字母数字下划线，同时是合法的 shell 变量名片段。
export const VAR_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const isVarName = (v: unknown): v is string =>
  typeof v === "string" && VAR_NAME_RE.test(v);
// 登记下限与遮罩下限：短于遮罩下限的值（如 sudo 密码）可登记，但输出回显不做替换。
export const VAR_VALUE_MIN = 4;
export const MASK_MIN = 8;
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const PURPOSE_MAX = 500;

export interface VariableMeta {
  id: string;
  name: string;
  purpose: string;
  scopeKind: ScopeKind;
  scopeTarget: string | null;
  tier: VarTier;
  // false 表示值太短，输出回显遮罩不会替换它。
  maskable: boolean;
  createdAt: string;
}

export interface VariableInput {
  name: string;
  purpose: string;
  scopeKind: ScopeKind;
  scopeTarget: string | null;
  tier: VarTier;
  value: string;
}

type VarRow = Row & {
  purpose: string | null;
  scope_kind: string;
  scope_target: string | null;
  tier: string;
  ciphertext: Buffer;
};

// 校验范围与长度；返回错误码或 null。value 缺省（编辑时不改值）则不检查长度。
export function checkVariable(
  v: Partial<VariableInput>,
  needValue: boolean,
): string | null {
  if (v.name !== undefined && !isVarName(v.name)) return "invalid_name";
  if (v.purpose !== undefined && v.purpose.length > PURPOSE_MAX)
    return "invalid_purpose";
  if (v.scopeKind !== undefined) {
    if (v.scopeKind === "domain") {
      if (typeof v.scopeTarget !== "string" || !DOMAIN_RE.test(v.scopeTarget))
        return "invalid_scope";
    } else if (v.scopeTarget !== null && v.scopeTarget !== undefined)
      return "invalid_scope";
  }
  if (needValue || v.value !== undefined) {
    if (
      typeof v.value !== "string" ||
      v.value.length < VAR_VALUE_MIN ||
      v.value.length > VALUE_MAX
    )
      return "invalid_value";
  }
  return null;
}

// 密码库：AES-256-GCM，存 iv(12)+tag(16)+密文。值只能经 reveal 在 Server 内部取出，列表与 REST 永不返回。
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  list(): SecretMeta[] {
    return (
      this.db
        .prepare(
          "SELECT id, name, kind, created_at FROM secrets WHERE kind != 'variable' ORDER BY created_at",
        )
        .all() as Row[]
    ).map(toMeta);
  }

  get(id: string): SecretMeta | null {
    const r = this.db
      .prepare(
        "SELECT id, name, kind, created_at FROM secrets WHERE id = ? AND kind != 'variable'",
      )
      .get(id) as Row | undefined;
    return r ? toMeta(r) : null;
  }

  private varMeta(r: VarRow): VariableMeta {
    return {
      id: r.id,
      name: r.name,
      purpose: r.purpose ?? "",
      scopeKind: r.scope_kind as ScopeKind,
      scopeTarget: r.scope_target,
      tier: r.tier as VarTier,
      maskable: this.decrypt(r.ciphertext).length >= MASK_MIN,
      createdAt: r.created_at,
    };
  }

  private varRows(where = "", ...args: string[]): VarRow[] {
    return this.db
      .prepare(
        `SELECT id, name, kind, created_at, purpose, scope_kind, scope_target, tier, ciphertext
         FROM secrets WHERE kind = 'variable' ${where} ORDER BY name`,
      )
      .all(...args) as VarRow[];
  }

  listVariables(): VariableMeta[] {
    return this.varRows().map((r) => this.varMeta(r));
  }

  getVariable(id: string): VariableMeta | null {
    const r = this.varRows("AND id = ?", id)[0];
    return r ? this.varMeta(r) : null;
  }

  // 名称与现有凭据/变量重名返回 null；输入需已通过 checkVariable。
  createVariable(v: VariableInput): VariableMeta | null {
    const id = uuidv7();
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO secrets (id, name, kind, ciphertext, created_at, purpose, scope_kind, scope_target, tier)
           VALUES (?, ?, 'variable', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          v.name,
          this.encrypt(v.value),
          createdAt,
          v.purpose,
          v.scopeKind,
          v.scopeTarget,
          v.tier,
        );
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
        return null;
      throw err;
    }
    return this.getVariable(id);
  }

  // 部分更新；value 缺省则保留原值。不存在返回 undefined，重名返回 null。
  updateVariable(
    id: string,
    patch: Partial<VariableInput>,
  ): VariableMeta | null | undefined {
    const cur = this.varRows("AND id = ?", id)[0];
    if (!cur) return undefined;
    const scopeKind = patch.scopeKind ?? (cur.scope_kind as ScopeKind);
    const scopeTarget =
      patch.scopeKind !== undefined
        ? (patch.scopeTarget ?? null)
        : cur.scope_target;
    try {
      this.db
        .prepare(
          `UPDATE secrets SET name = ?, purpose = ?, scope_kind = ?, scope_target = ?, tier = ?, ciphertext = ?
           WHERE id = ? AND kind = 'variable'`,
        )
        .run(
          patch.name ?? cur.name,
          patch.purpose ?? cur.purpose ?? "",
          scopeKind,
          scopeTarget,
          patch.tier ?? cur.tier,
          patch.value === undefined
            ? cur.ciphertext
            : this.encrypt(patch.value),
          id,
        );
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
        return null;
      throw err;
    }
    return this.getVariable(id);
  }

  removeVariable(id: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM secrets WHERE id = ? AND kind = 'variable'")
        .run(id).changes > 0
    );
  }

  // 仅 Server 内部用：占位符替换与输出遮罩需要全部变量的真值。绝不经 REST 返回。
  variableValues(): { name: string; meta: VariableMeta; value: string }[] {
    return this.varRows().map((r) => ({
      name: r.name,
      meta: this.varMeta(r),
      value: this.decrypt(r.ciphertext),
    }));
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
      .prepare(
        "SELECT ciphertext FROM secrets WHERE id = ? AND kind != 'variable'",
      )
      .get(id) as { ciphertext: Buffer } | undefined;
    return r ? this.decrypt(r.ciphertext) : null;
  }

  // 被环境引用时外键拒绝，返回 "in_use"。
  remove(id: string): "ok" | "not_found" | "in_use" {
    try {
      const r = this.db
        .prepare("DELETE FROM secrets WHERE id = ? AND kind != 'variable'")
        .run(id);
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
