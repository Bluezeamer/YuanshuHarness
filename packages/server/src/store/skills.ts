import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseOrigin, type SkillSource } from "../skills/source.js";
import {
  checkSkillMd,
  hashFiles,
  SKILL_FILE,
  type SkillFile,
  safeRelPath,
  sizeProblem,
} from "../skills/spec.js";
import type { Db } from "./db.js";

export const SCOPES = ["global", "project"] as const;
export type SkillScope = (typeof SCOPES)[number];
export const isScope = (v: unknown): v is SkillScope =>
  typeof v === "string" && (SCOPES as readonly string[]).includes(v);

export interface SkillMeta {
  name: string;
  description: string;
  scope: SkillScope;
  // "local" = Server 上新建；"env:<环境名>" = 从环境纳入。
  source: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

// 同步只需要 SkillMeta；库里还记着版本、锁定、来源、启用与上次查到的候选版本。
export interface SkillRecord extends SkillMeta {
  // npm 为包版本，git 为 ref；dir / observed / 手写 skill 不跟踪版本。
  version: string | null;
  // 锁定后库版本固定在此，一切自动行为（更新、补齐）以它为上限。
  lockedVersion: string | null;
  // 手写与旧版「纳入」的副本没有结构化来源。
  origin: SkillSource | null;
  enabled: boolean;
  // 上次向来源查询得到的最新版与候选列表（新到旧），列表接口不联网，靠它判断「可更新」。
  latestVersion: string | null;
  versions: string[];
  checkedAt: string | null;
}

type Row = {
  name: string;
  description: string;
  scope: string;
  source: string;
  hash: string;
  created_at: string;
  updated_at: string;
  version: string | null;
  locked_version: string | null;
  origin: string | null;
  enabled: number;
  latest_version: string | null;
  versions: string | null;
  checked_at: string | null;
};
const toRecord = (r: Row): SkillRecord => ({
  name: r.name,
  description: r.description,
  scope: r.scope as SkillScope,
  source: r.source,
  hash: r.hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
  lockedVersion: r.locked_version,
  origin: parseOrigin(r.origin),
  enabled: r.enabled !== 0,
  latestVersion: r.latest_version,
  versions: r.versions ? (JSON.parse(r.versions) as string[]) : [],
  checkedAt: r.checked_at,
});

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

// skill 库（ADR-0055）：文件在 <dir>/<name>/，元数据在 SQLite；描述与哈希随文件变化重算。
export class SkillStore {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {}

  list(): SkillRecord[] {
    return (
      this.db.prepare("SELECT * FROM skills ORDER BY name").all() as Row[]
    ).map(toRecord);
  }

  get(name: string): SkillRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM skills WHERE name = ?")
      .get(name) as Row | undefined;
    return r && toRecord(r);
  }

  private skillDir(name: string) {
    return path.join(this.dir, name);
  }

