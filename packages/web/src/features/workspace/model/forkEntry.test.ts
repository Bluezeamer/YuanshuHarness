import { expect, test } from "vitest";
import type {
  SessionTree,
  SessionTreeNode,
  SessionTreeRole,
} from "../../../api/session-fork";
import {
  assistantEntryIds,
  type ForkTarget,
  forkEntryId,
  forkTargetOf,
} from "./forkEntry";

interface Entry {
  id: string;
  type?: string;
  role?: SessionTreeRole;
}

/** 把条目列表串成单链树：最后一条是叶；activePath 按服务端口径（叶到根） */
function treeOf(entries: readonly Entry[]): SessionTree {
  let children: SessionTreeNode[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    const node: SessionTreeNode = {
      id: e.id,
      parentId: entries[i + 1]?.id ?? null,
      type: e.type ?? "message",
      ...(e.role ? { role: e.role } : {}),
      preview: "",
      timestamp: "",
      children,
    };
    children = [node];
  }
  return {
    leafId: entries.at(-1)?.id ?? null,
    activePath: entries.map((e) => e.id).reverse(),
    nodes: children,
  };
}

// 完整分支：u1 → a1 → t1(工具结果) → a2(工具调用-only，无正文) → 压缩 → u2 → a3
const FULL = treeOf([
  { id: "u1", role: "user" },
  { id: "a1", role: "assistant" },
  { id: "t1", role: "toolResult" },
  { id: "a2", role: "assistant" },
  { id: "c1", type: "compaction" },
  { id: "u2", role: "user" },
  { id: "a3", role: "assistant" },
]);

const msg = (role: string) => ({ role });

/** 定位目标消息，定位不到直接让测试报错 */
function targetOf(...args: Parameters<typeof forkTargetOf>): ForkTarget {
  const target = forkTargetOf(...args);
  if (!target) throw new Error("期望能定位到目标消息");
  return target;
}

test("assistantEntryIds 只取 activePath 上的 assistant message 节点，工具结果/压缩不算", () => {
  expect(assistantEntryIds(FULL)).toEqual(["a1", "a2", "a3"]);
});

test("全量加载：窗口消息按 assistant 序号映射到 entryId", () => {
  // 窗口里是投影后的对话：工具结果不出现、工具调用-only 的 assistant 是正式消息
  const messages = [
    msg("user"),
    msg("assistant"),
    msg("assistant"),
    msg("user"),
    msg("assistant"),
  ];
  const target = targetOf(messages[2] ?? {}, [], messages);
  expect(target).toEqual({ ordinal: 2, loadedAssistants: 3 });
  expect(forkEntryId(FULL, target)).toBe("a2");

  const last = targetOf(messages[4] ?? {}, [], messages);
  expect(forkEntryId(FULL, last)).toBe("a3");
});

test("历史分页：未加载前缀的 assistant 用树总数偏移对齐", () => {
  // 只加载后缀：更早历史一条（a2，绝对序位 2），窗口是 u2 + a3
  const older = [{ index: 2, role: "assistant" }];
  const messages = [msg("user"), msg("assistant")];
  // 已加载 2 个 assistant，树里 3 个 → 未加载前缀有 1 个（a1）
  const old = targetOf(older[0] ?? {}, older, messages);
  expect(old).toEqual({ ordinal: 1, loadedAssistants: 2 });
  expect(forkEntryId(FULL, old)).toBe("a2");

  const last = targetOf(messages[1] ?? {}, older, messages);
  expect(last).toEqual({ ordinal: 2, loadedAssistants: 2 });
  expect(forkEntryId(FULL, last)).toBe("a3");
});

test("工具调用-only 的 assistant 节点（无正文）照常计数并映射", () => {
  const toolOnly = treeOf([
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "a2", role: "assistant" },
  ]);
  expect(assistantEntryIds(toolOnly)).toEqual(["a1", "a2"]);
  const messages = [msg("user"), msg("assistant"), msg("assistant")];
  const target = targetOf(messages[2] ?? {}, [], messages);
  expect(forkEntryId(toolOnly, target)).toBe("a2");
});

test("找不到分叉点：非助手消息 / 不在已加载区间 / 序号越界", () => {
  const older = [{ index: 0, role: "assistant" }];
  const messages = [msg("user"), msg("assistant")];
  expect(forkTargetOf(msg("user"), older, messages)).toBeNull();
  // 既不在窗口里、也没有 index 可以定位
  expect(forkTargetOf(msg("assistant"), older, messages)).toBeNull();
  // index 在更早历史里查不到
  expect(
    forkTargetOf({ index: 9, role: "assistant" }, older, messages),
  ).toBeNull();

  // 序号超过已加载的 assistant 数
  expect(forkEntryId(FULL, { ordinal: 4, loadedAssistants: 3 })).toBeNull();
  // 已加载的比树里还多：界面与服务端分支不一致
  expect(forkEntryId(FULL, { ordinal: 1, loadedAssistants: 4 })).toBeNull();
  // 序号 0 非法
  expect(forkEntryId(FULL, { ordinal: 0, loadedAssistants: 0 })).toBeNull();
  // 空树
  expect(
    forkEntryId(treeOf([]), { ordinal: 1, loadedAssistants: 0 }),
  ).toBeNull();
});
