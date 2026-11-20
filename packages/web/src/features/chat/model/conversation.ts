import {
  type Block,
  type Goal,
  type GoalNotice,
  type JobSnapshot,
  type Known,
  type MessageAttachment,
  type NoticeBody,
  parseAttachments,
} from "../../../api";

// 会话流的纯 reducer：快照整体替换，其余帧按增量套用。
// 未识别的帧原样忽略、新增字段全部容错，协议扩展不会让界面崩。

export interface Frame {
  session: string;
  seq: number;
  type: string;
  ts?: string;
  data: Record<string, unknown>;
}

export interface Tool {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
  args?: unknown;
  output?: string;
  durationMs?: number;
  /** 有值 = 另一工具（如 call_tool）发起的嵌套调用，渲染时归到父调用内部 */
  parentId?: string;
}

/**
 * 实时到达的卡片（后台任务回调、目标）。at 是它到达时窗口里已有的消息条数；
 * 历史接口给的是绝对序位，两者在对话流里合并（见 tab/Stream.tsx）。
 */
export type LiveNotice = NoticeBody & { at: number; ts: string };

/** 答复弹窗：选项、文字、附件三者的任意组合，至少一样（选项 + 文字 = 选了这项并补一句话）。 */
export interface AnswerBody {
  optionId?: string;
  text?: string;
  attachments?: { path: string }[];
}

export interface PromptOption {
  id: string;
  label: string;
}

