// 把原始 provider payload 拆成「结构视图」要展示的块。纯函数，只读不改。
//
// request 的形状随供应商变化，这里不假设固定结构，按字段嗅探：
//   Anthropic         system(串|块[]) / messages[content 块] / tools[{name,input_schema}]
//   OpenAI chat       messages[system|developer|user|assistant|tool] / tool_calls / tools[{function}]
//   OpenAI responses  instructions / input[message|function_call|function_call_output|reasoning]
//   Google / Bedrock  contents[parts] + systemInstruction / system[] + toolConfig.tools
// 认不出的字段不在结构视图里展示（`other` 只列出字段名），完整内容始终在 JSON 视图。
// cache 标记只在原始 payload 带 cache_control 时出现，从不推断。

type Obj = Record<string, unknown>;

export interface Block {
  role: string;
  /** text / thinking / `tool_use · 名` / `tool_result · id` / 原始类型名 … */
  kind: string;
  body: string;
  /** 原始块带 cache_control 时的标记，如 `cache ephemeral` */
  cache?: string;
}

export interface ToolRow {
  name: string;
  description: string;
}

export interface StructView {
  system: Block[];
  tools: ToolRow[];
  messages: Block[];
  /** 没被识别的顶层字段名（temperature、max_tokens …） */
  other: string[];
  /** 三段都是空：形状认不出来，界面提示去看 JSON */
  recognized: boolean;
}

export interface ResponseView {
  stopReason: string | null;
  error: string | null;
  blocks: Block[];
}

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

// 单块正文上限：工具结果可能很长，图片是 base64。完整内容在 JSON 视图里。
const MAX_BODY = 20_000;
const clip = (s: string): string =>
  s.length > MAX_BODY
    ? `${s.slice(0, MAX_BODY)}\n… 已截断，共 ${s.length} 字符，完整内容见 JSON 视图`
    : s;

const pretty = (v: unknown): string => JSON.stringify(v, null, 2) ?? "";

// 参数可能是对象，也可能是 JSON 字符串（OpenAI 的 function.arguments）。
const argsText = (v: unknown): string => {
  if (typeof v !== "string") return pretty(v);
  try {
    return pretty(JSON.parse(v));
  } catch {
    return v;
  }
};

// 工具结果的 content：串，或 [{type:'text',text}] 块列表。
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (isObj(p) && typeof p.text === "string" ? p.text : pretty(p)))
      .join("\n");
  return pretty(c);
}

const cacheOf = (o: Obj): string | undefined => {
  const t = isObj(o.cache_control) ? str(o.cache_control.type) : undefined;
  return t ? `cache ${t}` : undefined;
};

// 一个内容部件 → 一个块。
function partBlock(role: string, p: unknown): Block {
  if (typeof p === "string") return { role, kind: "text", body: clip(p) };
  if (!isObj(p)) return { role, kind: "raw", body: clip(pretty(p)) };
  const type = str(p.type);
  const cache = cacheOf(p);
  const mk = (kind: string, body: string): Block => ({
    role,
    kind,
    body: clip(body),
    ...(cache ? { cache } : {}),
  });
  if (
    type === "text" ||
    type === "input_text" ||
    type === "output_text" ||
    (type === undefined && typeof p.text === "string")
  )
    return mk("text", str(p.text) ?? "");
  if (type === "thinking" || type === "reasoning")
    return mk(type, str(p.thinking) ?? str(p.text) ?? pretty(p));
  if (
    type === "tool_use" ||
    type === "server_tool_use" ||
    type === "toolCall" ||
    type === "function_call"
  )
    return mk(
      `tool_use · ${str(p.name) ?? "?"}`,
      argsText(p.input ?? p.arguments),
    );
  if (type === "tool_result")
    return mk(
      `tool_result · ${str(p.tool_use_id) ?? "?"}`,
      (p.is_error ? "[is_error]\n" : "") + contentText(p.content),
    );
  if (type === "function_call_output")
    return mk(`tool_result · ${str(p.call_id) ?? "?"}`, contentText(p.output));
  // Google / Bedrock 的部件没有 type，靠键名区分
  if (isObj(p.functionCall))
    return mk(
      `tool_use · ${str(p.functionCall.name) ?? "?"}`,
      argsText(p.functionCall.args),
    );
  if (isObj(p.functionResponse))
    return mk(
      `tool_result · ${str(p.functionResponse.name) ?? "?"}`,
      pretty(p.functionResponse.response),
    );
  if (isObj(p.toolUse))
    return mk(
      `tool_use · ${str(p.toolUse.name) ?? "?"}`,
      argsText(p.toolUse.input),
    );
  if (isObj(p.toolResult))
    return mk(
      `tool_result · ${str(p.toolResult.toolUseId) ?? "?"}`,
      contentText(p.toolResult.content),
    );
  return mk(type ?? "raw", pretty(p));
}

