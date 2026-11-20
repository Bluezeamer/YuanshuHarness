// 全局 AGENTS.md（`<ysHome>/AGENTS.md`，Server 本机）：库里的版本是预设，激活时把拼出来的文本写进文件。
// 这里只给设置页看「文件在哪、在不在、有没有被人改过」，改内容走预设；磁盘上已有内容可以导入成一个版本。
import type { FastifyInstance } from "fastify";
import type { GlobalAgentsMdFile } from "../session/agents-md-presets.js";
import type { PromptCardStore } from "../store/prompt-cards.js";
import { CARD_TITLE_MAX } from "../store/prompt-cards.js";
import type { PromptPresetStore } from "../store/prompt-presets.js";

/** 这两种预设只有一段，段名固定 */
const ROOT_TITLE = "正文";

const two = (n: number): string => String(n).padStart(2, "0");

/** 本地时间，形如 2026-11-06 14:30：导入出来的版本名与卡片标题用它区分 */
const stamp = (d: Date): string =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

export function agentsMdApi(
  app: FastifyInstance,
  opts: {
    file: GlobalAgentsMdFile;
    presets: PromptPresetStore;
    cards: PromptCardStore;
  },
): void {
  const { file, presets, cards } = opts;

  app.get("/api/v1/agents-md/global", async () => file.state());

  // 磁盘上已经有一份（手写的或别的工具写的）时，把它做成一个版本并设为生效
  app.post("/api/v1/agents-md/global/import", async (_req, reply) => {
    // adopt 一并把这份内容记成「我们写的」：导入之后不再算被人改过
    const raw = await file.adopt();
    if (raw === null) return reply.code(409).send({ error: "empty" });
    const title = `从磁盘导入 ${stamp(new Date())}`.slice(0, CARD_TITLE_MAX);
    const card = cards.create({
      title,
      group: "导入",
      body: raw,
      origin: "user",
    });
    const preset = presets.create({
      kind: "global-agentsmd",
      name: title,
      description: "导入时磁盘上的内容",
    });
    presets.replaceNodes(preset.id, [
      {
        id: `${preset.id}-root`,
        tag: null,
        title: ROOT_TITLE,
        slotKind: "custom",
        channel: "system",
        builtin: false,
        items: [{ kind: "card", cardId: card.id }],
      },
    ]);
    presets.activate(preset.id);
    return reply.code(201).send({ preset: presets.get(preset.id) });
  });
}
