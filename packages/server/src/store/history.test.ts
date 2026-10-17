import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { persistSession, startStub } from "../../test/support/stub.js";
import {
  type ChatEntry,
  encodeCursor,
  hasDanglingToolCall,
  pageMessages,
  readMessages,
} from "./history.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());
const dirOf = () => mkdtempSync(path.join(tmpdir(), "yuanshu-hist-"));
const ID = "01a14000-0000-7000-8000-0000000000aa";

describe("R16/R17 读取与分页", () => {
  test("当前分支的 user/assistant 消息按序位排列，system 不出现", async () => {
    const dir = dirOf();
    const file = await persistSession(stub, dir, ID, ["q1", "q2"]);
    const all = readMessages(file, dir, ID);
    expect(all.map((m) => [m.index, m.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "user"],
      [3, "assistant"],
    ]);
    expect(all[0]?.text).toBe("q1");
  });

  test("读取不修改文件；文件头无效（空文件、乱码）时抛错而不交给 SDK", async () => {
    const dir = dirOf();
    const file = await persistSession(stub, dir, ID, ["q1"]);
    const before = readFileSync(file);
    readMessages(file, dir, ID);
    expect(readFileSync(file)).toEqual(before);
    const empty = path.join(
      dir,
      `2026-01-01T00-00-00-000Z_${ID.replace(/a$/, "b")}.jsonl`,
    );
    writeFileSync(empty, "");
    expect(() => readMessages(empty, dir, ID.replace(/a$/, "b"))).toThrow(
      /文件头无效/,
    );
    expect(readFileSync(empty, "utf8")).toBe("");
  });

  const mk = (n: number): ChatEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      index: i,
      role: i % 2 ? "assistant" : "user",
      text: `m${i}`,
    }));

  test("120 条分页遍历：无重复无遗漏、顺序正确", () => {
    const all = mk(120);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const r = pageMessages(all, cursor, "50");
      if (!r.ok) throw new Error("bad page");
      seen.unshift(...r.messages.map((m) => m.index));
      if (r.nextBefore === null) break;
      cursor = r.nextBefore;
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i));
  });

  test("遍历中途追加新消息：已取页与后续页都不变（游标按绝对序位）", () => {
    const first = pageMessages(mk(120), undefined, "50");
    if (!first.ok || first.nextBefore === null) throw new Error();
    const grown = pageMessages(
      [...mk(120), ...mk(10).map((m) => ({ ...m, index: m.index + 120 }))],
      first.nextBefore,
      "50",
    );
    const base = pageMessages(mk(120), first.nextBefore, "50");
    expect(grown).toEqual(base);
  });

  test("limit 与游标的边界和非法值", () => {
    const all = mk(10);
    expect(pageMessages(all, undefined, undefined)).toMatchObject({
      ok: true,
      nextBefore: null,
    });
    for (const bad of ["0", "201", "-1", "1.5", "abc", ""])
      expect(pageMessages(all, undefined, bad)).toEqual({ ok: false });
    expect(pageMessages(all, undefined, "200")).toMatchObject({ ok: true });
    for (const bad of [
      "!!",
      "",
      encodeCursor(11),
      Buffer.from("-1").toString("base64url"),
      Buffer.from("1e1").toString("base64url"),
      Buffer.from("x").toString("base64url"),
    ])
      expect(pageMessages(all, bad, "5")).toEqual({ ok: false });
    expect(pageMessages(all, encodeCursor(0), "5")).toMatchObject({
      ok: true,
      messages: [],
      nextBefore: null,
    });
  });
});

describe("悬挂工具调用检测（R12 的输入）", () => {
  const tcEntry = (parent: string, ids: string[]) => ({
    type: "message",
    id: "zz01",
    parentId: parent,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: ids.map((id) => ({
        type: "toolCall",
        id,
        name: "t",
        arguments: {},
      })),
      api: "openai-completions",
      provider: "stub",
      model: "stub-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
  });
  const lastId = (file: string) => {
    const ls = readFileSync(file, "utf8").trim().split("\n");
    return JSON.parse(ls[ls.length - 1] as string).id as string;
  };

  test("正常结束的会话没有悬挂；末尾助手消息含无结果的调用则有", async () => {
    const dir = dirOf();
    const file = await persistSession(stub, dir, ID, ["q"]);
    expect(hasDanglingToolCall(file, dir, ID)).toBe(false);
    appendFileSync(file, `${JSON.stringify(tcEntry(lastId(file), ["c1"]))}\n`);
    expect(hasDanglingToolCall(file, dir, ID)).toBe(true);
  });

  test("多个调用只有部分有结果时仍算悬挂；全部有结果则不是", async () => {
    const dir = dirOf();
    const file = await persistSession(stub, dir, ID, ["q"]);
    appendFileSync(
      file,
      `${JSON.stringify(tcEntry(lastId(file), ["c1", "c2"]))}\n`,
    );
    const res = (parent: string, callId: string, id: string) => ({
      type: "message",
      id,
      parentId: parent,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "t",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: Date.now(),
      },
    });
    appendFileSync(file, `${JSON.stringify(res("zz01", "c1", "zz02"))}\n`);
    expect(hasDanglingToolCall(file, dir, ID)).toBe(true);
    appendFileSync(file, `${JSON.stringify(res("zz02", "c2", "zz03"))}\n`);
    expect(hasDanglingToolCall(file, dir, ID)).toBe(false);
  });
});
