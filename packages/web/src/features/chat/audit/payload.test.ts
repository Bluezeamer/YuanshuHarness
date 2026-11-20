import { expect, test } from "vitest";
import {
  exportJson,
  jsonRangeSpans,
  messageCount,
  rangeBlockIndex,
  structOfRequest,
  structOfResponse,
} from "./payload";
import { anthropicRequest, piResponse } from "./testkit";

// ── Anthropic 风格 ──

test("Anthropic：system 块、工具、消息按部件拆块，cache_control 才出现 cache 标记", () => {
  const v = structOfRequest(anthropicRequest(1));
  expect(v.recognized).toBe(true);
  expect(v.system.map((b) => b.kind)).toEqual(["text", "text", "text"]);
  expect(v.system.map((b) => b.cache)).toEqual([
    undefined,
    undefined,
    "cache ephemeral",
  ]);
  expect(v.tools).toEqual([
    { name: "read_file", description: "读取文件" },
    { name: "edit_file", description: "修改文件" },
  ]);
  expect(v.messages.map((b) => `${b.role}:${b.kind}`)).toEqual([
    "user:text",
    "assistant:text",
    "assistant:tool_use · read_file",
    "user:tool_result · toolu_1",
  ]);
  expect(v.messages[2]?.body).toContain('"path": "a.ts"');
  expect(v.other).toEqual(["max_tokens"]);
  expect(messageCount(anthropicRequest(1))).toBe(3);
});

test("Anthropic：system 是字符串；tool_result 的 content 是块列表；is_error 标出", () => {
  const v = structOfRequest({
    system: "只有一段",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_9",
            is_error: true,
            content: [{ type: "text", text: "boom" }],
          },
        ],
      },
    ],
  });
  expect(v.system).toEqual([
    { role: "system", kind: "text", body: "只有一段" },
  ]);
  expect(v.messages[0]?.kind).toBe("tool_result · toolu_9");
  expect(v.messages[0]?.body).toBe("[is_error]\nboom");
});

// ── OpenAI 风格 ──

const openaiChat = {
  model: "gpt-x",
  temperature: 0.2,
  messages: [
    { role: "system", content: "系统提示" },
    { role: "developer", content: "开发者提示" },
    { role: "user", content: "你好" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "ls", arguments: '{"dir":"/"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "a b c" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "ls", description: "列目录", parameters: {} },
    },
  ],
};

test("OpenAI chat：system/developer 归系统段，tool_calls 与 tool 消息成块，tools 取 function 内字段", () => {
  const v = structOfRequest(openaiChat);
  expect(v.system.map((b) => b.body)).toEqual(["系统提示", "开发者提示"]);
  expect(v.messages.map((b) => `${b.role}:${b.kind}`)).toEqual([
    "user:text",
    "assistant:tool_use · ls",
    "tool:tool_result · call_1",
  ]);
  // arguments 是 JSON 字符串，展开成缩进的 JSON
  expect(v.messages[1]?.body).toBe('{\n  "dir": "/"\n}');
  expect(v.tools).toEqual([{ name: "ls", description: "列目录" }]);
  expect(v.other).toEqual(["temperature"]);
  // 系统项不算消息
  expect(messageCount(openaiChat)).toBe(3);
  // 没有 cache_control 就没有 cache 标记，不伪造
  expect([...v.system, ...v.messages].some((b) => b.cache)).toBe(false);
});

test("OpenAI responses：instructions + input 项（function_call / function_call_output / reasoning）", () => {
  const v = structOfRequest({
    instructions: "按要求办事",
    input: [
      { role: "user", content: [{ type: "input_text", text: "列目录" }] },
      { type: "reasoning", summary: [], text: "想一想" },
      { type: "function_call", call_id: "fc1", name: "ls", arguments: "{}" },
      { type: "function_call_output", call_id: "fc1", output: "ok" },
    ],
    tools: [{ type: "function", name: "ls", description: "列目录" }],
  });
  expect(v.system).toEqual([
    { role: "system", kind: "instructions", body: "按要求办事" },
  ]);
  expect(v.messages.map((b) => `${b.role}:${b.kind}`)).toEqual([
    "user:text",
    "assistant:reasoning",
    "assistant:tool_use · ls",
    "tool:tool_result · fc1",
  ]);
  expect(v.tools[0]?.name).toBe("ls");
});

