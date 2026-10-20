import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

// 组装时按这三组固定顺序拼接，其余分组名视为自定义分组，排在它们之后。
export const ROLE_GROUP = "角色定义";
export const GLOBAL_GROUP = "全局约定";
export const PROJECT_GROUP = "项目约定";

export const NAME_MAX = 100;
export const GROUP_MAX = 50;
export const DIMENSION_MAX = 50;
export const CONTENT_MAX = 100_000;

export interface Block {
  id: string;
  name: string;
  group: string;
  dimension: string | null;
  content: string;
  // 每次更新自增；会话快照靠它判断块是否已变。
  version: number;
  createdAt: string;
  updatedAt: string;
}

type Row = {
  id: string;
  name: string;
  grp: string;
  dimension: string | null;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
};
const toBlock = (r: Row): Block => ({
  id: r.id,
  name: r.name,
  group: r.grp,
  dimension: r.dimension,
  content: r.content,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface BlockInput {
  name: string;
  group: string;
  dimension: string | null;
  content: string;
}

export class BlockStore {
  constructor(private readonly db: Db) {}

  list(): Block[] {
    return (
      this.db
        .prepare("SELECT * FROM prompt_blocks ORDER BY created_at, id")
        .all() as Row[]
    ).map(toBlock);
  }

  get(id: string): Block | undefined {
    const r = this.db
      .prepare("SELECT * FROM prompt_blocks WHERE id = ?")
      .get(id) as Row | undefined;
    return r && toBlock(r);
  }

  create(input: BlockInput, now = new Date()): Block {
    const at = now.toISOString();
    const b: Block = {
      id: uuidv7(),
      ...input,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.insert(b);
    return b;
  }

  // 内置种子用固定 id，便于 agent 种子按 id 引用。
  insert(b: Block): void {
    this.db
      .prepare(
        `INSERT INTO prompt_blocks (id, name, grp, dimension, content, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.id,
        b.name,
        b.group,
        b.dimension,
        b.content,
        b.version,
        b.createdAt,
        b.updatedAt,
      );
  }

  update(id: string, patch: Partial<BlockInput>): Block | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    this.db
      .prepare(
        `UPDATE prompt_blocks
         SET name = ?, grp = ?, dimension = ?, content = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? cur.name,
        patch.group ?? cur.group,
        patch.dimension === undefined ? cur.dimension : patch.dimension,
        patch.content ?? cur.content,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM prompt_blocks WHERE id = ?").run(id)
        .changes > 0
    );
  }

  // 首次启动写入内置块并留标记；之后用户删除的块不会再回来。
  seed(blocks: Block[]): void {
    const marked = this.db
      .prepare("SELECT 1 FROM meta WHERE key = 'prompt_blocks_seeded'")
      .get();
    if (marked) return;
    this.db.transaction(() => {
      for (const b of blocks) this.insert(b);
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('prompt_blocks_seeded', '1')",
        )
        .run();
    })();
  }
}
