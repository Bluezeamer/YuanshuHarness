import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Db, openDatabase } from "../store/db.js";
import { SessionFileStore } from "../store/session-files.js";
import { estimateTokens, SessionFiles } from "./context-files.js";

let dir: string;
let db: Db;
let store: SessionFileStore;
let host = "local";
let changes: number[] = [];
let files: SessionFiles;
let n = 0;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "yuanshu-ctxfiles-"));
  db = openDatabase(dir);
  store = new SessionFileStore(db);
  host = "local";
  changes = [];
  n = 0;
  files = new SessionFiles(
    "s",
    store,
    () => host,
    (c) => changes.push(c),
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// 依次喂一次工具调用的开始与结束事件。
function call(
  tool: string,
  args: Record<string, unknown>,
  result: unknown = { content: [{ type: "text", text: "" }] },
  isError = false,
): void {
  const toolCallId = `c${n++}`;
  files.observe({
    type: "tool_execution_start",
    toolCallId,
    toolName: tool,
    args,
  } as AgentSessionEvent);
  vi.advanceTimersByTime(1000);
  files.observe({
    type: "tool_execution_end",
    toolCallId,
    toolName: tool,
    result,
    isError,
  } as AgentSessionEvent);
}

const text = (t: string, details?: unknown) => ({
  content: [{ type: "text", text: t }],
  ...(details === undefined ? {} : { details }),
});

test("token 估算：CJK 一字一 token，其余按 3.2 字符一 token 向上取整", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("你好世界")).toBe(4);
  expect(estimateTokens("abcdefgh")).toBe(3); // 8 / 3.2 = 2.5
  expect(estimateTokens("你好 abc")).toBe(4); // 2 + 4 / 3.2 = 3.25
});

test("read 命中累计 reads，同路径合并，token 取各次最大", () => {
  call("read", { path: "/w/a.ts" }, text("x".repeat(320)));
  call("read", { path: "/w/a.ts" }, text("x".repeat(64)));
  call("read", { path: "/w/b.md" }, text("中".repeat(10)));
  const { files: list } = store.list("s");
  expect(list.map((f) => f.path)).toEqual(["/w/b.md", "/w/a.ts"]);
  expect(list[1]).toMatchObject({
    path: "/w/a.ts",
    hostId: "local",
    tokens: 100,
    reads: 2,
    modified: false,
    truncated: false,
  });
  expect(list[0]).toMatchObject({ tokens: 10, reads: 1 });
  // 每次变化都通知一次，参数是条数
  expect(changes).toEqual([1, 1, 2]);
});

test("edit / write 成功置 modified；write 的 token 取写入内容；不存内容", () => {
  call("read", { path: "/w/a.ts" }, text("x".repeat(320)));
  call("edit", { path: "/w/a.ts", edits: [{ oldText: "x", newText: "y" }] });
  expect(store.get("s", "local", "/w/a.ts")).toMatchObject({
    modified: true,
    reads: 1,
    tokens: 100,
  });
  call("write", { path: "/w/new.txt", content: "z".repeat(32) });
  expect(store.get("s", "local", "/w/new.txt")).toMatchObject({
    modified: true,
    reads: 0,
    tokens: 10,
  });
  // 只存路径与计数
  const dump = JSON.stringify(db.prepare("SELECT * FROM session_files").all());
  expect(dump).not.toContain("zzzz");
  // 只 edit 没读过的文件：token 未知记 0
  call("edit", { path: "/w/blind.ts", edits: [] });
  expect(store.get("s", "local", "/w/blind.ts")).toMatchObject({
    tokens: 0,
    reads: 0,
    modified: true,
  });
});

test("截断：SDK 标记的超大结果与带 limit 的分段读取都带 truncated，完整重读后清除", () => {
  call(
    "read",
    { path: "/w/big.log" },
    text("x".repeat(3200), { truncation: { truncated: true } }),
  );
  expect(store.get("s", "local", "/w/big.log")).toMatchObject({
    tokens: 1000,
    truncated: true,
  });
  call("read", { path: "/w/big.log" }, text("y".repeat(10)));
  expect(store.get("s", "local", "/w/big.log")).toMatchObject({
    tokens: 1000,
    truncated: false,
    reads: 2,
  });
  call(
    "read",
    { path: "/w/seg.txt", limit: 2 },
    text("a\nb\n\n[98 more lines in file. Use offset=3 to continue.]"),
  );
  expect(store.get("s", "local", "/w/seg.txt")?.truncated).toBe(true);
});

test("失败的调用、其他工具、没有路径的调用都不记录；hostId 取调用结束时的环境", () => {
  call("read", { path: "/w/missing" }, text("ENOENT"), true);
  call("write", { path: "/w/x", content: "c" }, text("denied"), true);
  call("bash", { command: "cat /w/a" });
  call("read", {});
  call("read", { path: "   " });
  expect(store.list("s").files).toEqual([]);
  expect(changes).toEqual([]);

  call("read", { path: "/w/a" }, text("abc"));
  host = "ssh-1";
  call("read", { path: "/w/a" }, text("abc"));
  expect(
    store
      .list("s")
      .files.map((f) => `${f.hostId}:${f.path}:${f.reads}`)
      .sort(),
  ).toEqual(["local:/w/a:1", "ssh-1:/w/a:1"]);
});

test("没有 store 时什么都不做；agent_end 清掉没有结束的调用", () => {
  const off = new SessionFiles(
    "s",
    undefined,
    () => "local",
    () => {
      throw new Error("不应通知");
    },
  );
  off.observe({
    type: "tool_execution_start",
    toolCallId: "x",
    toolName: "read",
    args: { path: "/a" },
  } as AgentSessionEvent);
  off.observe({
    type: "tool_execution_end",
    toolCallId: "x",
    toolName: "read",
    result: text("a"),
    isError: false,
  } as AgentSessionEvent);

  files.observe({
    type: "tool_execution_start",
    toolCallId: "dangling",
    toolName: "read",
    args: { path: "/w/a" },
  } as AgentSessionEvent);
  files.observe({
    type: "agent_end",
    messages: [],
    willRetry: false,
  } as AgentSessionEvent);
  files.observe({
    type: "tool_execution_end",
    toolCallId: "dangling",
    toolName: "read",
    result: text("a"),
    isError: false,
  } as AgentSessionEvent);
  expect(store.list("s").files).toEqual([]);
});