test("Google：systemInstruction.parts / contents.parts / functionCall / functionDeclarations", () => {
  const v = structOfRequest({
    systemInstruction: { parts: [{ text: "系统" }] },
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "ls", args: { d: 1 } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "ls", response: { ok: true } } }],
      },
    ],
    tools: [{ functionDeclarations: [{ name: "ls", description: "列目录" }] }],
  });
  expect(v.system[0]?.body).toBe("系统");
  expect(v.messages.map((b) => b.kind)).toEqual([
    "text",
    "tool_use · ls",
    "tool_result · ls",
  ]);
  expect(v.tools).toEqual([{ name: "ls", description: "列目录" }]);
});

// ── 未知形状 ──

test("未知形状：不抛错，三段为空、标记未识别，其余字段名列出", () => {
  for (const raw of [
    { foo: "bar", n: 1 },
    {},
    [],
    "字符串",
    null,
    42,
    undefined,
  ]) {
    const v = structOfRequest(raw);
    expect(v.system).toEqual([]);
    expect(v.tools).toEqual([]);
    expect(v.messages).toEqual([]);
    expect(v.recognized).toBe(false);
  }
  expect(structOfRequest({ foo: "bar", n: 1 }).other).toEqual(["foo", "n"]);
});

test("残缺的块也不崩：缺字段、嵌套怪值", () => {
  const v = structOfRequest({
    messages: [
      null,
      7,
      { role: "user" },
      {
        role: "user",
        content: [null, { type: "image" }, { type: "tool_use" }],
      },
    ],
    tools: [null, {}, { name: 3 }],
    system: { weird: true },
  });
  expect(v.messages.length).toBeGreaterThan(0);
  expect(v.tools.map((t) => t.name)).toEqual([
    "(未识别)",
    "(未识别)",
    "(未识别)",
  ]);
  expect(v.system).toHaveLength(1);
});

test("超长正文截断并指向 JSON 视图", () => {
  const v = structOfRequest({
    messages: [{ role: "user", content: "x".repeat(30_000) }],
  });
  const body = v.messages[0]?.body ?? "";
  expect(body.length).toBeLessThan(21_000);
  expect(body).toContain("已截断");
});

// ── 响应 ──

test("响应（pi 归一化形状）：text / thinking / toolCall，带 stopReason", () => {
  const r = structOfResponse({
    content: [
      { type: "thinking", thinking: "想想" },
      { type: "text", text: "好的" },
      { type: "toolCall", id: "c1", name: "ls", arguments: { d: 1 } },
    ],
    stopReason: "toolUse",
    errorMessage: "半路断了",
  });
  expect(r.stopReason).toBe("toolUse");
  expect(r.error).toBe("半路断了");
  expect(r.blocks.map((b) => b.kind)).toEqual([
    "thinking",
    "text",
    "tool_use · ls",
  ]);
});

test("响应：Anthropic 原形（stop_reason / tool_use）与未知形状都能容错", () => {
  const a = structOfResponse({
    content: [{ type: "tool_use", id: "t", name: "ls", input: {} }],
    stop_reason: "tool_use",
  });
  expect(a.stopReason).toBe("tool_use");
  expect(a.blocks[0]?.kind).toBe("tool_use · ls");
  const u = structOfResponse({ choices: [{ message: "x" }] });
  expect(u.blocks).toHaveLength(1);
  expect(structOfResponse(null).blocks).toEqual([]);
  expect(structOfResponse("纯文本").blocks[0]?.body).toBe("纯文本");
});

// ── 导出 ──

test("exportJson：与 API 同形的 {request, response}，原样、不混入展示字段", () => {
  const request = anthropicRequest(2);
  const response = piResponse("好", "toolUse");
  const rec = {
    request,
    response,
    tokens: { system: 1 },
    id: "x",
    summary: "不应出现",
  };
  const text = exportJson(rec);
  expect(JSON.parse(text)).toEqual({ request, response });
  expect(Object.keys(JSON.parse(text))).toEqual(["request", "response"]);
  // 结构视图的展示标记（`cache ephemeral` 字样、role/kind）不在导出里
  expect(text).not.toContain("cache ephemeral");
  expect(text).not.toContain('"kind"');
  expect(text).not.toContain("不应出现");
  // 原始 payload 自带的 cache_control 是请求的一部分，保留
  expect(text).toContain('"cache_control"');
});

