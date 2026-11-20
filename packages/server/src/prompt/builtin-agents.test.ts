import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { splitAttachmentMarkers } from "../session/attachments.js";
import { selectPresets } from "../session/preset-selection.js";
import { type Db, openDatabase } from "../store/db.js";
import { BASELINE_GROUP, PromptCardStore } from "../store/prompt-cards.js";
import { PromptPresetStore } from "../store/prompt-presets.js";
import { BASELINE_AGENT_ID, BASELINE_MODE_ID } from "./baseline.js";
import {
  BUILTIN_PRESET_IDS,
  ensureBuiltinAgents,
  isBuiltinPreset,
  PAGE_READER_CARD_ID,
  PAGE_READER_PRESET_ID,
  PAGE_READER_PRESET_NAME,
} from "./builtin-agents.js";

let db: Db;
let cards: PromptCardStore;
let presets: PromptPresetStore;
beforeEach(() => {
  db = openDatabase(makeTmpDir("yuanshu-builtin-agents-"));
  cards = new PromptCardStore(db);
  presets = new PromptPresetStore(db);
});
afterEach(() => db.close());

const ensure = () => ensureBuiltinAgents({ cards, presets });

test("内置预设的 id 集合与判定", () => {
  for (const id of [
    BASELINE_AGENT_ID,
    BASELINE_MODE_ID,
    PAGE_READER_PRESET_ID,
  ]) {
    expect(BUILTIN_PRESET_IDS.has(id)).toBe(true);
    expect(isBuiltinPreset(id)).toBe(true);
  }
  expect(isBuiltinPreset("p-user-made")).toBe(false);
});

test("全新库只 ensure 一次：七张基线卡 + 页面阅读卡，三个预设（coder-full 在 page-reader 之前）", () => {
  ensure();

  const all = cards.list();
  expect(all.map((c) => c.id).sort()).toEqual(
    [
      "k-attachments",
      "k-identity-pi",
      "k-mode-plan",
      "k-page-reader",
      "k-paths",
      "k-rules",
      "k-showing",
      "k-tools",
    ].sort(),
  );
  expect(all.every((c) => c.builtin)).toBe(true);
  for (const c of all)
    expect([BASELINE_GROUP, "内置 agent"]).toContain(c.group);
  expect(cards.get("k-mode-plan")).toMatchObject({
    group: BASELINE_GROUP,
    title: "plan 模式",
    origin: "ours",
    builtin: true,
  });

  // 默认 agent 取第一张 agent 预设：coder-full 必须排在 page-reader 之前
  const agents = presets.list("agent");
  expect(agents.map((p) => p.name)).toEqual(["coder-full", "page-reader"]);
  expect(agents[0]?.id).toBe(BASELINE_AGENT_ID);
  expect(agents[0]?.description).toContain("Default coding agent");
  expect(agents[0]?.capabilities).toBeNull();
  expect(agents[1]?.id).toBe(PAGE_READER_PRESET_ID);
  // 模式只留 plan 一张
  expect(presets.list("mode").map((p) => [p.id, p.name])).toEqual([
    [BASELINE_MODE_ID, "plan"],
  ]);
  expect(presets.count()).toBe(3);
});

test("coder-full 的段与组装产物：preamble 只有 pi 身份，没有任何中文身份句", () => {
  ensure();
  const preset = presets.detail(BASELINE_AGENT_ID);
  expect(preset?.nodes.map((n) => n.id)).toEqual([
    "a1-identity",
    "a1-tools",
    "a1-hosts",
    "a1-skills",
    "a1-env",
  ]);
  expect(preset?.nodes[0]?.items).toEqual([
    { kind: "card", cardId: "k-identity-pi" },
  ]);

  const { prompt, capabilities } = selectPresets(presets, cards);
  expect(prompt.preamble).toContain("You are an expert coding assistant");
  expect(prompt.preamble).not.toContain("你是一名务实的工程助手");
  expect(Object.keys(prompt.sections)).toEqual([
    "tools-rules",
    "hosts-and-files",
  ]);
  expect(prompt.sections["tools-rules"]).toContain(
    "- read: Read file contents",
  );
  // codemode 关闭：它的行不进提示词
  expect(prompt.sections["tools-rules"]).not.toContain("codemode");
  expect(capabilities).toBeNull();
});