// prompt.requested.data 的客户端视图（ADR-0028）。
export interface Prompt {
  promptId: string;
  source: "approval" | "question";
  title: string;
  body: string | null;
  /** 没有选项时是 []；选项是快捷回复 */
  options: PromptOption[];
  /** 有没有输入框：null = 只能选选项（插件的选择 / 确认）；text = 文字（审批里是拒绝理由）；rich = 文字加附件 */
  input: "text" | "rich" | null;
  detail: { tool: string; summary: string } | null;
  // 毫秒时间戳；服务端给的是 ISO 串或数字都接受，解析不了为 null。
  expiresAt: number | null;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// 最近一次压缩；事件里没有 at 时取帧的 ts。
export interface CompactInfo {
  summary: string;
  savedPct: number;
  at?: string;
}

export interface TokenCount {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// 当前上下文占用（最近一次模型调用）；system / tools 缺失时为 undefined。
export interface ContextUsage {
  used: number;
  window: number | null;
  messages: number;
  system?: number;
  tools?: number;
}

// 会话累计用量，形状即 GET /sessions/:id/usage；input 含缓存读写。
export interface UsageStat {
  turns: number;
  steps: number;
  tokensPerSecond: number | null;
  modelMs: number | null;
  // 工具调用用时（会话累计）与首 token 平均耗时：服务端旁路统计，统计不到为 null。
  toolMs: number | null;
  ttftMs: number | null;
  tokens: TokenCount;
  cacheHitRate: number | null;
  context: ContextUsage | null;
}

/** 正在生成参数、还没开始执行的工具调用（流式 toolcall delta 累积出来的预览）。 */
export interface PendingTool {
  id: string;
  name: string;
  args: string;
}

export interface ConvState {
  messages: Known[];
  partial: string | null;
  /** 正在生成的思考增量；结束后清空（落定的思考在消息 blocks 里） */
  partialThinking: string;
  /** 正在生成参数的工具调用 */
  pendingTools: PendingTool[];
  tools: Tool[];
  running: boolean;
  queue: string[];
  prompts: Prompt[];
  error: string | null;
  goal: Goal | null;
  todos: Todo[];
  compact: CompactInfo | null;
  // 最近一次压缩失败的原因；压缩成功后清除。
  compactError: string | null;
  // 会话累计用量；没有调用记录库的服务端永远是 null。
  usage: UsageStat | null;
  // 最近一轮的步数 / 会话累计轮数，来自 run.ended。
  steps: number | null;
  turn: number | null;
  // flows.updated 到一次加 1（快照也加 1：断线期间可能漏了），界面据此重取；flowsChanged 是最近一批变更的 id。
  flowsRev: number;
  flowsChanged: string[];
  // context.updated 到一次加 1（快照也加 1），界面据此重取读取的文件与已加载能力。
  contextRev: number;
  // turn.changes 到一次加 1：服务端把本轮改动清单落库后才推这一帧，
  // 界面收到就重取清单——由空闲推不出来（写库是收尾异步做的，会晚于 run.ended）。
  turnRev: number;
  // 本连接收到的卡片（后台任务回调、目标）；快照时清空（持久的那些由历史接口给）
  notices: LiveNotice[];
  // jobs.updated 到一次加 1（快照与回调卡片到达也加 1），右栏的后台任务块据此重取
  jobsRev: number;
  // fs.changed 按环境各自加 1：文件浏览器 / 文件预览据自己那个环境的版本号重取。
  fsRev: Record<string, number>;
}

export const initial: ConvState = {
  messages: [],
  partial: null,
  partialThinking: "",
  pendingTools: [],
  tools: [],
  running: false,
  queue: [],
  prompts: [],
  error: null,
  goal: null,
  todos: [],
  compact: null,
  compactError: null,
  usage: null,
  steps: null,
  turn: null,
  flowsRev: 0,
  flowsChanged: [],
  contextRev: 0,
  turnRev: 0,
  notices: [],
  jobsRev: 0,
  fsRev: {},
};

// store 在 run.ended 之后重取 /usage 得到精确值，用这个本地帧塞回 reducer；与服务端帧类型不会重名。
export const USAGE_LOADED = "local.usage_loaded";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const JOB_STATES = ["running", "done", "failed", "stopped", "interrupted"];
const JOB_KINDS = ["command", "tool", "subagent"];

// 形状不对的任务快照丢弃，同弹窗
function parseJob(v: unknown): JobSnapshot | null {
  const d = obj(v);
  if (!d || typeof d.id !== "string" || !d.id) return null;
  if (!JOB_STATES.includes(str(d.state)) || !JOB_KINDS.includes(str(d.kind)))
    return null;
  return {
    id: d.id,
    kind: d.kind as JobSnapshot["kind"],
    name: str(d.name),
    label: str(d.label),
    ref: typeof d.ref === "string" ? d.ref : null,
    state: d.state as JobSnapshot["state"],
    exitCode: num(d.exitCode),
    startedAt: str(d.startedAt),
    endedAt: typeof d.endedAt === "string" ? d.endedAt : null,
  };
}

const role = (v: unknown): "user" | "assistant" | null =>
  v === "user" || v === "assistant" ? v : null;

const time = (v: unknown): number | null => {
  const t =
    typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

// 形状不对的弹窗丢弃，不让一条坏数据拖垮界面。
function parsePrompt(v: unknown): Prompt | null {
  const d = v as Record<string, unknown> | null;
  if (!d || typeof d.promptId !== "string" || !d.promptId) return null;
  const opts = Array.isArray(d.options) ? d.options : [];
  const det = d.detail as { tool?: unknown; summary?: unknown } | null;
  return {
    promptId: d.promptId,
    source: d.source === "approval" ? "approval" : "question",
    title: str(d.title),
    body: typeof d.body === "string" && d.body ? d.body : null,
    input: d.input === "text" || d.input === "rich" ? d.input : null,
    options: opts.flatMap((o: { id?: unknown; label?: unknown }) =>
      typeof o?.id === "string"
        ? [{ id: o.id, label: str(o.label) || o.id }]
        : [],
    ),
    detail:
      det && typeof det === "object" && typeof det.tool === "string"
        ? { tool: det.tool, summary: str(det.summary) }
        : null,
    expiresAt: time(d.expiresAt),
  };
}

const GOAL_STATES = ["active", "paused", "blocked", "complete"];
const GOAL_REASONS = [
  "user-paused",
  "user-stopped",
  "request-failed",
  "server-restart",
  "no-tool-calls",
  "round-limit",
  "model-blocked",
];
const GOAL_EVENTS = [
  "round",
  "set",
  "edited",
  "paused",
  "resumed",
  "cleared",
  "complete",
  "blocked",
];

function parseReason(v: unknown): Goal["reason"] | null {
  const d = obj(v);
  if (!d || !GOAL_REASONS.includes(str(d.code))) return null;
  return {
    code: d.code as NonNullable<Goal["reason"]>["code"],
    ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
  };
}

export function parseGoal(v: unknown): Goal | null {
  const d = obj(v);
  if (!d || typeof d.text !== "string" || d.text === "") return null;
  if (typeof d.id !== "string" || !GOAL_STATES.includes(str(d.state)))
    return null;
  const reason = parseReason(d.reason);
  const attachments = parseAttachments(d.attachments);
  return {
    id: d.id,
    revision: num(d.revision) ?? 0,
    text: d.text,
    ...(attachments ? { attachments } : {}),
    by: d.by === "model" ? "model" : "user",
    state: d.state as Goal["state"],
    ...(reason ? { reason } : {}),
    maxRounds: num(d.maxRounds),
    rounds: num(d.rounds) ?? 0,
    since: str(d.since),
    updatedAt: str(d.updatedAt),
  };
}

// 形状不对的目标卡片丢弃，同任务快照
function parseGoalNotice(v: unknown): GoalNotice | null {
  const d = obj(v);
  if (!d || typeof d.goalId !== "string" || !d.goalId) return null;
  if (!GOAL_EVENTS.includes(str(d.event))) return null;
  const reason = parseReason(d.reason);
  const maxRounds = "maxRounds" in d ? num(d.maxRounds) : undefined;
  return {
    event: d.event as GoalNotice["event"],
    goalId: d.goalId,
    revision: num(d.revision) ?? 0,
    ...(d.by === "user" || d.by === "model" ? { by: d.by } : {}),
    ...(num(d.round) === null ? {} : { round: num(d.round) as number }),
    ...(maxRounds === undefined ? {} : { maxRounds }),
    ...(typeof d.text === "string" ? { text: d.text } : {}),
    ...(Array.isArray(d.files)
      ? { files: d.files.filter((f): f is string => typeof f === "string") }
      : {}),
    ...(reason ? { reason } : {}),
  };
}

const TODO_STATUS = ["pending", "in_progress", "completed"] as const;

function parseTodos(v: unknown): Todo[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t: { content?: unknown; status?: unknown }) => {
    const status = TODO_STATUS.find((s) => s === t?.status);
    return typeof t?.content === "string" && t.content && status
      ? [{ content: t.content, status }]
      : [];
  });
}

function parseCompact(v: unknown, at?: string): CompactInfo | null {
  const d = obj(v);
  if (!d) return null;
  const when = typeof d.at === "string" ? d.at : at;
  return {
    summary: str(d.summary),
    savedPct: Math.min(100, Math.max(0, num(d.savedPct) ?? 0)),
    ...(when ? { at: when } : {}),
  };
}

// run.ended.usage 与 usage.tokens 同一口径；四项缺一项就当没有。
function parseTokens(v: unknown): TokenCount | null {
  const d = obj(v);
  if (!d) return null;
  const input = num(d.input);
  const output = num(d.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: num(d.cacheRead) ?? 0,
    cacheWrite: num(d.cacheWrite) ?? 0,
  };
}

export function parseUsage(v: unknown): UsageStat | null {
  const d = obj(v);
  if (!d) return null;
  const tokens = parseTokens(d.tokens);
  if (!tokens) return null;
  const c = obj(d.context);
  const used = c ? num(c.used) : null;
  const system = c ? num(c.system) : null;
  const tools = c ? num(c.tools) : null;
  return {
    turns: num(d.turns) ?? 0,
    steps: num(d.steps) ?? 0,
    tokensPerSecond: num(d.tokensPerSecond),
    modelMs: num(d.modelMs),
    toolMs: num(d.toolMs),
    ttftMs: num(d.ttftMs),
    tokens,
    cacheHitRate: num(d.cacheHitRate),
    context:
      c && used !== null
        ? {
            used,
            window: num(c.window),
            messages: num(c.messages) ?? used,
            ...(system === null ? {} : { system }),
            ...(tools === null ? {} : { tools }),
          }
        : null,
  };
}

const blocksOf = (v: unknown): { blocks?: Block[] } =>
  Array.isArray(v) ? { blocks: v as Block[] } : {};

/** 消息时间：非空字符串才保留，解析交给展示层（缺 ts 就不显示时间）。 */
const tsOf = (v: unknown): { ts?: string } =>
  typeof v === "string" && v !== "" ? { ts: v } : {};

const attachmentsOf = (v: unknown): { attachments?: MessageAttachment[] } => {
  const list = parseAttachments(v);
  return list ? { attachments: list } : {};
};

// 工具结果晚于助手消息到达：消息块里只带 toolCall，结果事件要回填到已渲染的块上。
function patchToolBlock(
  messages: Known[],
  id: string,
  patch: { result?: string; isError?: boolean; live?: string },
): Known[] {
  if (!id) return messages;
  return messages.map((m) => {
    if (!m.blocks?.some((b) => b.type === "tool" && b.id === id)) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.type === "tool" && b.id === id ? { ...b, ...patch } : b,
      ),
    };
  });
}