test("rangeBlockIndex：消息项区间按块数累加成消息块区间", () => {
  // 3 条消息拆成 4 块：user:text / assistant:text / assistant:tool_use / user:tool_result
  const req = anthropicRequest(5);
  expect(structOfRequest(req).messages).toHaveLength(4);
  expect(rangeBlockIndex(req, { from: 0, to: 1 })).toEqual({ from: 0, to: 1 });
  expect(rangeBlockIndex(req, { from: 1, to: 2 })).toEqual({ from: 1, to: 3 });
  expect(rangeBlockIndex(req, { from: 2, to: 3 })).toEqual({ from: 3, to: 4 });
  // 同段最后一次调用可以没有新增消息（范围为空，起点落在末尾）
  expect(rangeBlockIndex(req, { from: 3, to: 3 })).toEqual({ from: 4, to: 4 });
  // 越界的下标夹到消息总数
  expect(rangeBlockIndex(req, { from: 9, to: 12 })).toEqual({
    from: 4,
    to: 4,
  });
  expect(rangeBlockIndex(req, null)).toBeNull();
  expect(rangeBlockIndex({ foo: 1 }, { from: 0, to: 1 })).toEqual({
    from: 0,
    to: 0,
  });
  expect(rangeBlockIndex("字符串", { from: 0, to: 1 })).toBeNull();
});

test("jsonRangeSpans：按 range 把完整 JSON 切成三段，拼回仍是完整 JSON", () => {
  const req = anthropicRequest(6);
  const res = piResponse("好");
  const full = exportJson({ request: req, response: res });
  const spans = jsonRangeSpans(req, full, { from: 1, to: 2 });
  expect(spans).not.toBeNull();
  const { start, end } = spans as { start: number; end: number };
  // 两个切点都落在行首，切出来的三段拼回去就是原文
  expect(full.slice(0, start).endsWith("\n")).toBe(true);
  expect(full.slice(0, end).endsWith("\n")).toBe(true);
  const head = full.slice(0, start);
  const mid = full.slice(start, end);
  const tail = full.slice(end);
  expect(head + mid + tail).toBe(full);
  expect(JSON.parse(full)).toEqual({ request: req, response: res });
  expect(head).not.toContain("tool_use");
  expect(mid).toContain("tool_use");
  expect(mid).not.toContain("tool_result");
  expect(tail).toContain("tool_result");
});

test("jsonRangeSpans：范围从头到尾 / 只在末尾 / 空范围都不切坏", () => {
  const req = anthropicRequest(7);
  const full = exportJson({ request: req, response: piResponse("好") });

  const all = jsonRangeSpans(req, full, { from: 0, to: 3 }) as {
    start: number;
    end: number;
  };
  expect(all).not.toBeNull();
  expect(full.slice(0, all.start)).toContain('"messages"');
  const allMid = full.slice(all.start, all.end);
  expect(allMid).toContain("请处理第 7 步");
  expect(allMid).toContain("tool_use");
  expect(allMid).toContain("tool_result");
  expect(full.slice(all.end)).toContain('"response"');

  // to == 消息总数：结束位置落在数组收尾行，后面只剩闭括号与 response
  const toEnd = jsonRangeSpans(req, full, { from: 2, to: 3 }) as {
    start: number;
    end: number;
  };
  expect(toEnd).not.toBeNull();
  expect(full.slice(toEnd.start, toEnd.end)).toContain("tool_result");
  expect(full.slice(toEnd.end)).toContain('"response"');
  expect(full.slice(0, toEnd.start) + full.slice(toEnd.start)).toBe(full);

  // from == to == 消息总数：最后一次调用只新增响应，区间为空
  const empty = jsonRangeSpans(req, full, { from: 3, to: 3 }) as {
    start: number;
    end: number;
  };
  expect(empty).not.toBeNull();
  expect(empty.start).toBe(empty.end);

  expect(jsonRangeSpans(req, full, null)).toBeNull();
  expect(jsonRangeSpans({}, full, { from: 0, to: 1 })).toBeNull();
  expect(jsonRangeSpans("字符串", full, { from: 0, to: 1 })).toBeNull();
});