test("叠加的三张卡：英文；示例写法与代码里的契约一致（标记行能被解析、地址形式齐全）", () => {
  ensure();
  const ours = ["k-paths", "k-attachments", "k-showing"].map(
    (id) => cards.get(id)?.body ?? "",
  );
  for (const body of ours) {
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/[\u4e00-\u9fff]/);
  }
  const [paths, attachments, showing] = ours as [string, string, string];
  // 三形态的 host 规则：不写 / 裸主机（要绝对路径）/ host:目录；bash 只收 host:目录
  expect(paths).toContain("<host>:<name>");
  expect(paths).toContain("Omit host");
  expect(paths).toContain('host="dev1"');
  expect(paths).toContain('host="dev1:train"');
  expect(paths).toContain("bash accepts only the host:directory form");
  expect(paths).toContain("Never put a host inside path");
  expect(paths).toContain("is rejected");
  // 卡里示范的 [attach_file] 行必须就是服务端注入的那种格式
  const example = attachments
    .split("\n")
    .find((l) => l.startsWith("[attach_file] "));
  expect(example).toBeDefined();
  expect(splitAttachmentMarkers(`看\n\n${example}`).attachments).toEqual([
    {
      name: "report.pdf",
      mime: "application/pdf",
      sizeText: "120 KB",
      path: "./2026-11-16/ab12cd34-report.pdf",
    },
  ]);
  expect(attachments).toContain("transfer_files");
  expect(attachments).toContain('read(host="attachment", path="/2026-11-16/');
  expect(attachments).toContain("read-only");
  expect(showing).toContain(
    "![short description](file:<host>:<absolute path>)",
  );
  expect(showing).toContain("file:attachment:/");
  expect(showing).toContain("base64");
});

test("plan 模式：正文是一张英文卡，能力为只读工具集", () => {
  ensure();
  const mode = presets.detail(BASELINE_MODE_ID);
  expect(mode).toMatchObject({
    kind: "mode",
    name: "plan",
    description: "只读 + 方案优先",
    active: false,
  });
  expect(mode?.capabilities).toEqual([
    "tool:read",
    "tool:grep",
    "tool:find",
    "tool:ls",
    "tool:todo_write",
    "tool:list_directories",
  ]);
  expect(mode?.nodes).toHaveLength(1);
  expect(mode?.nodes[0]).toMatchObject({
    id: "m1-root",
    tag: null,
    title: "模式提示词",
    slotKind: "custom",
    channel: "system",
    builtin: false,
    items: [{ kind: "card", cardId: "k-mode-plan" }],
  });
  expect(cards.get("k-mode-plan")?.body).toBe(
    "Plan mode is on. You can only read and search, not modify anything. Present a plan and its risks first, and wait for the user's confirmation before acting.",
  );
});

test("内置预设与卡片的内容：只有一个 identity 段，引用内置卡片，能力只有 read 与 grep", () => {
  ensure();
  const preset = presets.detail(PAGE_READER_PRESET_ID);
  expect(preset).toMatchObject({
    kind: "agent",
    name: PAGE_READER_PRESET_NAME,
    active: false,
    capabilities: ["tool:read", "tool:grep"],
  });
  expect(preset?.description).toContain("Built-in read-only agent");
  expect(preset?.nodes).toHaveLength(1);
  expect(preset?.nodes[0]).toMatchObject({
    id: "a-page-reader-identity",
    tag: null,
    title: "角色定义",
    slotKind: "custom",
    channel: "system",
    builtin: false,
    items: [{ kind: "card", cardId: PAGE_READER_CARD_ID }],
  });

  const card = cards.get(PAGE_READER_CARD_ID);
  expect(card).toMatchObject({
    group: "内置 agent",
    title: "页面阅读 agent",
    builtin: true,
    origin: "ours",
    copyOf: null,
  });
  // 只读提示词的两条要点
  expect(card?.body).toContain("You are the page reader");
  expect(card?.body).toContain("Call deliver ONCE");
});