// 一轮结束：把本轮的增量累加进会话累计（精确值随后由 /usage 覆盖）。
function runEnded(s: ConvState, d: Record<string, unknown>): ConvState {
  const run = parseTokens(d.usage);
  const steps = num(d.steps);
  const turn = num(d.turn);
  const base = {
    ...s,
    running: false,
    partial: null,
    partialThinking: "",
    pendingTools: [],
    // 运行结束时服务端清空活动工具（快照里就是空的）；没等到 tool.ended 的（被停止、断线重放）要一并清掉，
    // 否则要刷新页面才会消失
    tools: [],
  };
  if (!run && steps === null && turn === null) return base;
  const u = s.usage;
  return {
    ...base,
    steps: steps ?? s.steps,
    turn: turn ?? s.turn,
    usage:
      run && u
        ? {
            ...u,
            turns: turn ?? u.turns,
            steps: u.steps + (steps ?? 0),
            tokens: {
              input: u.tokens.input + run.input,
              output: u.tokens.output + run.output,
              cacheRead: u.tokens.cacheRead + run.cacheRead,
              cacheWrite: u.tokens.cacheWrite + run.cacheWrite,
            },
          }
        : u,
  };
}

export function reduce(s: ConvState, f: Frame): ConvState {
  const d = f.data ?? {};
  switch (f.type) {
    case "snapshot": {
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      const active = Array.isArray(d.activeTools) ? d.activeTools : [];
      const p = d.partial as { text?: unknown } | null | undefined;
      return {
        messages: msgs.flatMap(
          (m: {
            role?: unknown;
            text?: unknown;
            ts?: unknown;
            blocks?: unknown;
            attachments?: unknown;
          }) => {
            const r = role(m?.role);
            return r
              ? [
                  {
                    role: r,
                    text: str(m.text),
                    ...tsOf(m.ts),
                    ...blocksOf(m.blocks),
                    ...attachmentsOf(m.attachments),
                  },
                ]
              : [];
          },
        ),
        partial: p && typeof p === "object" ? str(p.text) : null,
        partialThinking: "",
        pendingTools: [],
        tools: active.map(
          (t: {
            toolCallId?: unknown;
            toolName?: unknown;
            parentToolCallId?: unknown;
          }) => ({
            id: str(t?.toolCallId),
            name: str(t?.toolName),
            status: "running" as const,
            ...(str(t?.parentToolCallId) === ""
              ? {}
              : { parentId: str(t?.parentToolCallId) }),
          }),
        ),
        running: d.running === true,
        queue: Array.isArray(d.queue) ? d.queue.map(str) : [],
        prompts: Array.isArray(d.prompts)
          ? d.prompts.flatMap((p) => parsePrompt(p) ?? [])
          : [],
        error: null,
        goal: parseGoal(d.goal),
        todos: parseTodos(d.todos),
        compact: parseCompact(d.compact),
        compactError: null,
        // 快照没带 usage 可能只是服务端暂时取不到，沿用已有的，不让指标行闪空。
        usage: parseUsage(d.usage) ?? s.usage,
        steps: s.steps,
        turn: s.turn,
        flowsRev: s.flowsRev + 1,
        flowsChanged: [],
        contextRev: s.contextRev + 1,
        turnRev: s.turnRev + 1,
        notices: [],
        jobsRev: s.jobsRev + 1,
        fsRev: s.fsRev,
      };
    }
    case "message.started":
      return role(d.role) === "assistant"
        ? { ...s, partial: "", partialThinking: "", pendingTools: [] }
        : s;
    case "message.delta": {
      const kind = str(d.kind);
      const text = str(d.text);
      if (kind === "text" && s.partial !== null)
        return { ...s, partial: s.partial + text };
      if (kind === "thinking")
        return { ...s, partialThinking: s.partialThinking + text };
      if (kind === "toolstart") {
        const id = str(d.toolCallId);
        if (!id) return s;
        return {
          ...s,
          pendingTools: [
            ...s.pendingTools.filter((t) => t.id !== id),
            { id, name: str(d.toolName), args: "" },
          ],
        };
      }
      if (kind === "toolarg") {
        const id = str(d.toolCallId);
        if (!id) return s;
        const exists = s.pendingTools.some((t) => t.id === id);
        return {
          ...s,
          pendingTools: exists
            ? s.pendingTools.map((t) =>
                t.id === id ? { ...t, args: t.args + text } : t,
              )
            : [...s.pendingTools, { id, name: str(d.toolName), args: text }],
        };
      }
      return s;
    }
    case "message.ended": {
      const r = role(d.role);
      if (!r) return s;
      return {
        ...s,
        partial: r === "assistant" ? null : s.partial,
        ...(r === "assistant" ? { partialThinking: "", pendingTools: [] } : {}),
        messages: [
          ...s.messages,
          {
            role: r,
            text: str(d.text),
            ...tsOf(d.ts),
            ...blocksOf(d.blocks),
            ...attachmentsOf(d.attachments),
          },
        ],
      };
    }
    case "tool.started":
      return {
        ...s,
        pendingTools: s.pendingTools.filter((t) => t.id !== str(d.toolCallId)),
        tools: [
          ...s.tools.filter((t) => t.id !== str(d.toolCallId)),
          {
            id: str(d.toolCallId),
            name: str(d.toolName),
            status: "running",
            ...(d.args === undefined ? {} : { args: d.args }),
            ...(str(d.parentToolCallId) === ""
              ? {}
              : { parentId: str(d.parentToolCallId) }),
          },
        ],
      };
    case "tool.updated": {
      const id = str(d.toolCallId);
      return {
        ...s,
        tools: s.tools.map((t) =>
          t.id === id ? { ...t, output: str(d.output) } : t,
        ),
        messages: patchToolBlock(s.messages, id, { live: str(d.output) }),
      };
    }
    case "tool.ended": {
      const ms = num(d.durationMs);
      const id = str(d.toolCallId);
      const output = str(d.output);
      const isError = d.isError === true;
      return {
        ...s,
        tools: s.tools.map((t) =>
          t.id === id
            ? {
                ...t,
                status: isError ? "error" : "ok",
                output,
                ...(ms === null ? {} : { durationMs: ms }),
              }
            : t,
        ),
        messages: patchToolBlock(s.messages, id, { result: output, isError }),
      };
    }
    case "run.started":
      return { ...s, running: true, error: null };
    case "run.ended":
      return runEnded(s, d);
    case "run.failed":
      return { ...s, error: str(d.message) || "运行失败" };
    case "queue.updated":
      return {
        ...s,
        queue: Array.isArray(d.queue) ? d.queue.map(str) : s.queue,
      };
    case "prompt.requested": {
      const p = parsePrompt(d);
      if (!p || s.prompts.some((x) => x.promptId === p.promptId)) return s;
      return { ...s, prompts: [...s.prompts, p] };
    }
    case "prompt.resolved":
      return s.prompts.some((p) => p.promptId === d.promptId)
        ? { ...s, prompts: s.prompts.filter((p) => p.promptId !== d.promptId) }
        : s;
    case "goal.updated": {
      if (d.goal === null) return { ...s, goal: null };
      const goal = parseGoal(d.goal);
      return goal ? { ...s, goal } : s;
    }
    case "plan.updated":
      return Array.isArray(d.todos) ? { ...s, todos: parseTodos(d.todos) } : s;
    case "context.compacted": {
      const compact = parseCompact(d, f.ts);
      return compact ? { ...s, compact, compactError: null } : s;
    }
    case "context.compact_failed":
      return { ...s, compactError: str(d.message) || "压缩失败" };
    case "flows.updated":
      return {
        ...s,
        flowsRev: s.flowsRev + 1,
        flowsChanged: Array.isArray(d.changed)
          ? d.changed.filter((x): x is string => typeof x === "string")
          : [],
      };
    case "context.updated":
      return { ...s, contextRev: s.contextRev + 1 };
    case "jobs.updated":
      return { ...s, jobsRev: s.jobsRev + 1 };
    case "notice": {
      const at = s.messages.length;
      const ts = str(d.ts) || f.ts || "";
      if (d.kind === "goal") {
        const goal = parseGoalNotice(d.goal);
        return goal
          ? { ...s, notices: [...s.notices, { kind: "goal", at, ts, goal }] }
          : s;
      }
      const job = parseJob(d.job);
      return job
        ? {
            ...s,
            notices: [...s.notices, { kind: "job", at, ts, job }],
            jobsRev: s.jobsRev + 1,
          }
        : s;
    }
    case "turn.changes":
      return { ...s, turnRev: s.turnRev + 1 };
    case "fs.changed": {
      const env = str(d.env);
      if (!env) return s;
      return {
        ...s,
        fsRev: { ...s.fsRev, [env]: (s.fsRev[env] ?? 0) + 1 },
      };
    }
    case USAGE_LOADED: {
      const usage = parseUsage(d);
      return usage ? { ...s, usage } : s;
    }
    default:
      return s;
  }
}
