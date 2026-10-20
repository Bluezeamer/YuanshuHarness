import { uuidv7 } from "../id.js";
import type { Db } from "./db.js";

export const AGENT_NAME_MAX = 100;
export const AGENT_DESCRIPTION_MAX = 500;
// 内置默认 agent（等价于接入 agent 定义之前的行为）；不可删除。
export const DEFAULT_AGENT_ID = "c46ee05d-4ed4-4001-a91a-e7d5e9b4f3c1";

export interface AgentCapability {
  kind: "tool" | "skill" | "mcp";
  name: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  // 有序的提示词块引用（块 id）；块被引用而非复制。
  promptBlocks: string[];
  capabilities: AgentCapability[];
  // 模型登记 id；null 表示用 Server 的默认模型。
  model: string | null;
  defaultThinkingLevel: string | null;
  // 会话创建时的初始模式 id；null 表示 build。
  defaultMode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentInput = Omit<Agent, "id" | "createdAt" | "updatedAt">;

type Row = {
  id: string;
  name: string;
  description: string;
  prompt_blocks: string;
  capabilities: string;
  model: string | null;
  thinking_level: string | null;
  default_mode: string | null;
  created_at: string;
  updated_at: string;
};

const toAgent = (r: Row): Agent => ({
  id: r.id,
  name: r.name,
  description: r.description,
  promptBlocks: JSON.parse(r.prompt_blocks) as string[],
  capabilities: JSON.parse(r.capabilities) as AgentCapability[],
  model: r.model,
  defaultThinkingLevel: r.thinking_level,
  defaultMode: r.default_mode,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class AgentStore {
  constructor(private readonly db: Db) {}

  list(): Agent[] {
    return (
      this.db
        .prepare("SELECT * FROM agents ORDER BY created_at, id")
        .all() as Row[]
    ).map(toAgent);
  }

  get(id: string): Agent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r && toAgent(r);
  }

  default(): Agent | undefined {
    return this.get(DEFAULT_AGENT_ID) ?? this.list()[0];
  }

  create(input: AgentInput, now = new Date()): Agent {
    const at = now.toISOString();
    const a: Agent = { id: uuidv7(), ...input, createdAt: at, updatedAt: at };
    this.insert(a);
    return a;
  }

  // 内置种子用固定 id。
  insert(a: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, prompt_blocks, capabilities, model, thinking_level, default_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.name,
        a.description,
        JSON.stringify(a.promptBlocks),
        JSON.stringify(a.capabilities),
        a.model,
        a.defaultThinkingLevel,
        a.defaultMode,
        a.createdAt,
        a.updatedAt,
      );
  }

  update(id: string, patch: Partial<AgentInput>): Agent | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE agents SET name = ?, description = ?, prompt_blocks = ?, capabilities = ?,
           model = ?, thinking_level = ?, default_mode = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        JSON.stringify(next.promptBlocks),
        JSON.stringify(next.capabilities),
        next.model,
        next.defaultThinkingLevel,
        next.defaultMode,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0
    );
  }

  // 首次启动写入内置 agent 并留标记；之后用户删除的不会再回来。
  seed(agents: Agent[]): void {
    const marked = this.db
      .prepare("SELECT 1 FROM meta WHERE key = 'agents_seeded'")
      .get();
    if (marked) return;
    this.db.transaction(() => {
      for (const a of agents) this.insert(a);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('agents_seeded', '1')")
        .run();
    })();
  }
}
