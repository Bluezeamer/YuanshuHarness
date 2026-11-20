// 预设选择：把「agent 预设 + 全局附加提示词」合成会话要用的提示词与默认能力/权限。
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { ensureBuiltinAgents } from "../prompt/builtin-agents.js";
import { addFixtureCards } from "../prompt/testkit.js";
import { type Db, openDatabase } from "../store/db.js";
import { PromptCardStore } from "../store/prompt-cards.js";
import { PromptPresetStore } from "../store/prompt-presets.js";
import {
  GLOBAL_EXTRA_TAG,
  modeViewOf,
  selectPresets,
} from "./preset-selection.js";

let db: Db;
let cards: PromptCardStore;
let presets: PromptPresetStore;
beforeEach(() => {
  db = openDatabase(makeTmpDir("yuanshu-preset-sel-"));
  cards = new PromptCardStore(db);
  presets = new PromptPresetStore(db);
  ensureBuiltinAgents({ cards, presets });
  addFixtureCards(cards);
  // 附加提示词不由内置提供：测试里自己建一张生效的
  const extra = presets.create({ kind: "global-extra", name: "全局附加" });
  presets.replaceNodes(extra.id, [
    {
      id: `${extra.id}-root`,
      tag: null,
      title: "附加提示词正文",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      items: [
        { kind: "card", cardId: "t-lang" },
        { kind: "card", cardId: "t-deps" },
      ],
    },
  ]);
  presets.activate(extra.id);
});
afterEach(() => db.close());

test("agent 预设的 identity 段成为 preamble（裸文本、不带标签）", () => {
  const { prompt } = selectPresets(presets, cards);
  expect(prompt.preamble).toContain("You are an expert coding assistant");
  expect(Object.keys(prompt.sections)).toContain("tools-rules");
  expect(prompt.sections["tools-rules"]).toContain(
    "- read: Read file contents",
  );
});

test("生效的全局附加提示词作为独立段进入 system prompt", () => {
  const { prompt } = selectPresets(presets, cards);
  expect(prompt.sections[GLOBAL_EXTRA_TAG]).toContain("统一使用中文");
  expect(prompt.sources.map((s) => s.kind)).toEqual(["agent", "global-extra"]);
});

test("user 通道的段单独取出，不混进 system prompt", () => {
  const agent = presets.list("agent")[0];
  const detail = presets.detail(agent?.id as string);
  presets.replaceNodes(agent?.id as string, [
    ...(detail?.nodes ?? []),
    {
      id: `${agent?.id}-user`,
      tag: "handoff",
      title: "交付提醒",
      slotKind: "custom",
      channel: "user",
      builtin: false,
      items: [{ kind: "card", cardId: "t-report" }],
    },
  ]);
  const { prompt } = selectPresets(presets, cards);
  expect(prompt.userText).toContain("完成后用几句");
  for (const body of Object.values(prompt.sections))
    expect(body).not.toContain("完成后用几句");
  expect(prompt.preamble).not.toContain("完成后用几句");
});

test("分组按会话的模型选卡片：命中的用，都不成立落到「否则」", () => {
  const agent = presets.list("agent")[0];
  const nodes = presets.detail(agent?.id as string)?.nodes ?? [];
  presets.replaceNodes(
    agent?.id as string,
    nodes.map((n) =>
      n.tag === "tools-rules"
        ? {
            ...n,
            items: [
              { kind: "card" as const, cardId: "k-tools" },
              {
                kind: "group" as const,
                id: "g1",
                name: "按模型",
                cards: [
                  {
                    cardId: "t-mode-review",
                    when: {
                      kind: "model" as const,
                      providers: ["local"],
                      models: [],
                    },
                  },
                  {
                    cardId: "t-report",
                    when: {
                      kind: "model" as const,
                      providers: [],
                      models: ["anthropic/claude-sonnet-5"],
                    },
                  },
                  { cardId: "t-lang", when: null },
                ],
              },
            ],
          }
        : n,
    ),
  );
  const section = (model: { provider: string; model: string } | null) =>
    selectPresets(presets, cards, { model }).prompt.sections["tools-rules"];
  // 整个供应商成立
  expect(section({ provider: "local", model: "any" })).toContain("只做评审");
  // 具体模型成立
  expect(
    section({ provider: "anthropic", model: "claude-sonnet-5" }),
  ).toContain("完成后用几句");
  // 同供应商别的模型不成立 → 否则
  expect(section({ provider: "anthropic", model: "claude-opus-5" })).toContain(
    "所有说明、注释与回复统一使用中文",
  );
  // 还没有可用模型 → 同样只有「否则」
  expect(section(null)).toContain("所有说明、注释与回复统一使用中文");
  // 直接挂的卡片不受条件影响
  expect(section(null)).toContain("- read: Read file contents");
});

