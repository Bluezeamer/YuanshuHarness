// AGENTS.md 预设（prompt.md S2′）：库里存多份，全局那份激活时把拼出来的文本写进 `<ysHome>/AGENTS.md`。
// 运行时读的仍是文件（`session/agents-md.ts`），预设只是生成文件的工具；文件被人手改过时覆盖前要问。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Db } from "../store/db.js";
import type { PromptCard } from "../store/prompt-cards.js";
import type { PresetDetail } from "../store/prompt-presets.js";
import { globalAgentsPath, writeGlobalAgentsMd } from "./agents-md.js";

/** 最近一次写进文件的内容的 sha256；没有记录就是我们从没写过 */
const KEY_HASH = "global_agentsmd_hash";

const hashOf = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** 把一份 AGENTS.md 预设拼成文件正文：各卡片 body trim 后用空行连接，末尾补一个换行；空预设返回空串。 */
export function renderAgentsMd(
  detail: PresetDetail,
  cards: readonly PromptCard[],
): string {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const body = detail.nodes
    .flatMap((n) => n.items)
    .flatMap((it) => (it.kind === "card" ? [it.cardId] : []))
    .flatMap((id) => byId.get(id) ?? [])
    .map((c) => c.body.trim())
    .filter(Boolean)
    .join("\n\n");
  return body === "" ? "" : `${body}\n`;
}

export interface GlobalFileState {
  path: string;
  exists: boolean;
  /** 文件存在且非空白，并且内容不是我们最近一次写进去的（含「从没写过」） */
  modified: boolean;
}

export class GlobalAgentsMdFile {
  constructor(private readonly opts: { ysHome: string; db: Db }) {}

  /** 磁盘上现在的原文；不存在读不到都是 null（读文件与「有没有」是同一趟，省一次 stat） */
  private async read(): Promise<string | null> {
    try {
      return await readFile(globalAgentsPath(this.opts.ysHome), "utf8");
    } catch {
      return null;
    }
  }

  private recorded(): string | null {
    const row = this.opts.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(KEY_HASH) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private remember(hash: string): void {
    this.opts.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY_HASH, hash);
  }

  async state(): Promise<GlobalFileState> {
    const raw = await this.read();
    // 不存在与只有空白都当作没有文件，不算被人改过
    const modified =
      raw === null || raw.trim() === ""
        ? false
        : hashOf(raw) !== this.recorded();
    return {
      path: globalAgentsPath(this.opts.ysHome),
      exists: raw !== null,
      modified,
    };
  }

  /** 写文件并记下内容的 sha256（比较的是原文，不 trim） */
  async write(text: string): Promise<void> {
    await writeGlobalAgentsMd(this.opts.ysHome, text);
    this.remember(hashOf(text));
  }

  /** 把磁盘上现在的内容记成「我们写的」（导入之后用）；文件不存在或空白不记 */
  async adopt(): Promise<string | null> {
    const raw = await this.read();
    if (raw === null || raw.trim() === "") return null;
    this.remember(hashOf(raw));
    return raw;
  }
}
