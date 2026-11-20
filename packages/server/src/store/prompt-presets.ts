// 预设：卡片按「加载顺序的段」装配成一份提示词。
//
// 每段（node）自带一棵 items：直接挂的卡片与「分组」（switch，见 prompt/items.ts），整段存成一个 JSON 列。
import { uuidv7 } from "../id.js";
import { allCardIds, type PromptItem } from "../prompt/items.js";
import type { Db } from "./db.js";

export const PRESET_NAME_MAX = 100;
export const PRESET_DESCRIPTION_MAX = 5_000;

export type PresetKind =
  | "global-extra"
  | "agent"
  | "mode"
  | "global-agentsmd"
  | "project-agentsmd";
export const PRESET_KINDS: PresetKind[] = [
  "global-extra",
  "agent",
  "mode",
  "global-agentsmd",
  "project-agentsmd",
];

/** 段的种类：custom 可编；system 由 pi 渲染（只读）；system_content 位置保留、内容由我们生成 */
export type SlotKind = "custom" | "system" | "system_content";
/** 注入通道：system 进 system prompt；user 走消息，严格排在所有 system 之后 */
export type Channel = "system" | "user";

export interface PromptNode {
  id: string;
  presetId: string;
  position: number;
  /** 段名；null = identity（走 customPrompt，永远最前） */
  tag: string | null;
  title: string;
  slotKind: SlotKind;
  channel: Channel;
  /** 由 pi 渲染的段，不可增删内容 */
  builtin: boolean;
  items: PromptItem[];
}

export interface PromptPreset {
  id: string;
  kind: PresetKind;
  name: string;
  description: string;
  active: boolean;
  /** 默认能力集合（tool:/skill:/mcp: 前缀的 id）；null = 不限制 */
  capabilities: string[] | null;
  /** 模式的另外两种能力操作（capabilities 对模式即「限定为」）；其他 kind 恒为空 */
  capsAdd: string[];
  capsRemove: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PresetDetail extends PromptPreset {
  nodes: PromptNode[];
}

type PresetRow = {
  id: string;
  kind: string;
  name: string;
  description: string;
  active: number;
  capabilities: string | null;
  caps_add: string | null;
  caps_remove: string | null;
  created_at: string;
  updated_at: string;
};
type NodeRow = {
  id: string;
  preset_id: string;
  position: number;
  tag: string | null;
  title: string;
  slot_kind: string;
  channel: string;
  builtin: number;
  items: string;
};

const toPreset = (r: PresetRow): PromptPreset => ({
  id: r.id,
  kind: r.kind as PresetKind,
  name: r.name,
  description: r.description,
  active: r.active === 1,
  capabilities: r.capabilities
    ? (JSON.parse(r.capabilities) as string[])
    : null,
  capsAdd: r.caps_add ? (JSON.parse(r.caps_add) as string[]) : [],
  capsRemove: r.caps_remove ? (JSON.parse(r.caps_remove) as string[]) : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toNode = (r: NodeRow): PromptNode => ({
  id: r.id,
  presetId: r.preset_id,
  position: r.position,
  tag: r.tag,
  title: r.title,
  slotKind: r.slot_kind as SlotKind,
  channel: r.channel as Channel,
  builtin: r.builtin === 1,
  items: JSON.parse(r.items) as PromptItem[],
});

const now = () => new Date().toISOString();

export class PromptPresetStore {
  constructor(private readonly db: Db) {}

  list(kind?: PresetKind): PromptPreset[] {
    const rows = kind
      ? (this.db
          .prepare(
            "SELECT * FROM prompt_presets WHERE kind = ? ORDER BY created_at, rowid",
          )
          .all(kind) as PresetRow[])
      : (this.db
          .prepare(
            "SELECT * FROM prompt_presets ORDER BY kind, created_at, rowid",
          )
          .all() as PresetRow[]);
    return rows.map(toPreset);
  }

  get(id: string): PromptPreset | undefined {
    const r = this.db
      .prepare("SELECT * FROM prompt_presets WHERE id = ?")
      .get(id) as PresetRow | undefined;
    return r ? toPreset(r) : undefined;
  }

  /** 当前生效的附加提示词（只有一张生效） */
  activeExtra(): PromptPreset | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM prompt_presets WHERE kind = 'global-extra' AND active = 1 LIMIT 1",
      )
      .get() as PresetRow | undefined;
    return r ? toPreset(r) : undefined;
  }

  detail(id: string): PresetDetail | undefined {
    const preset = this.get(id);
    if (!preset) return undefined;
    const nodes = (
      this.db
        .prepare(
          "SELECT * FROM prompt_nodes WHERE preset_id = ? ORDER BY position",
        )
        .all(id) as NodeRow[]
    ).map(toNode);
    return { ...preset, nodes };
  }

  create(input: {
    id?: string;
    kind: PresetKind;
    name: string;
    description?: string;
    capabilities?: string[] | null;
    capsAdd?: string[];
    capsRemove?: string[];
  }): PromptPreset {
    const at = now();
    const preset: PromptPreset = {
      id: input.id ?? uuidv7(),
      kind: input.kind,
      name: input.name,
      description: input.description ?? "",
      active: false,
      capabilities: input.capabilities ?? null,
      capsAdd: input.capsAdd ?? [],
      capsRemove: input.capsRemove ?? [],
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        "INSERT INTO prompt_presets (id, kind, name, description, active, capabilities, caps_add, caps_remove, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
      )
      .run(
        preset.id,
        preset.kind,
        preset.name,
        preset.description,
        preset.capabilities === null
          ? null
          : JSON.stringify(preset.capabilities),
        preset.capsAdd.length > 0 ? JSON.stringify(preset.capsAdd) : null,
        preset.capsRemove.length > 0 ? JSON.stringify(preset.capsRemove) : null,
        at,
        at,
      );
    return preset;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        PromptPreset,
        "name" | "description" | "capabilities" | "capsAdd" | "capsRemove"
      >
    >,
  ): PromptPreset | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    this.db
      .prepare(
        "UPDATE prompt_presets SET name = ?, description = ?, capabilities = ?, caps_add = ?, caps_remove = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.name ?? cur.name,
        patch.description ?? cur.description,
        JSON.stringify(
          patch.capabilities !== undefined
            ? patch.capabilities
            : cur.capabilities,
        ),
        JSON.stringify(patch.capsAdd ?? cur.capsAdd),
        JSON.stringify(patch.capsRemove ?? cur.capsRemove),
        now(),
        id,
      );
    return this.get(id);
  }