test("可以指定 agent 预设；不存在的 id 回落到第一张", () => {
  const reader = presets.list("agent").find((x) => x.name === "page-reader");
  const picked = selectPresets(presets, cards, { agentPresetId: reader?.id });
  const fallback = selectPresets(presets, cards, { agentPresetId: "nope" });
  expect(picked.prompt.preamble).not.toBe(fallback.prompt.preamble);
  expect(picked.prompt.preamble).toContain("You are the page reader");
  expect(fallback.prompt.sources[0]?.kind).toBe("agent");
});

test("全局附加提示词没有激活时就取第一张", () => {
  const made = presets.create({ kind: "global-extra", name: "第二份" });
  presets.replaceNodes(made.id, [
    {
      id: `${made.id}-root`,
      tag: null,
      title: "附加提示词正文",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      items: [{ kind: "card", cardId: "t-style" }],
    },
  ]);
  // 清掉激活标记（直接改库）：仍按第一张注入
  db.prepare("UPDATE prompt_presets SET active = 0").run();
  expect(presets.activeExtra()).toBeUndefined();
  const { prompt } = selectPresets(presets, cards);
  expect(prompt.sections[GLOBAL_EXTRA_TAG]).toContain("统一使用中文");
  expect(prompt.sections[GLOBAL_EXTRA_TAG]).not.toContain("匹配现有风格");
  expect(prompt.sources.map((s) => s.id)).not.toContain(made.id);
});

test("激活的附加提示词取代默认那一张", () => {
  const made = presets.create({ kind: "global-extra", name: "第二份" });
  presets.replaceNodes(made.id, [
    {
      id: `${made.id}-root`,
      tag: null,
      title: "附加提示词正文",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      items: [{ kind: "card", cardId: "t-style" }],
    },
  ]);
  presets.activate(made.id);
  const { prompt } = selectPresets(presets, cards);
  expect(prompt.sections[GLOBAL_EXTRA_TAG]).toContain("匹配现有风格");
  expect(prompt.sources.map((s) => s.id)).toContain(made.id);
});

test("全局附加提示词里的分组按会话的模型求值", () => {
  const extra = presets.list("global-extra")[0];
  presets.replaceNodes(extra?.id as string, [
    {
      id: `${extra?.id}-root`,
      tag: null,
      title: "附加提示词正文",
      slotKind: "custom",
      channel: "system",
      builtin: false,
      items: [
        {
          kind: "group",
          id: "g1",
          name: "按模型",
          cards: [
            {
              cardId: "t-style",
              when: { kind: "model", providers: ["local"], models: [] },
            },
            { cardId: "t-deps", when: null },
          ],
        },
      ],
    },
  ]);
  const section = (model: { provider: string; model: string } | null) =>
    selectPresets(presets, cards, { model }).prompt.sections[GLOBAL_EXTRA_TAG];
  expect(section({ provider: "local", model: "any" })).toContain(
    "匹配现有风格",
  );
  expect(section({ provider: "cloud", model: "x" })).toContain("uv");
  expect(section(null)).toContain("uv");
});

test("模式预设不参与会话提示词与默认能力；运行时视图带正文与能力操作", () => {
  const mode = presets.list("mode").find((x) => x.name === "plan");
  const picked = selectPresets(presets, cards);
  // 模式不并进系统提示词，也不改默认能力 / 权限
  expect(Object.keys(picked.prompt.sections)).not.toContain("mode");
  const view = modeViewOf(presets, cards, mode?.id as string);
  expect(view?.text).toContain("Plan mode is on");
  // plan 模式限定为只读工具集；没有增加 / 减少
  expect(view?.ops.limit).toEqual(mode?.capabilities);
  expect(view?.ops).toMatchObject({ add: [], remove: [] });
  expect(modeViewOf(presets, cards, "nope")).toBeNull();
});