  // 库里某个 skill 的全部文件（跳过符号链接与点开头的目录项）。
  files(name: string): SkillFile[] {
    const root = this.skillDir(name);
    const out: SkillFile[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const r = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile())
          out.push({ path: r, content: readFileSync(path.join(dir, e.name)) });
      }
    };
    walk(root, "");
    return out;
  }

  // 校验整套文件（SKILL.md、体量）；通过返回描述。
  private check(name: string, files: SkillFile[]): Result<string> {
    const md = files.find((f) => f.path === SKILL_FILE);
    if (!md) return fail(`缺少 ${SKILL_FILE}`);
    const check = checkSkillMd(name, md.content.toString("utf8"));
    if (check.errors.length > 0) return fail(check.errors.join("；"));
    const big = sizeProblem(files);
    if (big) return fail(big);
    return { ok: true, value: check.description ?? "" };
  }

  // 整套文件先写到临时目录再改名，失败不留半成品；已有同名目录被整体替换。
  private writeDir(name: string, files: SkillFile[]): Result<true> {
    // 惰性建目录：没人用 skill 时数据目录里不多出空目录。
    mkdirSync(this.dir, { recursive: true });
    const tmp = mkdtempSync(path.join(this.dir, ".tmp-"));
    try {
      for (const f of files) {
        const rel = safeRelPath(f.path);
        if (!rel) {
          rmSync(tmp, { recursive: true, force: true });
          return fail(`非法文件路径：${f.path}`);
        }
        const target = path.join(tmp, rel);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, f.content);
      }
      rmSync(this.skillDir(name), { recursive: true, force: true });
      renameSync(tmp, this.skillDir(name));
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    return { ok: true, value: true };
  }

  // 新建；origin / version 由安装流程给出，手写与旧版纳入的没有。
  create(
    name: string,
    scope: SkillScope,
    source: string,
    files: SkillFile[],
    extra: { version?: string | null; origin?: SkillSource | null } = {},
  ): Result<SkillRecord> {
    if (this.get(name)) return fail("同名 skill 已存在");
    const checked = this.check(name, files);
    if (!checked.ok) return checked;
    const written = this.writeDir(name, files);
    if (!written.ok) return written;
    return this.insert(
      name,
      scope,
      source,
      checked.value,
      hashFiles(files),
      extra,
    );
  }

  // 原地登记（observed）：内容留在环境里，库只记元数据，不写文件。
  register(
    name: string,
    scope: SkillScope,
    source: string,
    description: string,
    hash: string,
    origin: SkillSource,
  ): Result<SkillRecord> {
    if (this.get(name)) return fail("同名 skill 已存在");
    return this.insert(name, scope, source, description, hash, {
      origin,
      version: null,
    });
  }

  private insert(
    name: string,
    scope: SkillScope,
    source: string,
    description: string,
    hash: string,
    extra: { version?: string | null; origin?: SkillSource | null },
  ): Result<SkillRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO skills (name, description, scope, source, hash, created_at, updated_at, version, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        description,
        scope,
        source,
        hash,
        now,
        now,
        extra.version ?? null,
        extra.origin ? JSON.stringify(extra.origin) : null,
      );
    return { ok: true, value: this.get(name) as SkillRecord };
  }

  // 更新 / 锁定到某版本：整套文件换成来源里的新内容，同时记下版本。
  replace(
    name: string,
    files: SkillFile[],
    patch: {
      version: string | null;
      latestVersion?: string | null;
      origin?: SkillSource;
    },
  ): Result<SkillRecord> {
    if (!this.get(name)) return fail("skill 不存在");
    const checked = this.check(name, files);
    if (!checked.ok) return checked;
    const written = this.writeDir(name, files);
    if (!written.ok) return written;
    this.db
      .prepare(
        `UPDATE skills SET description = ?, hash = ?, version = ?,
           latest_version = COALESCE(?, latest_version), origin = COALESCE(?, origin),
           updated_at = ? WHERE name = ?`,
      )
      .run(
        checked.value,
        hashFiles(files),
        patch.version,
        patch.latestVersion ?? null,
        patch.origin ? JSON.stringify(patch.origin) : null,
        new Date().toISOString(),
        name,
      );
    return { ok: true, value: this.get(name) as SkillRecord };
  }

  // observed 的内容在环境里，描述与哈希随原件刷新。
  setObserved(name: string, description: string, hash: string): void {
    this.db
      .prepare(
        "UPDATE skills SET description = ?, hash = ?, updated_at = ? WHERE name = ?",
      )
      .run(description, hash, new Date().toISOString(), name);
  }

  setLocked(name: string, version: string | null): void {
    this.db
      .prepare("UPDATE skills SET locked_version = ? WHERE name = ?")
      .run(version, name);
  }

  setEnabled(name: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE skills SET enabled = ? WHERE name = ?")
      .run(enabled ? 1 : 0, name);
  }

  // 记下向来源查到的候选版本（新到旧）；列表接口靠它判断「可更新」。
  setVersions(name: string, versions: string[]): void {
    this.db
      .prepare(
        "UPDATE skills SET latest_version = ?, versions = ?, checked_at = ? WHERE name = ?",
      )
      .run(
        versions[0] ?? null,
        JSON.stringify(versions),
        new Date().toISOString(),
        name,
      );
  }

  // 目标路径必须落在 skill 目录内（含符号链接解析后）。
  private inside(name: string, rel: string): string | null {
    const safe = safeRelPath(rel);
    if (!safe) return null;
    const root = realpathSync(this.skillDir(name));
    const target = path.join(root, safe);
    let probe = path.dirname(target);
    while (probe.length > root.length) {
      try {
        probe = realpathSync(probe);
        break;
      } catch {
        probe = path.dirname(probe);
      }
    }
    return probe === root || probe.startsWith(root + path.sep) ? target : null;
  }

  readFile(name: string, rel: string): Buffer | null {
    if (!this.get(name)) return null;
    const target = this.inside(name, rel);
    if (!target) return null;
    try {
      return lstatSync(target).isFile() ? readFileSync(target) : null;
    } catch {
      return null;
    }
  }

  // 写入单个文件；写 SKILL.md 时先校验，不合规不落盘。
  writeFile(name: string, rel: string, content: Buffer): Result<SkillRecord> {
    if (!this.get(name)) return fail("skill 不存在");
    const target = this.inside(name, rel);
    if (!target) return fail("非法文件路径");
    if (rel === SKILL_FILE) {
      const check = checkSkillMd(name, content.toString("utf8"));
      if (check.errors.length > 0) return fail(check.errors.join("；"));
    }
    const next = [
      ...this.files(name).filter((f) => f.path !== rel),
      { path: rel, content },
    ];
    const big = sizeProblem(next);
    if (big) return fail(big);
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    } catch {
      return fail("无法写入该路径（与已有文件冲突？）");
    }
    return { ok: true, value: this.refresh(name) };
  }

  removeFile(name: string, rel: string): Result<SkillRecord> {
    if (!this.get(name)) return fail("skill 不存在");
    if (rel === SKILL_FILE) return fail(`不能删除 ${SKILL_FILE}`);
    const target = this.inside(name, rel);
    if (!target) return fail("非法文件路径");
    rmSync(target, { force: true });
    return { ok: true, value: this.refresh(name) };
  }

  // 按磁盘内容重算描述与哈希。
  private refresh(name: string): SkillRecord {
    const files = this.files(name);
    const md = files.find((f) => f.path === SKILL_FILE);
    const description =
      checkSkillMd(name, md?.content.toString("utf8") ?? "").description ?? "";
    this.db
      .prepare(
        "UPDATE skills SET description = ?, hash = ?, updated_at = ? WHERE name = ?",
      )
      .run(description, hashFiles(files), new Date().toISOString(), name);
    return this.get(name) as SkillRecord;
  }

  setScope(name: string, scope: SkillScope): SkillRecord | undefined {
    this.db
      .prepare("UPDATE skills SET scope = ?, updated_at = ? WHERE name = ?")
      .run(scope, new Date().toISOString(), name);
    return this.get(name);
  }

  remove(name: string): boolean {
    const r = this.db.prepare("DELETE FROM skills WHERE name = ?").run(name);
    if (r.changes === 0) return false;
    this.db
      .prepare(
        "DELETE FROM workspace_capabilities WHERE kind = 'skill' AND name = ?",
      )
      .run(name);
    rmSync(this.skillDir(name), { recursive: true, force: true });
    return true;
  }
}
