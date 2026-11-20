// 卡片库：提示词的来源。预设只引用卡片 id，改一处所有引用生效。
//
// 内置卡片（「默认行为构建」里的基线卡与内置 agent 的卡片）只读，只能"复制后编辑"；
// 用户新建的卡片可改。
import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

export const CARD_TITLE_MAX = 100;
export const CARD_GROUP_MAX = 50;
export const CARD_BODY_MAX = 100_000;

/** 卡片来源：pi 原生 / 我们自带 / 用户新建 */
export type CardOrigin = "pi" | "ours" | "user";

export interface PromptCard {
  id: string;
  group: string;
  title: string;
  body: string;
  /** 内置卡片只读 */
  builtin: boolean;
  origin: CardOrigin;
  /** 从哪张卡复制来的 */
  copyOf: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPromptCard {
  id?: string;
  group: string;
  title: string;
  body: string;
  builtin?: boolean;
  origin?: CardOrigin;
  copyOf?: string | null;
}

type Row = {
  id: string;
  grp: string;
  title: string;
  body: string;
  builtin: number;
  origin: string;
  copy_of: string | null;
  created_at: string;
  updated_at: string;
};

const toCard = (r: Row): PromptCard => ({
  id: r.id,
  group: r.grp,
  title: r.title,
  body: r.body,
  builtin: r.builtin === 1,
  origin: r.origin as CardOrigin,
  copyOf: r.copy_of,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();

/** 内置卡片的分组：默认 Agent 的全部卡片都在这里（内置、只读、可复制） */
export const BASELINE_GROUP = "默认行为构建";

/** 内置卡片的分组顺序；其余分组按名字排在后面 */
export const CARD_GROUP_ORDER = [BASELINE_GROUP] as const;

/** 用户单独建的分组名（可以是空的）；有卡片的分组靠卡片自己带的名字出现，不进这份清单 */
const KEY_EXTRA_GROUPS = "card_groups";

export class PromptCardStore {
  constructor(private readonly db: Db) {}

  private extraGroups(): string[] {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(KEY_EXTRA_GROUPS) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as string[]) : [];
  }

  private saveExtraGroups(names: readonly string[]): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY_EXTRA_GROUPS, JSON.stringify(names));
  }

  private hasCards(group: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM prompt_cards WHERE grp = ? LIMIT 1")
        .get(group) !== undefined
    );
  }

  /** 新建一个空分组；同名已存在（有卡片的也算）返回 false */
  addGroup(name: string): boolean {
    const extra = this.extraGroups();
    if (extra.includes(name) || this.hasCards(name)) return false;
    this.saveExtraGroups([...extra, name]);
    return true;
  }

  /** 删分组：里面还有卡片不让删；没有这个分组返回 "not_found" */
  removeGroup(name: string): "ok" | "not_found" | "not_empty" {
    if (this.hasCards(name)) return "not_empty";
    const extra = this.extraGroups();
    if (!extra.includes(name)) return "not_found";
    this.saveExtraGroups(extra.filter((g) => g !== name));
    return "ok";
  }

  list(): PromptCard[] {
    const rows = this.db
      .prepare("SELECT * FROM prompt_cards ORDER BY grp, sort_order, title")
      .all() as Row[];
    return rows.map(toCard);
  }

  /** 分组 → 卡片，按内置分组顺序排列 */
  grouped(): { group: string; cards: PromptCard[] }[] {
    const all = this.list();
    const names = new Set([...all.map((c) => c.group), ...this.extraGroups()]);
    const ordered = [
      ...CARD_GROUP_ORDER.filter((g) => names.has(g)),
      ...[...names]
        .filter((g) => !(CARD_GROUP_ORDER as readonly string[]).includes(g))
        .sort(),
    ];
    return ordered.map((group) => ({
      group,
      cards: all.filter((c) => c.group === group),
    }));
  }

  get(id: string): PromptCard | undefined {
    const row = this.db
      .prepare("SELECT * FROM prompt_cards WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toCard(row) : undefined;
  }

  getMany(ids: readonly string[]): PromptCard[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM prompt_cards WHERE id IN (${marks})`)
      .all(...ids) as Row[];
    const byId = new Map(rows.map((r) => [r.id, toCard(r)]));
    // 保持传入顺序
    return ids.flatMap((id) => {
      const c = byId.get(id);
      return c ? [c] : [];
    });
  }

  create(input: NewPromptCard): PromptCard {
    const at = now();
    const card: PromptCard = {
      id: input.id ?? uuidv7(),
      group: input.group,
      title: input.title,
      body: input.body,
      builtin: input.builtin ?? false,
      origin: input.origin ?? "user",
      copyOf: input.copyOf ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.insert(card);
    return card;
  }

  /** 种子用：固定 id 写入 */
  insert(card: PromptCard): void {
    this.db
      .prepare(
        `INSERT INTO prompt_cards (id, grp, title, body, builtin, origin, copy_of, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.id,
        card.group,
        card.title,
        card.body,
        card.builtin ? 1 : 0,
        card.origin,
        card.copyOf,
        card.createdAt,
        card.updatedAt,
      );
  }

  /**
   * 种子用：不存在就建，存在就按给的字段覆盖（createdAt 不动）。
   * 内置卡片走不了 update，所以随版本更新的内置卡片要经这里覆盖。
   */
  upsert(card: Omit<PromptCard, "createdAt" | "updatedAt">): void {
    if (!this.get(card.id)) {
      this.create({ ...card, id: card.id });
      return;
    }
    this.db
      .prepare(
        "UPDATE prompt_cards SET grp = ?, title = ?, body = ?, builtin = ?, origin = ?, copy_of = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        card.group,
        card.title,
        card.body,
        card.builtin ? 1 : 0,
        card.origin,
        card.copyOf,
        now(),
        card.id,
      );
  }

  /** 内置卡片拒绝修改（返回 null 表示不可改） */
  update(
    id: string,
    patch: Partial<Pick<PromptCard, "group" | "title" | "body">>,
  ): PromptCard | null {
    const cur = this.get(id);
    if (!cur || cur.builtin) return null;
    this.db
      .prepare(
        "UPDATE prompt_cards SET grp = ?, title = ?, body = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.group ?? cur.group,
        patch.title ?? cur.title,
        patch.body ?? cur.body,
        now(),
        id,
      );
    return this.get(id) ?? null;
  }

  /** 重排同一分组内的卡片顺序 */
  reorder(group: string, ids: readonly string[]): void {
    this.db.transaction(() => {
      const stmt = this.db.prepare(
        "UPDATE prompt_cards SET sort_order = ?, updated_at = ? WHERE id = ? AND grp = ?",
      );
      const at = now();
      ids.forEach((id, i) => {
        stmt.run(i, at, id, group);
      });
    })();
  }

  /** 复制一份可编辑的副本（内置卡片走这条路改） */
  copy(id: string): PromptCard | null {
    const src = this.get(id);
    if (!src) return null;
    return this.create({
      group: src.group,
      title: `${src.title}（副本）`,
      body: src.body,
      origin: "user",
      copyOf: src.id,
    });
  }

  remove(id: string): boolean {
    const cur = this.get(id);
    if (!cur || cur.builtin) return false;
    this.db.prepare("DELETE FROM prompt_cards WHERE id = ?").run(id);
    return true;
  }

  count(): number {
    return (
      this.db.prepare("SELECT count(*) AS n FROM prompt_cards").get() as {
        n: number;
      }
    ).n;
  }
}
