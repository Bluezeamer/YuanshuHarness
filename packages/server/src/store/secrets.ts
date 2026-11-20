import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { uuidv7 } from "../id.js";
import type { MaskVar } from "../permission/masking.js";
import type { Db } from "./db.js";
import { seal, unseal } from "./seal.js";

export const SECRET_KINDS = ["ssh_key", "password"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export const isSecretKind = (v: unknown): v is SecretKind =>
  typeof v === "string" && (SECRET_KINDS as readonly string[]).includes(v);

export const KEY_FILE = "secret.key";
const VALUE_MAX = 16 * 1024;

// 变量值类型（S4b）：文本值或文件（内容加密，带元数据）。
export const VALUE_KINDS = ["text", "file"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];
export const isValueKind = (v: unknown): v is ValueKind =>
  typeof v === "string" && (VALUE_KINDS as readonly string[]).includes(v);

export interface FileMeta {
  name: string;
  bytes: number;
  lines: number;
  sha256: string;
}

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

export const VAR_POLICIES = ["allow", "ask", "deny"] as const;
export type VarPolicy = (typeof VAR_POLICIES)[number];
export const isVarPolicy = (v: unknown): v is VarPolicy =>
  typeof v === "string" && (VAR_POLICIES as readonly string[]).includes(v);

export type VarExpiry =
  | { kind: "days"; days: number }
  | { kind: "at"; at: string }
  | { kind: "never" };

// 占位符名（旧文法）：字母开头，字母数字下划线，同时是合法的 shell 变量名片段。
export const VAR_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// 新文法（S4b）只用于新契约的新建；含 . 和 - 的名字不是 shell 变量名，`@name` 占位符识别不到它们。
export const VAR_NAME_NEW_RE = /^[a-z][a-z0-9_.-]{2,47}$/;
// 旧变量原样保留，所以 PATCH 改名与读取时两种文法都认。
export const isVarName = (v: unknown): v is string =>
  typeof v === "string" && (VAR_NAME_RE.test(v) || VAR_NAME_NEW_RE.test(v));
// 登记下限与遮罩下限：短于遮罩下限的值（如 sudo 密码）可登记，但输出回显不做替换。
export const VAR_VALUE_MIN = 4;
export const MASK_MIN = 8;
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const PURPOSE_MAX = 500;
// 每次工具调用都要对全部变量值做匹配，规模必须有界。
export const VAR_COUNT_MAX = 64;
export const VAR_TOTAL_MAX = 256 * 1024;

const totalBytes = (vars: readonly { value: string }[]) =>
  vars.reduce((n, v) => n + Buffer.byteLength(v.value), 0);

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
  // 所属变量组；null = 不属于任何组。组没有独立实体，靠变量上的组名长出来。
  group: string | null;
  // 权限层读这三项做引用裁决；存储层总会填，旧测试里手写的元数据可以缺省（视为 allow / never）。
  policy?: VarPolicy;
  expiry?: VarExpiry;
  rotatedAt?: string | null;
}

/** 存储层带出的完整记录（不含值）。lastUsedAt 不进读缓存，单独现查。 */
export interface VariableRecord extends VariableMeta {
  policy: VarPolicy;
  expiry: VarExpiry;
  rotatedAt: string | null;
  kind: ValueKind;
  file: FileMeta | null;
  /** text 型：遮罩后的值，不泄露长度以外的信息；file 型为 null。 */
  valueMasked: string | null;
  lastUsedAt: string | null;
}

type CachedVar = Omit<VariableRecord, "lastUsedAt">;

export interface VariableInput {
  name: string;
  purpose: string;
  scopeKind: ScopeKind;
  scopeTarget: string | null;
  tier: VarTier;
  value: string;
  kind?: ValueKind;
  /** file 型的文件名；大小、行数、指纹由 Server 按内容算。 */
  fileName?: string;
  policy?: VarPolicy;
  expiry?: VarExpiry;
  group?: string | null;
}

type VarRow = Row & {
  purpose: string | null;
  scope_kind: string;
  scope_target: string | null;
  tier: string;
  ciphertext: Buffer;
  value_kind: string;
  file_meta: string | null;
  policy: string;
  expiry: string | null;
  rotated_at: string | null;
  var_group: string | null;
};

const FILE_NAME_MAX = 255;
const GROUP_MAX = 32;
const DAYS_MAX = 3650;
const DAY_MS = 86_400_000;

