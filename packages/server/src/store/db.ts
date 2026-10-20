import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;
export type Migration = (db: Db) => void;

// MIGRATIONS[n] 把结构从版本 n 升到 n+1；版本号 = 已执行的迁移数。
export const MIGRATIONS: Migration[] = [
  (db) =>
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         name TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ),
  // 工作台布局文档（单行）与已存布局；文档是不透明 JSON，revision 用于多端写入的乐观并发。
  (db) =>
    db.exec(
      `CREATE TABLE workbench (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         revision INTEGER NOT NULL,
         document TEXT NOT NULL
       );
       CREATE TABLE saved_layouts (
         id TEXT PRIMARY KEY,
         revision INTEGER NOT NULL,
         document TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
    ),
  // 最小 workspace（仅本机）；会话的 workspace_id 可空，空值读作默认 workspace。
  // meta 存持久化标记（如默认 workspace 已登记过），避免删空后重启又补登记。
  (db) =>
    db.exec(
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE workspaces (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         path TEXT NOT NULL UNIQUE,
         environment_id TEXT NOT NULL DEFAULT 'local',
         tier TEXT NOT NULL DEFAULT 'rules',
         created_at TEXT NOT NULL
       );
       ALTER TABLE sessions ADD COLUMN workspace_id TEXT`,
    ),
  // 已记住的权限规则；随 workspace 级联删除（需 foreign_keys 开启）。
  (db) =>
    db.exec(
      `CREATE TABLE permission_rules (
         id TEXT PRIMARY KEY,
         workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
         kind TEXT NOT NULL,
         access TEXT,
         value TEXT NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE(workspace_id, kind, access, value)
       )`,
    ),
  // 会话级审核策略覆盖（ADR-0031），可空。
  (db) => db.exec("ALTER TABLE sessions ADD COLUMN review_policy TEXT"),
  // 密码库与 ssh 环境（ADR-0033）。secrets 被环境引用时外键拒绝删除。
  (db) =>
    db.exec(
      `CREATE TABLE secrets (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         kind TEXT NOT NULL,
         ciphertext BLOB NOT NULL,
         created_at TEXT NOT NULL
       );
       CREATE TABLE environments (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         host TEXT NOT NULL,
         port INTEGER NOT NULL DEFAULT 22,
         username TEXT NOT NULL,
         os TEXT NOT NULL DEFAULT 'posix',
         secret_id TEXT REFERENCES secrets(id),
         created_at TEXT NOT NULL
       )`,
    ),
  // workspace 唯一性改为 (environment_id, path)（ADR-0034）。重建表保留数据。
  (db) => {
    db.exec(
      `CREATE TABLE workspaces_new (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         path TEXT NOT NULL,
         environment_id TEXT NOT NULL DEFAULT 'local',
         tier TEXT NOT NULL DEFAULT 'rules',
         created_at TEXT NOT NULL,
         UNIQUE(environment_id, path)
       );
       INSERT INTO workspaces_new SELECT * FROM workspaces;
       DROP TABLE workspaces;
       ALTER TABLE workspaces_new RENAME TO workspaces`,
    );
  },
  // 执行审计日志，只追加；id 自增兼作分页游标。不外键到 sessions：会话删除后审计仍保留。
  (db) =>
    db.exec(
      `CREATE TABLE audit_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         session_id TEXT,
         actor TEXT NOT NULL,
         kind TEXT NOT NULL,
         environment_id TEXT,
         summary TEXT NOT NULL,
         detail TEXT
       );
       CREATE INDEX audit_log_session ON audit_log(session_id, id);
       CREATE INDEX audit_log_kind ON audit_log(kind, id)`,
    ),
  // 提示词块（ADR-0009）；workspace 是否注入项目 AGENTS.md；会话创建时拼好的提示词快照。
  (db) =>
    db.exec(
      `CREATE TABLE prompt_blocks (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         grp TEXT NOT NULL,
         dimension TEXT,
         content TEXT NOT NULL,
         version INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE TABLE agents (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         description TEXT NOT NULL,
         prompt_blocks TEXT NOT NULL,
         capabilities TEXT NOT NULL,
         model TEXT,
         thinking_level TEXT,
         default_mode TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       ALTER TABLE workspaces ADD COLUMN inject_conventions INTEGER NOT NULL DEFAULT 1;
       ALTER TABLE sessions ADD COLUMN prompt_text TEXT;
       ALTER TABLE sessions ADD COLUMN agent_id TEXT;
       ALTER TABLE sessions ADD COLUMN mode TEXT`,
    ),
];

export const DB_FILE = "yuanshu.db";

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function backupPath(file: string, version: number): string {
  const base = `${file}.bak-v${version}`;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

// 打开数据库：独占锁 → 版本检查（高于代码则拒绝）→ 备份 → 逐步事务迁移。
export function openDatabase(
  dataDir: string,
  migrations: Migration[] = MIGRATIONS,
): Db {
  const file = path.join(dataDir, DB_FILE);
  let db: Db;
  try {
    // 独占锁在第一次读写时才真正获取；超时调短，让第二个实例立刻失败而不是干等。
    db = new Database(file, { timeout: 200 });
    db.pragma("locking_mode = EXCLUSIVE");
    db.pragma("foreign_keys = ON");
    db.exec("BEGIN EXCLUSIVE; COMMIT");
  } catch (err) {
    throw new Error(
      `无法打开数据库 ${file}（${reason(err)}）；可能有另一个 Server 正在使用同一数据目录`,
    );
  }
  try {
    const current = db.pragma("user_version", { simple: true }) as number;
    const target = migrations.length;
    if (current > target) {
      throw new Error(
        `数据库结构版本 ${current} 高于本程序支持的版本 ${target}，请升级程序；未做任何修改`,
      );
    }
    if (current < target) {
      const hasData = db
        .prepare("SELECT count(*) AS n FROM sqlite_master")
        .get() as {
        n: number;
      };
      if (hasData.n > 0) copyFileSync(file, backupPath(file, current));
      // 重建表的迁移需要外键关闭（事务内无法切换，且 DROP 会触发级联删除）；迁完校验再恢复。
      db.pragma("foreign_keys = OFF");
      try {
        for (let v = current; v < target; v++) {
          db.transaction(() => {
            migrations[v]?.(db);
            db.pragma(`user_version = ${v + 1}`);
          })();
        }
        const bad = db.pragma("foreign_key_check") as unknown[];
        if (bad.length > 0)
          throw new Error(`迁移后外键校验失败（${bad.length} 处）`);
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
    return db;
  } catch (err) {
    db.close();
    throw err instanceof Error ? err : new Error(reason(err));
  }
}