test("幂等：重复调用不产生重复行，createdAt 不变；卡片正文与预设段按代码里的定义覆盖", () => {
  ensure();
  const first = presets.get(PAGE_READER_PRESET_ID);
  const coderAt = presets.get(BASELINE_AGENT_ID)?.createdAt;
  const cardAt = cards.get(PAGE_READER_CARD_ID)?.createdAt;
  // 有人（或旧版本）改过：再来一次要改回去
  presets.update(PAGE_READER_PRESET_ID, { capabilities: ["tool:read"] });
  presets.update(BASELINE_AGENT_ID, { name: "改过的名字" });
  for (const id of [PAGE_READER_PRESET_ID, BASELINE_AGENT_ID, BASELINE_MODE_ID])
    presets.replaceNodes(id, [
      {
        id: `${id}-old`,
        tag: "docs",
        title: "旧段",
        slotKind: "custom",
        channel: "system",
        builtin: false,
        items: [],
      },
    ]);
  for (const id of [PAGE_READER_CARD_ID, "k-mode-plan", "k-identity-pi"])
    db.prepare("UPDATE prompt_cards SET body = ?, grp = ? WHERE id = ?").run(
      "旧版本的内容",
      "旧分组",
      id,
    );

  ensure();
  expect(presets.get(PAGE_READER_PRESET_ID)?.createdAt).toBe(first?.createdAt);
  expect(presets.get(BASELINE_AGENT_ID)?.createdAt).toBe(coderAt);
  expect(cards.get(PAGE_READER_CARD_ID)?.createdAt).toBe(cardAt);
  expect(presets.get(BASELINE_AGENT_ID)?.name).toBe("coder-full");
  expect(presets.get(PAGE_READER_PRESET_ID)?.capabilities).toEqual([
    "tool:read",
    "tool:grep",
  ]);
  // 卡片正文与分组也按代码里的定义覆盖（旧版本留下的内容会被换掉）
  expect(cards.get(PAGE_READER_CARD_ID)?.body).toContain(
    "You are the page reader",
  );
  expect(cards.get("k-identity-pi")?.body).toContain(
    "You are an expert coding assistant",
  );
  expect(cards.get("k-mode-plan")).toMatchObject({
    group: BASELINE_GROUP,
    builtin: true,
  });
  // 段恢复成定义里的样子，不多不少
  expect(presets.detail(PAGE_READER_PRESET_ID)?.nodes).toHaveLength(1);
  expect(presets.detail(BASELINE_AGENT_ID)?.nodes).toHaveLength(5);
  expect(presets.detail(BASELINE_MODE_ID)?.nodes).toHaveLength(1);
  expect(presets.count()).toBe(3);
  expect(cards.count()).toBe(8);
});

test("内置卡片只读：update 与 remove 都拒绝，可以复制一份再改", () => {
  ensure();
  expect(cards.update(PAGE_READER_CARD_ID, { body: "改写" })).toBeNull();
  expect(cards.remove(PAGE_READER_CARD_ID)).toBe(false);
  expect(cards.update("k-mode-plan", { body: "改写" })).toBeNull();
  expect(cards.remove("k-mode-plan")).toBe(false);
  const copy = cards.copy(PAGE_READER_CARD_ID);
  expect(copy?.builtin).toBe(false);
  expect(copy?.body).toContain("You are the page reader");
});

test("按内置预设装配会话提示词：只有身份那一段，能力只有 read 与 grep", () => {
  ensure();
  const { prompt, capabilities } = selectPresets(presets, cards, {
    agentPresetId: PAGE_READER_PRESET_ID,
  });
  expect(prompt.preamble).toContain("You are the page reader");
  // 不挂技能清单、环境信息与自身文档：sections 里没有东西
  expect(Object.keys(prompt.sections)).toEqual([]);
  expect(capabilities).toEqual(["tool:read", "tool:grep"]);
});