/** 到期时刻；永久有效为 null。days 从最近一次写入值（rotatedAt，缺省 createdAt）起滚动算。 */
export function expiresAt(
  m: Pick<VariableMeta, "expiry" | "rotatedAt" | "createdAt">,
): number | null {
  const e = m.expiry;
  if (!e || e.kind === "never") return null;
  if (e.kind === "at") return Date.parse(e.at);
  return Date.parse(m.rotatedAt ?? m.createdAt) + e.days * DAY_MS;
}

export const isExpired = (
  m: Pick<VariableMeta, "expiry" | "rotatedAt" | "createdAt">,
  now = Date.now(),
): boolean => {
  const at = expiresAt(m);
  return at !== null && at <= now;
};

// 长值留末四位方便人工核对；短值只给定长的点，不泄露任何字符。
function maskValue(v: string): string {
  return v.length >= 16 ? `••••••••${v.slice(-4)}` : "••••••••";
}

function fileMetaOf(name: string, content: string): FileMeta {
  const lines =
    content === ""
      ? 0
      : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return {
    name,
    bytes: Buffer.byteLength(content),
    lines,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export const checkExpiry = (e: unknown): e is VarExpiry => {
  if (typeof e !== "object" || e === null) return false;
  const x = e as Record<string, unknown>;
  if (x.kind === "never") return true;
  if (x.kind === "days")
    return (
      Number.isInteger(x.days) &&
      (x.days as number) >= 1 &&
      (x.days as number) <= DAYS_MAX
    );
  return (
    x.kind === "at" &&
    typeof x.at === "string" &&
    !Number.isNaN(Date.parse(x.at))
  );
};

// 组名：trim 后 1–32 个字符、不含控制字符；null 表示不属于任何组。
export const cleanGroup = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const g = v.trim();
  return g.length >= 1 && g.length <= GROUP_MAX && !/\p{Cc}/u.test(g)
    ? g
    : null;
};

// 校验范围与长度；返回错误码或 null。value 缺省（编辑时不改值）则不检查长度。
// strictName：新契约（请求带 desc）的新建只收新文法。
export function checkVariable(
  v: Partial<VariableInput>,
  needValue: boolean,
  strictName = false,
): string | null {
  if (v.name !== undefined) {
    // 新建（needValue）按契约二选一：新契约只收新文法，旧契约只收旧文法；
    // 编辑（PATCH 改名）两种都认，旧变量不强迁。
    const okName = strictName
      ? typeof v.name === "string" && VAR_NAME_NEW_RE.test(v.name)
      : needValue
        ? typeof v.name === "string" && VAR_NAME_RE.test(v.name)
        : isVarName(v.name);
    if (!okName) return "invalid_name";
  }
  if (v.purpose !== undefined && v.purpose.length > PURPOSE_MAX)
    return "invalid_purpose";
  if (v.kind !== undefined && !isValueKind(v.kind)) return "invalid_kind";
  if (v.policy !== undefined && !isVarPolicy(v.policy)) return "invalid_policy";
  if (v.expiry !== undefined && !checkExpiry(v.expiry)) return "invalid_expiry";
  if (
    v.fileName !== undefined &&
    (typeof v.fileName !== "string" ||
      v.fileName === "" ||
      v.fileName.length > FILE_NAME_MAX ||
      /[\\/\0]/.test(v.fileName))
  )
    return "invalid_file";
  if (needValue && v.kind === "file" && v.fileName === undefined)
    return "invalid_file";
  if (v.group !== undefined && v.group !== null && cleanGroup(v.group) === null)
    return "invalid_group";
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

  private varRows(where = "", ...args: string[]): VarRow[] {
    return this.db
      .prepare(
        `SELECT id, name, kind, created_at, purpose, scope_kind, scope_target, tier, ciphertext,
                value_kind, file_meta, policy, expiry, rotated_at, var_group
         FROM secrets WHERE kind = 'variable' ${where} ORDER BY name`,
      )
      .all(...args) as VarRow[];
  }

  // 解密结果按写入失效：密码表只经本类写入，读路径（每次工具调用都会取变量与遮罩清单）不再重复解密。
  private snap: {
    vars: { name: string; meta: CachedVar; value: string }[];
    mask?: readonly MaskVar[];
  } | null = null;

  private snapshot() {
    this.snap ??= {
      vars: this.varRows().map((r) => {
        const value = this.decrypt(r.ciphertext);
        const kind = r.value_kind as ValueKind;
        return {
          name: r.name,
          value,
          meta: {
            id: r.id,
            name: r.name,
            purpose: r.purpose ?? "",
            scopeKind: r.scope_kind as ScopeKind,
            scopeTarget: r.scope_target,
            tier: r.tier as VarTier,
            maskable: value.length >= MASK_MIN,
            createdAt: r.created_at,
            policy: r.policy as VarPolicy,
            expiry: r.expiry
              ? (JSON.parse(r.expiry) as VarExpiry)
              : { kind: "never" },
            rotatedAt: r.rotated_at,
            kind,
            file: r.file_meta ? (JSON.parse(r.file_meta) as FileMeta) : null,
            valueMasked: kind === "text" ? maskValue(value) : null,
            group: r.var_group,
          },
        };
      }),
    };
    return this.snap;
  }

  listVariables(): VariableMeta[] {
    return this.snapshot().vars.map((v) => v.meta);
  }

  getVariable(id: string): VariableMeta | null {
    return this.snapshot().vars.find((v) => v.meta.id === id)?.meta ?? null;
  }

  // 带 lastUsedAt 的完整记录。last_used_at 每次引用都会写，所以不进读缓存，这里现查一次。
  listVariableRecords(): VariableRecord[] {
    const used = new Map(
      (
        this.db
          .prepare(
            "SELECT id, last_used_at FROM secrets WHERE kind = 'variable'",
          )
          .all() as { id: string; last_used_at: string | null }[]
      ).map((r) => [r.id, r.last_used_at]),
    );
    return this.snapshot().vars.map((v) => ({
      ...v.meta,
      lastUsedAt: used.get(v.meta.id) ?? null,
    }));
  }

  getVariableRecord(id: string): VariableRecord | null {
    return this.listVariableRecords().find((v) => v.id === id) ?? null;
  }

  /** 取明文，仅供 reveal 接口。 */
  revealVariable(id: string): { meta: CachedVar; value: string } | null {
    const v = this.snapshot().vars.find((x) => x.meta.id === id);
    return v ? { meta: v.meta, value: v.value } : null;
  }

  /** 引用成功时记最近使用时间。不清读缓存：它不影响值和元数据。 */
  touchVariable(name: string, at: string): void {
    this.db
      .prepare(
        "UPDATE secrets SET last_used_at = ? WHERE name = ? AND kind = 'variable'",
      )
      .run(at, name);
  }

  // 同一版本的清单返回同一个数组，调用方可据此复用编译好的匹配器。
  maskVars(): readonly MaskVar[] {
    const s = this.snapshot();
    s.mask ??= [
      ...s.vars,
      ...(
        this.db
          .prepare(
            "SELECT name, ciphertext FROM secrets WHERE kind != 'variable' ORDER BY name",
          )
          .all() as { name: string; ciphertext: Buffer }[]
      ).flatMap((r) => {
        try {
          return [
            {
              name: r.name,
              value: this.decrypt(r.ciphertext),
              label: `[凭据 ${r.name}]`,
            },
          ];
        } catch {
          // 解不开的行谁也用不了（reveal 同样会抛），不能因此让每次工具调用都失败。
          return [];
        }
      }),
    ];
    return s.mask;
  }

  // 数量或总明文大小超限返回 "limit"；名称与现有凭据/变量重名返回 null；输入需已通过 checkVariable。
  createVariable(v: VariableInput): VariableMeta | null | "limit" {
    const cur = this.snapshot().vars;
    if (
      cur.length >= VAR_COUNT_MAX ||
      totalBytes(cur) + Buffer.byteLength(v.value) > VAR_TOTAL_MAX
    )
      return "limit";
    const id = uuidv7();
    const createdAt = new Date().toISOString();
    const kind = v.kind ?? "text";
    try {
      this.db
        .prepare(
          `INSERT INTO secrets (id, name, kind, ciphertext, created_at, purpose, scope_kind, scope_target, tier,
                                value_kind, file_meta, policy, expiry, rotated_at, var_group)
           VALUES (?, ?, 'variable', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          kind,
          kind === "file"
            ? JSON.stringify(fileMetaOf(v.fileName as string, v.value))
            : null,
          v.policy ?? "allow",
          JSON.stringify(v.expiry ?? { kind: "never" }),
          createdAt,
          v.group == null ? null : cleanGroup(v.group),
        );
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
        return null;
      throw err;
    }
    this.snap = null;
    return this.getVariable(id);
  }

  // 部分更新；value 缺省则保留原值。不存在返回 undefined，重名返回 null，超限返回 "limit"。
  updateVariable(
    id: string,
    patch: Partial<VariableInput>,
  ): VariableMeta | null | undefined | "limit" {
    const cur = this.varRows("AND id = ?", id)[0];
    if (!cur) return undefined;
    const oldVal = this.decrypt(cur.ciphertext);
    const newValBytes = patch.value
      ? Buffer.byteLength(patch.value) - Buffer.byteLength(oldVal)
      : 0;
    if (newValBytes > 0) {
      const all = this.snapshot().vars;
      if (totalBytes(all) + newValBytes > VAR_TOTAL_MAX) return "limit";
    }
    const scopeKind = patch.scopeKind ?? (cur.scope_kind as ScopeKind);
    const scopeTarget =
      patch.scopeKind !== undefined
        ? (patch.scopeTarget ?? null)
        : cur.scope_target;
    // 类型在创建时定下，不随 PATCH 改；换值（含轮换）重算文件元数据并重置 days 的起算点。
    const fileMeta =
      cur.value_kind === "file" && patch.value !== undefined
        ? JSON.stringify(
            fileMetaOf(
              patch.fileName ??
                (JSON.parse(cur.file_meta as string) as FileMeta).name,
              patch.value,
            ),
          )
        : cur.file_meta;
    try {
      this.db
        .prepare(
          `UPDATE secrets SET name = ?, purpose = ?, scope_kind = ?, scope_target = ?, tier = ?, ciphertext = ?,
                              file_meta = ?, policy = ?, expiry = ?, rotated_at = ?, var_group = ?
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
          fileMeta,
          patch.policy ?? cur.policy,
          patch.expiry === undefined
            ? cur.expiry
            : JSON.stringify(patch.expiry),
          patch.value === undefined ? cur.rotated_at : new Date().toISOString(),
          patch.group === undefined
            ? cur.var_group
            : patch.group === null
              ? null
              : cleanGroup(patch.group),
          id,
        );
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
        return null;
      throw err;
    }
    this.snap = null;
    return this.getVariable(id);
  }

  // 改组名：改名到已存在的组名就是合并。返回受影响的行数；to 不合法抛 RangeError（API 层先校验）。
  renameVariableGroup(from: string, to: string): number {
    const name = cleanGroup(to);
    if (name === null) throw new RangeError("group name out of range");
    const n = this.db
      .prepare(
        "UPDATE secrets SET var_group = ? WHERE var_group = ? AND kind = 'variable'",
      )
      .run(name, from).changes;
    if (n > 0) this.snap = null;
    return n;
  }

  // 解散组：把成员的组名清空；返回受影响的行数。
  dissolveVariableGroup(name: string): number {
    const n = this.db
      .prepare(
        "UPDATE secrets SET var_group = NULL WHERE var_group = ? AND kind = 'variable'",
      )
      .run(name).changes;
    if (n > 0) this.snap = null;
    return n;
  }

  removeVariable(id: string): boolean {
    const ok =
      this.db
        .prepare("DELETE FROM secrets WHERE id = ? AND kind = 'variable'")
        .run(id).changes > 0;
    if (ok) this.snap = null;
    return ok;
  }

  // 仅 Server 内部用：占位符替换与输出遮罩需要全部变量的真值。绝不经 REST 返回。
  variableValues(): { name: string; meta: VariableMeta; value: string }[] {
    return this.snapshot().vars;
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
    this.snap = null;
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

  // 其他存储里的引用（模型的 API key、MCP 的 env/headers）不在外键里，由它们登记检查；
  // 返回 true 表示该凭据仍被引用。
  private referrers: Array<(id: string) => boolean> = [];

  addReferrer(inUse: (id: string) => boolean): void {
    this.referrers.push(inUse);
  }

  // 被环境（外键）或登记的引用方使用时返回 "in_use"。
  remove(id: string): "ok" | "not_found" | "in_use" {
    if (this.referrers.some((f) => f(id))) return "in_use";
    try {
      const r = this.db
        .prepare("DELETE FROM secrets WHERE id = ? AND kind != 'variable'")
        .run(id);
      if (r.changes === 0) return "not_found";
      this.snap = null;
      return "ok";
    } catch (err) {
      if ((err as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT"))
        return "in_use";
      throw err;
    }
  }

  private encrypt(plain: string): Buffer {
    return seal(this.key, plain);
  }

  private decrypt(blob: Buffer): string {
    return unseal(this.key, blob);
  }
}
