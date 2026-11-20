// AGENTS.md 预设 → 文件：拼正文、判断文件有没有被人改过、写文件与导入记账。只看文件系统与库，不经过会话池。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Db, openDatabase } from "../store/db.js";
import type { PromptCard } from "../store/prompt-cards.js";
import type { PresetDetail, PromptNode } from "../store/prompt-presets.js";
import { AGENTS_FILE, readGlobalAgentsMd } from "./agents-md.js";
import { GlobalAgentsMdFile, renderAgentsMd } from "./agents-md-presets.js";

let base = "";
let db: Db;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-agentsmd-presets-"));
  db = openDatabase(base);
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

const card = (id: string, body: string): PromptCard => ({
  id,
  group: "g",
  title: id,
  body,
  builtin: false,
  origin: "user",
  copyOf: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
});

const node = (id: string, cardIds: string[]): PromptNode => ({
  id,
  presetId: "p",
  position: 0,
  tag: null,
  title: "正文",
  slotKind: "custom",
  channel: "system",
  builtin: false,
  items: cardIds.map((cardId) => ({ kind: "card", cardId })),
});

const detailOf = (nodes: PromptNode[]): PresetDetail => ({
  id: "p",
  kind: "global-agentsmd",
  name: "版本",
  description: "",
  active: false,
  capabilities: null,
  capsAdd: [],
  capsRemove: [],
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
  nodes,
});

test("拼正文：各卡片按顺序用空行连接，末尾补一个换行", () => {
  const cards = [card("a", "  第一条  "), card("b", "第二条")];
  expect(renderAgentsMd(detailOf([node("n1", ["a", "b"])]), cards)).toBe(
    "第一条\n\n第二条\n",
  );
});

test("拼正文：空白卡片被跳过，空预设返回空串", () => {
  const cards = [
    card("a", "第一条"),
    card("b", "  \n\t "),
    card("c", "第三条"),
  ];
  expect(renderAgentsMd(detailOf([node("n1", ["a", "b", "c"])]), cards)).toBe(
    "第一条\n\n第三条\n",
  );
  expect(renderAgentsMd(detailOf([node("n1", [])]), cards)).toBe("");
});

test("没有文件、只有空白都不算被人改过", async () => {
  const ysHome = path.join(base, "ys");
  const file = new GlobalAgentsMdFile({ ysHome, db });
  expect(await file.state()).toEqual({
    path: path.join(ysHome, AGENTS_FILE),
    exists: false,
    modified: false,
  });
  mkdirSync(ysHome, { recursive: true });
  writeFileSync(path.join(ysHome, AGENTS_FILE), "  \n\t\n");
  expect(await file.state()).toMatchObject({ exists: true, modified: false });
});

test("从没写过而有内容算被改过；我们写过就不算；写过后手改又算", async () => {
  const ysHome = path.join(base, "ys");
  const target = path.join(ysHome, AGENTS_FILE);
  const file = new GlobalAgentsMdFile({ ysHome, db });
  mkdirSync(ysHome, { recursive: true });
  writeFileSync(target, "手写的约定\n");
  expect(await file.state()).toMatchObject({ exists: true, modified: true });

  await file.write("我们写的约定\n");
  expect(await readGlobalAgentsMd(ysHome)).toBe("我们写的约定\n");
  expect(await file.state()).toMatchObject({ exists: true, modified: false });

  // 比较的是原文：只差一个空白也算改过
  writeFileSync(target, "我们写的约定");
  expect(await file.state()).toMatchObject({ modified: true });
});

test("adopt：把磁盘上现在的内容记成「我们写的」，返回原文；空白不记", async () => {
  const ysHome = path.join(base, "ys");
  const target = path.join(ysHome, AGENTS_FILE);
  const file = new GlobalAgentsMdFile({ ysHome, db });
  mkdirSync(ysHome, { recursive: true });
  writeFileSync(target, "\n导入前的内容\n");
  expect(await file.adopt()).toBe("\n导入前的内容\n");
  expect(await file.state()).toMatchObject({ exists: true, modified: false });

  writeFileSync(target, "  \n");
  expect(await file.adopt()).toBeNull();
  expect(await file.state()).toMatchObject({ exists: true, modified: false });
});