  /** 设为生效：同 kind 的其余预设施 false（附加提示词只允许一张生效） */
  activate(id: string): void {
    const preset = this.get(id);
    if (!preset) return;
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE prompt_presets SET active = 0, updated_at = ? WHERE kind = ?",
        )
        .run(now(), preset.kind);
      this.db
        .prepare(
          "UPDATE prompt_presets SET active = 1, updated_at = ? WHERE id = ?",
        )
        .run(now(), id);
    })();
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM prompt_nodes WHERE preset_id = ?").run(id);
      this.db.prepare("DELETE FROM prompt_presets WHERE id = ?").run(id);
    })();
    return true;
  }

  /** 整份替换预设的段（含每段的 items）；段的先后就是数组顺序。 */
  replaceNodes(
    presetId: string,
    nodes: readonly Omit<PromptNode, "presetId" | "position">[],
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM prompt_nodes WHERE preset_id = ?")
        .run(presetId);
      const ins = this.db.prepare(
        `INSERT INTO prompt_nodes (id, preset_id, position, tag, title, slot_kind, channel, builtin, items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      nodes.forEach((n, i) => {
        ins.run(
          n.id,
          presetId,
          i,
          n.tag,
          n.title,
          n.slotKind,
          n.channel,
          n.builtin ? 1 : 0,
          JSON.stringify(n.items),
        );
      });
      this.db
        .prepare("UPDATE prompt_presets SET updated_at = ? WHERE id = ?")
        .run(now(), presetId);
    })();
  }

  /** 每张卡片被几个预设引用（含条件分支里的）；删卡片与卡片库的「N 处在用」都读它 */
  cardUsage(): Map<string, string[]> {
    const rows = this.db
      .prepare("SELECT preset_id, items FROM prompt_nodes")
      .all() as { preset_id: string; items: string }[];
    const out = new Map<string, Set<string>>();
    for (const r of rows)
      for (const id of allCardIds(JSON.parse(r.items) as PromptItem[])) {
        const s = out.get(id) ?? new Set<string>();
        s.add(r.preset_id);
        out.set(id, s);
      }
    return new Map([...out].map(([id, s]) => [id, [...s]]));
  }

  count(): number {
    return (
      this.db.prepare("SELECT count(*) AS n FROM prompt_presets").get() as {
        n: number;
      }
    ).n;
  }
}
