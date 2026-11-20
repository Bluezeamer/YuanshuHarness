import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, test } from "vitest";
import {
  makeEnv,
  openSession,
  persistSession,
  startStub,
  writeModels,
} from "../../test/support/stub.js";
import {
  type ChatEntry,
  encodeCursor,
  hasDanglingToolCall,
  pageMessages,
  readCompactionDetails,
  readCompactions,
  readMessages,
  readNotices,
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

  test("历史投影带会话条目的 timestamp（对话页展示消息时间用）", async () => {
    const dir = dirOf();
    const file = await persistSession(stub, dir, ID, ["q1"]);
    const all = readMessages(file, dir, ID);
    const entries = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            message?: { role?: string };
          },
      )
      .filter(
        (e) =>
          e.type === "message" &&
          (e.message?.role === "user" || e.message?.role === "assistant"),
      );
    expect(all.map((m) => m.ts)).toEqual(entries.map((e) => e.timestamp));
    expect(all[0]?.ts).toEqual(expect.any(String));
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

describe("压缩条目与压缩前快照", () => {
  const ID = "01a14000-0000-7000-8000-0000000000cc";
  const NOW = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  type Raw = Record<string, unknown>;
  const message = (
    id: string,
    parentId: string | null,
    at: number,
    role: string,
    text: string,
  ): Raw => ({
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: { role, content: [{ type: "text", text }], timestamp: at },
  });
  const compaction = (
    id: string,
    parentId: string,
    at: number,
    o: { summary: string; firstKeptEntryId: string; system: string },
  ): Raw => ({
    type: "compaction",
    id,
    parentId,
    timestamp: iso(at),
    summary: o.summary,
    tokensBefore: 1234,
    firstKeptEntryId: o.firstKeptEntryId,
    systemMessage: { role: "system", content: o.system, timestamp: at },
  });
  // 手写会话 JSONL：header + 线性分支（压缩条目也在 parentId 链上）。
  const writeSession = (dir: string, entries: Raw[]) => {
    const file = path.join(dir, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
    writeFileSync(
      file,
      `${[
        {
          type: "session",
          version: 3,
          id: ID,
          timestamp: iso(NOW - 1000),
          cwd: "/work",
        },
        ...entries,
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    return file;
  };
  const messagesOf = (entries: Raw[]) =>
    entries.filter((e) => e.type === "message").map((e) => e.message as Raw);

  test("单次压缩：按时间编号，快照是压缩前的全部消息，system 取条目里的 systemMessage", () => {
    const dir = dirOf();
    const entries = [
      message("m1", null, NOW, "user", "一"),
      message("m2", "m1", NOW + 1, "assistant", "答一"),
      message("m3", "m2", NOW + 1000, "user", "二"),
      message("m4", "m3", NOW + 1001, "assistant", "答二"),
      compaction("c1", "m4", NOW + 2000, {
        summary: "摘要一",
        firstKeptEntryId: "m3",
        system: "系统提示",
      }),
      message("m5", "c1", NOW + 3000, "user", "三"),
      message("m6", "m5", NOW + 3001, "assistant", "答三"),
    ];
    const file = writeSession(dir, entries);
    expect(readCompactions(file, dir, ID)).toEqual([
      {
        seq: 1,
        createdAt: iso(NOW + 2000),
        summary: "摘要一",
        tokensBefore: 1234,
        afterIndex: 4,
      },
    ]);
    const details = readCompactionDetails(file, dir, ID);
    expect(details.map((d) => d.messageCount)).toEqual([4]);
    const snapshot = details[0]?.snapshot;
    expect(snapshot?.system).toBe("系统提示");
    expect(snapshot?.messages).toEqual(messagesOf(entries.slice(0, 4)));
  });

  test("第二次压缩：快照 = 上次摘要 + 上次保留点之后的消息", () => {
    const dir = dirOf();
    const entries = [
      message("m1", null, NOW, "user", "一"),
      message("m2", "m1", NOW + 1, "assistant", "答一"),
      message("m3", "m2", NOW + 1000, "user", "二"),
      message("m4", "m3", NOW + 1001, "assistant", "答二"),
      compaction("c1", "m4", NOW + 2000, {
        summary: "摘要一",
        firstKeptEntryId: "m3",
        system: "S1",
      }),
      message("m5", "c1", NOW + 3000, "user", "三"),
      message("m6", "m5", NOW + 3001, "assistant", "答三"),
      compaction("c2", "m6", NOW + 4000, {
        summary: "摘要二",
        firstKeptEntryId: "m5",
        system: "S2",
      }),
    ];
    const file = writeSession(dir, entries);
    expect(readCompactions(file, dir, ID).map((c) => c.afterIndex)).toEqual([
      4, 6,
    ]);
    const details = readCompactionDetails(file, dir, ID);
    expect(details.map((d) => d.messageCount)).toEqual([4, 5]);
    const second = details[1]?.snapshot;
    expect(second?.system).toBe("S2");
    const messages = (second?.messages ?? []) as Raw[];
    // 顺序与 SDK 的上下文一致：摘要最前，然后是上次保留的消息，再到新消息。
    expect(messages.map((m) => m.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[0]).toMatchObject({
      summary: "摘要一",
      tokensBefore: 1234,
    });
    expect(messages.slice(1)).toEqual(
      messagesOf(entries.slice(2, 4).concat(entries.slice(5, 7))),
    );
  });

  test("没有压缩条目的旧会话：两个函数都返回空", () => {
    const dir = dirOf();
    const file = writeSession(dir, [message("m1", null, NOW, "user", "一")]);
    expect(readCompactions(file, dir, ID)).toEqual([]);
    expect(readCompactionDetails(file, dir, ID)).toEqual([]);
  });
});

describe("真实压缩（SDK 写入的 compaction 条目）", () => {
  test("第一次压缩的快照 = 压缩前的全部消息（system 不进 messages）", async () => {
    const dir = dirOf();
    const id = "01a14000-0000-7000-8000-0000000000dd";
    const env = makeEnv();
    writeModels(env, stub.url);
    const manager = SessionManager.create(env.cwd, dir, { id });
    const { session } = await openSession(env, {
      sessionManager: manager,
      retry: false,
      // 保留窗口调到最小，让手动压缩真的切出「摘要 + 保留的消息」。
      compaction: { keepRecentTokens: 1, reserveTokens: 1 },
    });
    try {
      await session.prompt("一");
      await session.prompt("二");
      await session.compact();
      await session.prompt("三");
      const file = manager.getSessionFile();
      if (!file) throw new Error("会话没有落盘");
      const infos = readCompactions(file, dir, id);
      expect(infos).toHaveLength(1);
      // messages 接口的锚点：该压缩条目之前已有 4 条 user/assistant 投影。
      expect(infos[0]?.afterIndex).toBe(4);
      const details = readCompactionDetails(file, dir, id);
      const snapshot = details[0]?.snapshot;
      expect(details[0]?.messageCount).toBe(4);
      expect(
        (snapshot?.messages ?? []).map((m) => (m as { role: string }).role),
      ).toEqual(["user", "assistant", "user", "assistant"]);
      // 快照第一条就是第一次压缩前的第一条用户消息。
      expect(snapshot?.messages[0]).toMatchObject({ role: "user" });
    } finally {
      session.dispose();
    }
  });
});

describe("卡片锚点（projectNotices）", () => {
  const NOTICE_ID = "01a14000-0000-7000-8000-0000000000ee";
  const NOW = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  type Raw = Record<string, unknown>;
  const message = (
    id: string,
    parentId: string | null,
    at: number,
    role: string,
    text: string,
  ): Raw => ({
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: { role, content: [{ type: "text", text }], timestamp: at },
  });
  const toolResult = (id: string, parentId: string, at: number): Raw => ({
    type: "message",
    id,
    parentId,
    timestamp: iso(at),
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "out" }],
      isError: false,
      timestamp: at,
    },
  });
  const job = {
    id: "abc12345",
    kind: "command",
    name: "bash",
    label: "dev",
    ref: null,
    state: "done",
    exitCode: 0,
    startedAt: iso(NOW),
    endedAt: iso(NOW + 60_000),
  };
  const notice = (
    id: string,
    parentId: string,
    at: number,
    customType = "yuanshu.subagent",
    details: unknown = { job },
  ): Raw => ({
    type: "custom_message",
    id,
    parentId,
    timestamp: iso(at),
    customType,
    content: "job done",
    display: false,
    details,
  });
  const write = (dir: string, entries: Raw[]) => {
    const file = path.join(dir, `2026-01-01T00-00-00-000Z_${NOTICE_ID}.jsonl`);
    writeFileSync(
      file,
      `${[
        {
          type: "session",
          version: 3,
          id: NOTICE_ID,
          timestamp: iso(NOW - 1000),
          cwd: "/work",
        },
        ...entries,
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    return file;
  };
  const goalNotice = {
    event: "round" as const,
    goalId: "g1",
    round: 1,
    maxRounds: 50,
  };
  // 只出卡片的 custom 条目（不进模型上下文）
  const goalCard = (id: string, parentId: string, at: number): Raw => ({
    type: "custom",
    id,
    parentId,
    timestamp: iso(at),
    customType: "yuanshu.goal",
    data: { goal: { ...goalNotice, event: "set" } },
  });

  test("afterIndex 只数 user / assistant，toolResult 与别的条目不算；与消息交错也一致", () => {
    const dir = dirOf();
    const entries = [
      message("m1", null, NOW, "user", "一"),
      message("m2", "m1", NOW + 1, "assistant", "答一"),
      toolResult("t1", "m2", NOW + 2),
      // 第 2 条投影之后：afterIndex = 2
      notice("n1", "t1", NOW + 3),
      message("m3", "n1", NOW + 4, "user", "二"),
      // 不是后台任务回调的 custom 消息：不出锚点，也不数
      notice("n2", "m3", NOW + 5, "yuanshu.interrupted", {}),
      message("m4", "n2", NOW + 6, "assistant", "答二"),
      notice("n3", "m4", NOW + 7),
    ];
    const file = write(dir, entries);
    expect(readNotices(file, dir, NOTICE_ID)).toEqual([
      { afterIndex: 2, ts: iso(NOW + 3), kind: "job", job },
      { afterIndex: 4, ts: iso(NOW + 7), kind: "job", job },
    ]);
    // 与消息投影的条数对得上
    expect(readMessages(file, dir, NOTICE_ID)).toHaveLength(4);
  });

  test("目标卡片两种持久化形态都投影：注入消息走 details，其余走 custom 条目的 data", () => {
    const dir = dirOf();
    const entries = [
      message("m1", null, NOW, "user", "一"),
      // 注入的目标消息：custom_message，进模型上下文
      notice("g1", "m1", NOW + 1, "yuanshu.goal", { goal: goalNotice }),
      goalCard("g2", "g1", NOW + 2),
      message("m2", "g2", NOW + 3, "assistant", "答一"),
    ];
    const file = write(dir, entries);
    expect(readNotices(file, dir, NOTICE_ID)).toEqual([
      { afterIndex: 1, ts: iso(NOW + 1), kind: "goal", goal: goalNotice },
      {
        afterIndex: 1,
        ts: iso(NOW + 2),
        kind: "goal",
        goal: { ...goalNotice, event: "set" },
      },
    ]);
  });

  test("没有卡片条目时为空数组", () => {
    const dir = dirOf();
    const file = write(dir, [message("m1", null, NOW, "user", "一")]);
    expect(readNotices(file, dir, NOTICE_ID)).toEqual([]);
  });
});