// responses API 的顶层项没有 role，按类型归到模型侧或工具侧。
const ROLE_OF_TYPE: Record<string, string> = {
  function_call: "assistant",
  reasoning: "assistant",
  function_call_output: "tool",
};

// 一条对话项 → 若干块（一条消息的每个部件各自成块）。
function messageBlocks(m: unknown): Block[] {
  if (!isObj(m)) return [partBlock("?", m)];
  const type = str(m.type);
  const role = str(m.role) ?? (type && ROLE_OF_TYPE[type]) ?? type ?? "?";
  const content = m.content ?? m.parts;
  const out: Block[] = [];
  if (role === "tool" && str(m.tool_call_id))
    out.push({
      role,
      kind: `tool_result · ${m.tool_call_id}`,
      body: clip(contentText(content)),
    });
  else if (typeof content === "string") out.push(partBlock(role, content));
  else if (Array.isArray(content))
    for (const p of content) out.push(partBlock(role, p));
  if (Array.isArray(m.tool_calls))
    for (const tc of m.tool_calls) {
      const fn = isObj(tc) && isObj(tc.function) ? tc.function : {};
      out.push({
        role,
        kind: `tool_use · ${str(fn.name) ?? "?"}`,
        body: clip(argsText(fn.arguments)),
      });
    }
  // 没有 content 的项（responses 的 function_call 等）：整项当作一个部件
  return out.length ? out : [partBlock(role, m)];
}

const isSystemItem = (m: unknown): boolean =>
  isObj(m) && (m.role === "system" || m.role === "developer");

const CONV_KEYS = ["messages", "input", "contents"] as const;

function conversationKey(req: Obj): string | null {
  for (const k of CONV_KEYS) if (Array.isArray(req[k])) return k;
  return null;
}

function conversation(req: Obj): unknown[] {
  const key = conversationKey(req);
  return key ? (req[key] as unknown[]) : [];
}

const SYSTEM_KEYS = [
  "system",
  "instructions",
  "systemInstruction",
  "system_instruction",
] as const;

