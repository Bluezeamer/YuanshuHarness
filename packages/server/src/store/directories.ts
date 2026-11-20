import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";
import { ATTACHMENT_ENV_ID, LOCAL_ENV_ID } from "./environments.js";

export const NAME_MAX = 100;

export interface Directory {
  id: string;
  name: string;
  path: string;
  environmentId: string;
  createdAt: string;
}

type Row = {
  id: string;
  name: string;
  path: string;
  environment_id: string;
  created_at: string;
};
const toDirectory = (r: Row): Directory => ({
  id: r.id,
  name: r.name,
  path: r.path,
  environmentId: r.environment_id,
  createdAt: r.created_at,
});

// 登记路径：必须是存在的绝对目录；返回解析符号链接后的路径，否则返回原因。
export function resolveDirectory(
  raw: unknown,
): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || !path.isAbsolute(raw))
    return { ok: false, message: "path 必须是绝对路径" };
  try {
    const real = realpathSync(raw);
    if (!statSync(real).isDirectory())
      return { ok: false, message: "path 不是目录" };
    return { ok: true, path: real };
  } catch {
    return { ok: false, message: "path 不存在或无法访问" };
  }
}

// name 去空白后 1–100 字符；不合规返回 null。
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : null;
}

export class DirectoryStore {
  constructor(private readonly db: Db) {}

  // 用户可见的 directory：隐藏的 attachment directory 不出现在这里（由池按工作区追加给 agent）。
  list(): Directory[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM directories WHERE environment_id != ? ORDER BY created_at, id",
        )
        .all(ATTACHMENT_ENV_ID) as Row[]
    ).map(toDirectory);
  }

  get(id: string): Directory | undefined {
    const r = this.db
      .prepare("SELECT * FROM directories WHERE id = ?")
      .get(id) as Row | undefined;
    return r && toDirectory(r);
  }

  // 最早登记的 directory；会话 directory_id 为空时读作它。附件 directory 不算默认。
  getDefault(): Directory | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM directories WHERE environment_id != ? ORDER BY created_at, id LIMIT 1",
      )
      .get(ATTACHMENT_ENV_ID) as Row | undefined;
    return r && toDirectory(r);
  }

  // 同一主机上名字是否已被占用（`exceptId` 排除自己，改名时用）。附件区的行不参与（它们都叫 attachment）。
  nameTaken(environmentId: string, name: string, exceptId?: string): boolean {
    const r = this.db
      .prepare(
        "SELECT 1 FROM directories WHERE environment_id = ? AND name = ? AND id != ? LIMIT 1",
      )
      .get(environmentId, name, exceptId ?? "") as { 1: number } | undefined;
    return r !== undefined;
  }

  /**
   * 同一主机上可用的名字：没被占用就用本体，否则 `app-2`、`app-3`…（总长不超过 NAME_MAX）。
   * 默认名（路径末段）与首次启动登记的启动目录都走这一处，不留第二套命名逻辑。
   */
  uniqueName(environmentId: string, base: string): string {
    const fit = base.slice(0, NAME_MAX);
    if (!this.nameTaken(environmentId, fit)) return fit;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const head = fit.slice(0, NAME_MAX - suffix.length).trimEnd();
      const name = `${head}${suffix}`;
      if (!this.nameTaken(environmentId, name)) return name;
    }
  }

  getByPath(p: string, environmentId = LOCAL_ENV_ID): Directory | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM directories WHERE path = ? AND environment_id = ?",
      )
      .get(p, environmentId) as Row | undefined;
    return r && toDirectory(r);
  }

  // path 须已解析；同一环境内重复路径返回 null。
  create(
    name: string,
    p: string,
    now = new Date(),
    environmentId = LOCAL_ENV_ID,
  ): Directory | null {
    if (this.getByPath(p, environmentId)) return null;
    const ws: Directory = {
      id: uuidv7(),
      name,
      path: p,
      environmentId,
      createdAt: now.toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO directories (id, name, path, environment_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ws.id, ws.name, ws.path, ws.environmentId, ws.createdAt);
    return ws;
  }

  // 首次启动登记启动目录为默认，并写持久化标记；之后（含删光所有 directory）不再自动登记。
  ensureDefault(startDir: string): Directory | null {
    const marked = this.db
      .prepare("SELECT 1 FROM meta WHERE key = 'default_directory_registered'")
      .get();
    if (marked) return null;
    const mark = () =>
      this.db
        .prepare(
          "INSERT OR IGNORE INTO meta (key, value) VALUES ('default_directory_registered', '1')",
        )
        .run();
    // 已有 directory（迁移前的库）视为已登记过
    if (this.getDefault()) {
      mark();
      return null;
    }
    const dir = resolveDirectory(startDir);
    if (!dir.ok) return null;
    const ws = this.create(
      this.uniqueName(LOCAL_ENV_ID, path.basename(dir.path) || dir.path),
      dir.path,
    );
    if (ws) mark();
    return ws;
  }

  rename(id: string, name: string): Directory | undefined {
    if (!this.get(id)) return undefined;
    this.db
      .prepare("UPDATE directories SET name = ? WHERE id = ?")
      .run(name, id);
    return this.get(id);
  }

  // 已落盘索引里引用该 directory 的会话数；空 directory_id 读作默认，所以计入默认 directory。
  // 工作区挂载另计（见 pool.directoryInUse）。
  sessionCount(id: string): number {
    const isDefault = this.getDefault()?.id === id;
    const r = this.db
      .prepare(
        `SELECT count(*) AS n FROM sessions
         WHERE directory_id = ? OR (? = 1 AND directory_id IS NULL)`,
      )
      .get(id, isDefault ? 1 : 0) as { n: number };
    return r.n;
  }

  // 调用方先检查引用；这里只删。
  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM directories WHERE id = ?").run(id).changes >
      0
    );
  }
}
