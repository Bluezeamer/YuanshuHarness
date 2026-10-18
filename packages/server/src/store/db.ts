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
      for (let v = current; v < target; v++) {
        db.transaction(() => {
          migrations[v]?.(db);
          db.pragma(`user_version = ${v + 1}`);
        })();
      }
    }
    return db;
  } catch (err) {
    db.close();
    throw err instanceof Error ? err : new Error(reason(err));
  }
}
