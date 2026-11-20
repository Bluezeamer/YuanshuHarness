import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  PREVIEW_MAX,
  readSessionTree,
  readUserMessages,
  type TreeViewNode,
} from "./session-tree.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const UUID = "019a0000-0000-7000-8000-000000000001";

const stamp = (n: number): string =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function assistant(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "stub",
    model: "stub-model",
    usage: { input: 0, output: 0 },
    stopReason: "stop",
    timestamp: 0,
  };
}

function user(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

// 手写一份 JSONL：树投影只依赖条目结构，不必跑模型。
function writeSession(entries: Record<string, unknown>[]): {
  file: string;
  dir: string;
  id: string;
} {
  dir = mkdtempSync(join(tmpdir(), "yuanshu-tree-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${UUID}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: UUID,
    timestamp: stamp(0),
    cwd: dir,
  };
  writeFileSync(
    file,
    `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return { file, dir, id: UUID };
}

const LONG_USER_TEXT = "很长的用户消息".repeat(30);
const ATTACH_MARKER = "[attach_file] attachment:/shot.png (image/png, 1.0 KB)";

function fixture(): { file: string; dir: string; id: string } {
  return writeSession([
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: stamp(1),
      message: user("改一下登录逻辑"),
    },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: stamp(2),
      message: assistant("好的，我先看看代码。"),
    },
    // 模型切换是状态条目：不进树，其子节点挂回 e2。
    {
      type: "model_change",
      id: "e3",
      parentId: "e2",
      timestamp: stamp(3),
      provider: "stub",
      modelId: "stub-model",
    },
    {
      type: "message",
      id: "e4",
      parentId: "e3",
      timestamp: stamp(4),
      message: assistant("已经改好了。"),
    },
    {
      type: "message",
      id: "e5",
      parentId: "e4",
      timestamp: stamp(5),
      message: {
        ...assistant(""),
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "e6",
      parentId: "e5",
      timestamp: stamp(6),
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "文件内容" }],
        isError: false,
        timestamp: 0,
      },
    },
    {
      type: "compaction",
      id: "e7",
      parentId: "e6",
      timestamp: stamp(7),
      summary: "压缩摘要第一行\n压缩摘要第二行",
      tokensBefore: 1234,
      firstKeptEntryId: null,
    },
    {
      type: "message",
      id: "e8",
      parentId: "e7",
      timestamp: stamp(8),
      message: user(`第二个问题\n\n${ATTACH_MARKER}`),
    },
    {
      type: "message",
      id: "e9",
      parentId: "e8",
      timestamp: stamp(9),
      message: assistant("第二问的回答"),
    },
    {
      type: "label",
      id: "e10",
      parentId: "e9",
      timestamp: stamp(10),
      targetId: "e8",
      label: "重要",
    },
    {
      type: "message",
      id: "e11",
      parentId: "e10",
      timestamp: stamp(11),
      message: user(LONG_USER_TEXT),
    },
    // 标题也属于状态条目：当前 leaf 落在它上面时，对外映射到最近的对话节点。
    {
      type: "session_info",
      id: "e12",
      parentId: "e11",
      timestamp: stamp(12),
      name: "测试会话",
    },
  ]);
}

const flat = (nodes: TreeViewNode[]): TreeViewNode[] =>
  nodes.flatMap((n) => [n, ...flat(n.children)]);

describe("会话树投影", () => {
  test("只保留对话节点、跳过状态条目，activePath 映射到最近的对话 leaf", () => {
    const { file, dir: sessionDir, id } = fixture();
    const tree = readSessionTree(file, sessionDir, id);

    expect(tree.leafId).toBe("e11");
    expect(tree.activePath).toEqual([
      "e11",
      "e9",
      "e8",
      "e7",
      "e6",
      "e5",
      "e4",
      "e2",
      "e1",
    ]);
    // 单一根：e1；状态条目被跳过，子节点挂回对话祖先。
    expect(tree.nodes.map((n) => n.id)).toEqual(["e1"]);
    const nodes = flat(tree.nodes);
    expect(nodes.map((n) => n.id)).toEqual([
      "e1",
      "e2",
      "e4",
      "e5",
      "e6",
      "e7",
      "e8",
      "e9",
      "e11",
    ]);
    expect(nodes.find((n) => n.id === "e4")?.parentId).toBe("e2");
    expect(nodes.find((n) => n.id === "e8")?.parentId).toBe("e7");
    // 叶子上的状态条目（标题）不进 activePath。
    expect(nodes.some((n) => n.id === "e12")).toBe(false);
  });

  test("类型、角色、预览与标签", () => {
    const { file, dir: sessionDir, id } = fixture();
    const nodes = flat(readSessionTree(file, sessionDir, id).nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    expect(byId.get("e1")).toMatchObject({
      type: "message",
      role: "user",
      preview: "改一下登录逻辑",
      timestamp: stamp(1),
    });
    expect(byId.get("e1")?.label).toBeUndefined();
    // 用户消息末尾的附件标记不属于正文，预览里不显示。
    expect(byId.get("e8")?.preview).toBe("第二个问题");
    expect(byId.get("e6")).toMatchObject({ role: "toolResult" });
    // 只有工具调用的助手消息给一个占位预览。
    expect(byId.get("e5")?.preview).toBe("（工具调用）");
    expect(byId.get("e7")).toMatchObject({ type: "compaction" });
    // compaction 的预览就是摘要首行，种类靠 type 区分，不带文字前缀。
    expect(byId.get("e7")?.preview.startsWith("压缩摘要第一行")).toBe(true);
    expect(byId.get("e8")?.label).toBe("重要");
    for (const node of nodes)
      expect([...node.preview].length).toBeLessThanOrEqual(PREVIEW_MAX);
    for (const node of nodes) expect(node.children).toBeInstanceOf(Array);
  });

  test("空会话返回空树", () => {
    const { file, dir: sessionDir, id } = writeSession([]);
    expect(readSessionTree(file, sessionDir, id)).toEqual({
      leafId: null,
      activePath: [],
      nodes: [],
    });
  });

  test("文件头无效时拒绝交给 SDK", () => {
    const { file, dir: sessionDir } = writeSession([]);
    writeFileSync(file, "");
    expect(() => readSessionTree(file, sessionDir, UUID)).toThrow(/文件头/);
  });
});

describe("B20 指令列表", () => {
  test("当前分支上的用户消息按顺序返回，全量不截断，带时间戳", () => {
    const { file, dir: sessionDir, id } = fixture();
    const messages = readUserMessages(file, sessionDir, id);
    expect(messages.map((m) => m.entryId)).toEqual(["e1", "e8", "e11"]);
    expect(messages.map((m) => m.timestamp)).toEqual([
      stamp(1),
      stamp(8),
      stamp(11),
    ]);
    expect(messages[0]?.text).toBe("改一下登录逻辑");
    // 原文包含附件标记（与 pi 的 getUserMessagesForForking 一致），前端负责截断显示。
    expect(messages[1]?.text).toBe(`第二个问题\n\n${ATTACH_MARKER}`);
    expect(messages[2]?.text).toBe(LONG_USER_TEXT);
    expect(messages[2]?.text.length).toBeGreaterThan(200);
  });

  test("空会话返回空列表", () => {
    const { file, dir: sessionDir, id } = writeSession([]);
    expect(readUserMessages(file, sessionDir, id)).toEqual([]);
  });
});