function systemBlocks(req: Obj, items: unknown[]): Block[] {
  const out: Block[] = [];
  for (const key of SYSTEM_KEYS) {
    const v = req[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string")
      out.push({
        role: "system",
        kind: key === "system" ? "text" : key,
        body: clip(v),
      });
    else if (Array.isArray(v))
      out.push(...v.map((p) => partBlock("system", p)));
    else if (isObj(v) && Array.isArray(v.parts))
      out.push(...v.parts.map((p) => partBlock("system", p)));
    else out.push(partBlock("system", v));
  }
  for (const m of items) if (isSystemItem(m)) out.push(...messageBlocks(m));
  return out;
}

function toolRow(t: unknown): ToolRow {
  if (!isObj(t)) return { name: "(未识别)", description: "" };
  // OpenAI chat 嵌在 function 里；Bedrock 嵌在 toolSpec 里；Anthropic / responses 平铺。
  const inner = isObj(t.function)
    ? t.function
    : isObj(t.toolSpec)
      ? t.toolSpec
      : t;
  return {
    name: str(inner.name) ?? str(t.name) ?? str(t.type) ?? "(未识别)",
    description: str(inner.description) ?? str(t.description) ?? "",
  };
}

function toolRows(req: Obj): ToolRow[] {
  const lists = [
    req.tools,
    isObj(req.toolConfig) ? req.toolConfig.tools : undefined,
  ];
  return lists.flatMap((l) =>
    Array.isArray(l)
      ? l.flatMap((t) =>
          isObj(t) && Array.isArray(t.functionDeclarations)
            ? t.functionDeclarations.map(toolRow)
            : [toolRow(t)],
        )
      : [],
  );
}

const RECOGNIZED = new Set<string>([
  "model",
  ...SYSTEM_KEYS,
  "messages",
  "input",
  "contents",
  "tools",
  "toolConfig",
]);

export function structOfRequest(req: unknown): StructView {
  if (!isObj(req))
    return {
      system: [],
      tools: [],
      messages: [],
      other: [],
      recognized: false,
    };
  const items = conversation(req);
  const system = systemBlocks(req, items);
  const tools = toolRows(req);
  const messages = items
    .filter((m) => !isSystemItem(m))
    .flatMap((m) => messageBlocks(m));
  return {
    system,
    tools,
    messages,
    other: Object.keys(req).filter((k) => !RECOGNIZED.has(k)),
    recognized: system.length + tools.length + messages.length > 0,
  };
}

/**
 * range（请求对话项下标，左闭右开）→ 结构视图「消息」块下标的左闭右开区间。
 * 一条消息按部件拆成多块，所以要把 range 之前的对话项的块数累加。
 * 请求形状认不出或 range 缺失时返回 null，结构视图不标范围。
 */
export function rangeBlockIndex(
  req: unknown,
  range: { from: number; to: number } | null | undefined,
): { from: number; to: number } | null {
  if (!isObj(req) || !range) return null;
  const items = conversation(req).filter((m) => !isSystemItem(m));
  const clamp = (n: number) => Math.max(0, Math.min(n, items.length));
  const from = clamp(range.from);
  const to = Math.max(from, clamp(range.to));
  let fromBlock = 0;
  for (let i = 0; i < from; i += 1)
    fromBlock += messageBlocks(items[i] as unknown).length;
  let toBlock = fromBlock;
  for (let i = from; i < to; i += 1)
    toBlock += messageBlocks(items[i] as unknown).length;
  return { from: fromBlock, to: toBlock };
}

// 边界下标 → 在完整 JSON 文本里的行首偏移。把「边界之前的对话项 + 一个占位项」序列化，
// 与完整 JSON 求公共前缀，再推进到下一行开头：边界一定落在某一行的行首。
function jsonLineOffset(
  req: Obj,
  key: string,
  items: readonly unknown[],
  at: number,
  fullJson: string,
): number | null {
  let truncated: string;
  try {
    truncated = JSON.stringify(
      {
        request: { ...req, [key]: [...items.slice(0, at), null] },
        response: null,
      },
      null,
      2,
    );
  } catch {
    return null;
  }
  let i = 0;
  const max = Math.min(truncated.length, fullJson.length);
  while (i < max && truncated[i] === fullJson[i]) i += 1;
  if (i === 0 || i >= fullJson.length) return null;
  let j = i;
  while (j < fullJson.length && /[\s,]/.test(fullJson[j] as string)) j += 1;
  const line = fullJson.lastIndexOf("\n", j);
  return line >= 0 ? line + 1 : null;
}

/**
 * range 在完整 JSON 文本里的字符区间（左闭右开），用来把 JSON 视图切三段。
 * 分别求 from、to 两个行首偏移：to == 消息总数时自然落在数组收尾行；
 * from == to（新增内容只在响应里）时区间为空。算不出时返回 null，整段展示。
 */
export function jsonRangeSpans(
  req: unknown,
  fullJson: string,
  range: { from: number; to: number } | null | undefined,
): { start: number; end: number } | null {
  if (!isObj(req) || !range) return null;
  const key = conversationKey(req);
  if (!key) return null;
  const items = req[key] as unknown[];
  const clamp = (n: number) => Math.max(0, Math.min(n, items.length));
  const from = clamp(range.from);
  const to = Math.max(from, clamp(range.to));
  const start = jsonLineOffset(req, key, items, from, fullJson);
  const end =
    to === from ? start : jsonLineOffset(req, key, items, to, fullJson);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

/** 消息段的条数：一条消息按部件拆成多块，条数要按原始对话项数。 */
export const messageCount = (req: unknown): number =>
  isObj(req) ? conversation(req).filter((m) => !isSystemItem(m)).length : 0;

export function structOfResponse(res: unknown): ResponseView {
  if (!isObj(res))
    return {
      stopReason: null,
      error: null,
      blocks: res == null ? [] : [partBlock("assistant", res)],
    };
  const c = res.content;
  const blocks =
    typeof c === "string"
      ? [partBlock("assistant", c)]
      : Array.isArray(c)
        ? c.map((p) => partBlock("assistant", p))
        : [partBlock("assistant", res)];
  return {
    stopReason: str(res.stopReason) ?? str(res.stop_reason) ?? null,
    error: str(res.errorMessage) ?? null,
    blocks,
  };
}

/**
 * JSON 视图与「复制」的内容：与 API 同形的 `{request, response}`，原样取自接口，不混入任何展示字段。
 */
export const exportJson = (r: {
  request: unknown;
  response: unknown;
}): string =>
  JSON.stringify({ request: r.request, response: r.response }, null, 2);
