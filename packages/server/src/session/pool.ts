import { unlinkSync } from "node:fs";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { EnvHub } from "../env/hub.js";
import { LocalEnv } from "../env/local.js";
import { routedToolsExtension } from "../env/tools.js";
import type { ExecEnv } from "../env/types.js";
import { uuidv7 } from "../id.js";
import { permissionExtension } from "../permission/extension.js";
import { isMode, type Mode, modeExtension } from "../permission/mode.js";
import {
  type Evidence,
  POLICY_MAX,
  type ReviewerFactory,
  runReview,
} from "../permission/review.js";
import type { Assembled } from "../prompt/assemble.js";
import type { PromptService } from "../prompt/service.js";
import type { Agent, AgentStore } from "../store/agents.js";
import type { AuditInput, AuditLog } from "../store/audit.js";
import { type EnvironmentStore, LOCAL_ENV_ID } from "../store/environments.js";
import {
  type ChatEntry,
  hasDanglingToolCall,
  readMessages,
  readToolOutputs,
} from "../store/history.js";
import type { RuleStore } from "../store/rules.js";
import {
  findSessionFile,
  type IndexRow,
  readHeader,
  readName,
  type SessionStore,
  UUID_RE,
} from "../store/sessions.js";
import {
  resolveDirectory,
  type Workspace,
  type WorkspaceStore,
} from "../store/workspaces.js";
import { toolAudit } from "./audit.js";
import {
  type Block,
  type ChatMessage,
  cut,
  EVENT_STRING_MAX,
  FRAME_DATA_MAX,
  MAX_ACTIVE_TOOLS,
  MAX_ID,
  mapEvent,
  SNAPSHOT_MESSAGE_MAX,
  sanitizeData,
} from "./events.js";
import { type PromptResult, type PromptSpec, PromptTable } from "./prompts.js";
import { askUserExtension } from "./tools.js";
import {
  switchNotice,
  type WorkspaceView,
  workspaceExtension,
} from "./workspace-tools.js";

// 索引或 agent 里的模式值读作模式；迁移前或空值按 build。
const modeOf = (v: string | null | undefined): Mode =>
  isMode(v) ? v : "build";

// 工厂按 agent 定义装配会话：工具白名单、提示词基线、模型与推理强度。
export interface FactoryAgent {
  tools: string[];
  // 每次 reload 时重新取，所以基线更新后下一次 compaction 重建即可生效。
  promptText: () => string;
  modelId: string | null;
  thinkingLevel: string | null;
}

export interface FactoryOptions {
  id: string;
  sessionDir: string;
  // 会话所属 workspace 的绝对路径，即工具的工作目录。
  cwd: string;
  // 恢复已有会话时给出其 JSONL 路径；新建时缺省。
  file?: string;
  // 池提供的扩展（ask_user、权限拦截），由工厂交给资源加载器的 extensionFactories。
  extensions: ExtensionFactory[];
  // 缺省（测试里的假工厂）时不做 agent 装配。
  agent?: FactoryAgent;
}
export type SessionFactory = (opts: FactoryOptions) => Promise<AgentSession>;

export interface Subscriber {
  // 收到的是已序列化的一帧；抛错表示该订阅者已不可用，会被移除。
  send(frame: string): void;
  // 会话被删除或池关闭时调用，让连接层关闭对应连接。
  close?(): void;
}

export interface SessionInfo {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  workspaceId: string;
  reviewPolicy: string | null;
  agentId: string | null;
  mode: Mode;
}

export interface ImageInput {
  mimeType: string;
  data: string;
}

export class PoolError extends Error {
  constructor(
    readonly code:
      | "bad_request"
      | "disposed"
      | "load_failed"
      | "delete_failed"
      | "prompt_resolved"
      | "prompt_unknown",
    message: string,
  ) {
    super(message);
  }
}

const WINDOW = 50;

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export interface EntryOptions {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  workspaceId?: string;
  reviewPolicy?: string | null;
  agentId?: string | null;
  mode?: Mode;
  // 提示词基线（会话创建或最近一次同步时拼好的文本）。
  promptText?: string | null;
  // 恢复时用 JSONL 里最近的消息播种窗口。
  seed?: ChatMessage[];
  // 恢复时会话里已有的消息总数（含窗口之外的）；缺省等于 seed 的条数。
  seedTotal?: number;
  // 恢复时发现悬挂的工具调用：下一次发送前先附加“上次被中断”的通知。
  interrupted?: boolean;
  // 每次运行结束后调用（持久化索引）；抛错不影响事件流。
  onRunEnded?: (entry: SessionEntry) => void;
  // 工具调用开始/结束时记审计。
  onAudit?: (
    entry: SessionEntry,
    rec: Pick<AuditInput, "summary" | "detail">,
  ) => void;
  // 压缩成功后调用：提示词基线在此挂点重建。
  onCompacted?: (entry: SessionEntry) => void;
  // 弹窗超时（毫秒），缺省 30 分钟；测试用。
  promptTimeoutMs?: number;
}

const INTERRUPTED_NOTICE =
  "上一次运行被中断（服务重启），其中的工具调用没有得到结果。是否重做由你判断。";

export class SessionEntry {
  readonly id: string;
  readonly createdAt: string;
  workspaceId: string;
  // 切换 workspace 后待在下一轮末尾追加的通知。
  workspaceNotice: string | null = null;
  reviewPolicy: string | null;
  readonly agentId: string | null;
  // 创建时由 agent 的默认模式定下，会话内固定。
  readonly mode: Mode;
  promptText: string | null;
  // 压缩后待重建基线（运行中不能 reload，等空闲）。
  rebasePending = false;
  private reloading: Promise<void> | null = null;
  updatedAt: string;
  running = false;
  // send 已接受但 SDK 尚未发出 agent_start 的窗口；删除必须把它当作运行中。
  private starting = 0;
  private interrupted: boolean;

  private seq = 0;
  private readonly subscribers = new Set<Subscriber>();
  // 快照里的一切都由同一条事件流推出，所以快照与 seq 天然一致。
  private readonly recent: ChatMessage[] = [];
  // 会话里累计的 user/assistant 消息数，与 REST 的 index 同一套；窗口第一条的序位是 total - recent.length。
  private total = 0;
  private partial: ChatMessage | null = null;
  private readonly activeTools = new Map<string, string>();
  private queue: string[] = [];
  private runError: string | undefined;
  private readonly unsubscribeSdk: () => void;
  private disposed = false;
  // 弹窗只存内存；表的钩子负责占 seq 广播。
  readonly prompts: PromptTable;

  constructor(
    private readonly session: AgentSession,
    private readonly opts: EntryOptions = {},
  ) {
    this.id = opts.id ?? uuidv7();
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.updatedAt = opts.updatedAt ?? this.createdAt;
    this.workspaceId = opts.workspaceId ?? "";
    this.reviewPolicy = opts.reviewPolicy ?? null;
    this.agentId = opts.agentId ?? null;
    this.mode = opts.mode ?? "build";
    this.promptText = opts.promptText ?? null;
    this.interrupted = opts.interrupted === true;
    this.prompts = new PromptTable(
      {
        requested: (d) => this.emit("prompt.requested", { ...d }),
        resolved: (d) => this.emit("prompt.resolved", d),
      },
      opts.promptTimeoutMs,
    );
    this.recent.push(...(opts.seed ?? []).slice(-WINDOW));
    this.total = opts.seedTotal ?? this.recent.length;
    this.unsubscribeSdk = session.subscribe((e) => {
      try {
        this.onSdkEvent(e);
      } catch {
        // 单个事件处理失败不得把异常抛回 SDK 的执行链。
      }
    });
  }

  private onSdkEvent(e: AgentSessionEvent): void {
    if (e.type === "compaction_end" && e.result && !e.aborted) {
      this.rebasePending = true;
      this.opts.onCompacted?.(this);
    }
    const mapped = mapEvent(e);
    if (!mapped) return;
    if (e.type === "tool_execution_start" || e.type === "tool_execution_end")
      this.opts.onAudit?.(this, toolAudit(e));
    if (mapped.type === "run.started") {
      // 自动重试会反复 agent_start；一次运行只对外开始一次。
      if (this.running) return;
      this.running = true;
      this.runError = undefined;
    } else if (mapped.type === "message.ended" && e.type === "message_end") {
      const m = e.message as {
        role: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (m.role === "assistant")
        this.runError =
          m.stopReason === "error"
            ? (m.errorMessage ?? "模型调用失败")
            : undefined;
    } else if (mapped.type === "run.ended") {
      if (this.runError !== undefined)
        this.emit("run.failed", { message: this.runError });
      this.runError = undefined;
      this.running = false;
    }
    this.emit(mapped.type, mapped.data);
    if (mapped.type === "run.ended") {
      this.updatedAt = new Date().toISOString();
      try {
        this.opts.onRunEnded?.(this);
      } catch {
        // 索引写入失败不得影响事件流；下次启动对账会补齐。
      }
    }
  }

  get name(): string | null {
    return this.session.sessionManager.getSessionName() ?? null;
  }

  rename(name: string): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    this.session.sessionManager.appendSessionInfo(name);
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      running: this.running,
      workspaceId: this.workspaceId,
      reviewPolicy: this.reviewPolicy,
      agentId: this.agentId,
      mode: this.mode,
    };
  }

  // 让 SDK 重新读取提示词基线（resourceLoader.reload）；发送会等它完成。
  reloadPrompt(): Promise<void> {
    const p = this.session.reload().finally(() => {
      if (this.reloading === p) this.reloading = null;
    });
    this.reloading = p;
    return p;
  }

  // 自动审核取证：用户消息与已解决弹窗问答可信；助手输出不可信。
  evidence(history: ChatEntry[], toolOutputs: string[] = []): Evidence {
    const trusted = history
      .filter((m) => m.role === "user")
      .map((m) => `用户：${m.text}`);
    for (const r of this.prompts.history()) {
      if (r.outcome !== "answered") continue;
      const ans = r.optionLabel ?? r.text ?? "";
      trusted.push(`弹窗「${r.title}」用户回答：${ans}`);
    }
    const untrusted = history
      .filter((m) => m.role === "assistant")
      .map((m) => `助手：${m.text}`);
    // 近期工具输出同属不可信；条数封顶，总量由送审时的尾部截断兜底
    untrusted.push(...toolOutputs.slice(-TOOL_OUTPUT_MAX));
    return { trusted, untrusted };
  }

  // 先改状态，再分配序号并广播：序号 N 的快照就是事件 N 之后的状态。
  private emit(type: string, raw: Record<string, unknown>): void {
    // 单个字符串超限就截断并标记：保证单帧有界，客户端需要全文时另行拉取。
    const data = sanitizeData(raw, EVENT_STRING_MAX);
    this.apply(type, data);
    this.seq += 1;
    this.broadcast(this.frame(type, data));
  }

  private apply(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case "message.started":
        if (data.role === "assistant")
          this.partial = { role: "assistant", text: "" };
        break;
      case "message.delta":
        if (
          data.kind === "text" &&
          typeof data.text === "string" &&
          this.partial &&
          this.partial.text.length < EVENT_STRING_MAX
        )
          this.partial.text += data.text;
        break;
      case "message.ended":
        if (data.role === "assistant") this.partial = null;
        if (
          (data.role === "user" || data.role === "assistant") &&
          typeof data.text === "string"
        ) {
          this.recent.push({
            role: data.role,
            text: data.text,
            ...(Array.isArray(data.blocks)
              ? { blocks: data.blocks as Block[] }
              : {}),
          });
          this.total += 1;
          if (this.recent.length > WINDOW) this.recent.shift();
        }
        break;
      case "tool.started":
        // 只登记事件里原样可见、且长度合规的工具：快照与事件说的是同一个 id。
        if (
          typeof data.toolCallId === "string" &&
          typeof data.toolName === "string" &&
          data.toolCallId.length <= MAX_ID &&
          data.toolName.length <= MAX_ID &&
          this.activeTools.size < MAX_ACTIVE_TOOLS
        )
          this.activeTools.set(data.toolCallId, data.toolName);
        break;
      case "tool.ended":
        if (typeof data.toolCallId === "string")
          this.activeTools.delete(data.toolCallId);
        break;
      case "queue.updated":
        if (
          Array.isArray(data.queue) &&
          data.queue.every((q) => typeof q === "string")
        )
          this.queue = data.queue;
        break;
      case "run.ended":
        this.partial = null;
        this.activeTools.clear();
        break;
    }
  }

  private frame(type: string, data: unknown): string {
    const base = {
      session: this.id,
      seq: this.seq,
      ts: new Date().toISOString(),
      type,
    };
    try {
      return JSON.stringify({ ...base, data });
    } catch {
      // 工具结果可能含循环引用或 bigint；序号不能因此跳过。
      return JSON.stringify({ ...base, data: { unserializable: true } });
    }
  }

  private broadcast(frame: string): void {
    for (const sub of [...this.subscribers]) {
      try {
        sub.send(frame);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  // 每个字段都有界：消息逐级收紧文本，activeTools/queue 在写入状态时已限条数与长度。
  private snapshotFrame(): string {
    const activeTools = [...this.activeTools].map(([toolCallId, toolName]) => ({
      toolCallId,
      toolName,
    }));
    for (const limit of [SNAPSHOT_MESSAGE_MAX, 4 * 1024, 0]) {
      const trim = (m: ChatMessage) => ({
        role: m.role,
        text: cut(m.text, limit),
        ...(m.blocks
          ? {
              blocks: m.blocks.map((b) =>
                b.type === "tool"
                  ? {
                      ...b,
                      args: cut(b.args, limit),
                      ...(b.result === undefined
                        ? {}
                        : { result: cut(b.result, limit) }),
                    }
                  : { ...b, text: cut(b.text, limit) },
              ),
            }
          : {}),
      });
      const messages = limit === 0 ? [] : this.recent.map(trim);
      const partial = this.partial
        ? {
            role: this.partial.role,
            text: cut(this.partial.text, Math.max(limit, 1024)),
          }
        : null;
      const truncated =
        (limit === 0
          ? this.recent.length > 0
          : this.recent.some((m) => m.text.length > limit)) ||
        (this.partial !== null &&
          this.partial.text.length > Math.max(limit, 1024));
      const data = {
        messages,
        startIndex: this.total - messages.length,
        ...(truncated ? { truncated: true } : {}),
        running: this.running,
        activeTools,
        partial,
        queue: this.queue,
        prompts: this.prompts.list(),
      };
      if (
        limit === 0 ||
        Buffer.byteLength(JSON.stringify(data)) <= FRAME_DATA_MAX
      )
        return this.frame("snapshot", data);
    }
    throw new Error("unreachable");
  }

  // 整段同步：先发快照，再登记订阅，其间不会有事件插入。
  subscribe(sub: Subscriber): () => void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    sub.send(this.snapshotFrame());
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  resync(sub: Subscriber): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    sub.send(this.snapshotFrame());
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get busy(): boolean {
    return this.running || this.starting > 0;
  }

  // 返回时命令已被接受；整个运行是否成功由事件流告知。
  send(text: string, images: ImageInput[] = []): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    if (text.trim() === "") throw new PoolError("bad_request", "text 不能为空");
    // 模型不支持图片时 SDK 会把图片悄悄换成一句占位文字，必须在这里拒绝。
    if (images.length && !this.session.model?.input.includes("image"))
      throw new PoolError("bad_request", "当前模型不支持图片输入");
    const notice = this.interrupted;
    this.interrupted = false;
    this.starting++;
    (async () => {
      await this.reloading?.catch(() => {});
      if (notice)
        await this.session.sendCustomMessage(
          {
            customType: "yuanshu.interrupted",
            content: INTERRUPTED_NOTICE,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      await this.session.prompt(text, {
        streamingBehavior: "steer",
        ...(images.length
          ? { images: images.map((i) => ({ type: "image" as const, ...i })) }
          : {}),
      });
    })()
      .catch((err) => this.emit("run.failed", { message: reason(err) }))
      .finally(() => {
        this.starting--;
      });
  }

  // 发弹窗并等结果；会话已关闭时直接视为撤销。
  ask(spec: PromptSpec): Promise<PromptResult> {
    if (this.disposed) return Promise.resolve({ outcome: "cancelled" });
    return this.prompts.ask(spec);
  }

  answerPrompt(
    promptId: string,
    a: { optionId?: unknown; text?: unknown },
  ): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    const failure = this.prompts.answer(promptId, a);
    if (failure === "bad_request")
      throw new PoolError("bad_request", "答复与弹窗不匹配");
    if (failure)
      throw new PoolError(
        failure,
        failure === "prompt_resolved"
          ? "弹窗已被答复、超时或撤销"
          : "弹窗不存在",
      );
  }

  async stop(): Promise<void> {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    // 先撤销弹窗，让卡在审批/提问上的工具调用按拒绝收场，abort 才能结束运行。
    this.prompts.cancelAll();
    await this.session.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.prompts.cancelAll();
    this.disposed = true;
    this.unsubscribeSdk();
    for (const sub of this.subscribers) {
      try {
        sub.close?.();
      } catch {}
    }
    this.subscribers.clear();
    this.session.dispose();
  }
}

export interface PoolDeps {
  // 未提供时不能创建或加载会话，但索引、列表、改名、删除、历史仍可用。
  factory: SessionFactory | null;
  store: SessionStore;
  workspaces: WorkspaceStore;
  rules: RuleStore;
  sessionDir: string;
  // 弹窗超时（毫秒），缺省 30 分钟；测试用。
  promptTimeoutMs?: number;
  // 注入的审核会话工厂；缺省时 auto 档同 rules。
  reviewerFactory?: ReviewerFactory;
  // agent 定义与提示词组装；缺省时不做 agent 装配（只用于没有 agent 的测试）。
  agents?: AgentStore;
  prompts?: PromptService;
  // 审核超时（毫秒），缺省 60 秒；测试用。
  reviewTimeoutMs?: number;
  // 环境服务与登记；缺省时所有 workspace 按本机处理（只用于没有远程环境的测试）。
  envHub?: EnvHub;
  environments?: EnvironmentStore;
  // 执行审计；缺省时不记录。
  audit?: AuditLog;
}

const NAME_MAX = 200;
// 送审带的近期工具输出条数上限（每条另截断 200 字符）。
const TOOL_OUTPUT_MAX = 10;

export class SessionPool {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly loading = new Map<string, Promise<SessionEntry | null>>();
  // 创建中预占的会话数（按 workspace）：工厂完成前删除 workspace 要拒绝。
  private readonly pending = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: PoolDeps) {}

  private localEnv = new LocalEnv();

  private envOf(ws: Workspace): ExecEnv | null {
    const hub = this.deps.envHub;
    if (hub) return hub.get(ws.environmentId);
    return ws.environmentId === LOCAL_ENV_ID ? this.localEnv : null;
  }

  private viewOf(w: Workspace, currentId: string): WorkspaceView {
    const { envHub, environments } = this.deps;
    const local = w.environmentId === LOCAL_ENV_ID;
    const s = envHub?.status(w.environmentId);
    let state = "本机";
    if (!local) {
      if (!s) state = "环境已删除";
      else if (s.state === "connected") state = "已连接";
      else if (s.state === "error") state = `连接失败：${s.error ?? ""}`;
      else state = "未连接";
    }
    return {
      id: w.id,
      name: w.name,
      path: w.path,
      environment: local
        ? "本机"
        : (environments?.get(w.environmentId)?.name ?? w.environmentId),
      state,
      current: w.id === currentId,
    };
  }

  private workspaceViews(currentId: string): WorkspaceView[] {
    return this.deps.workspaces.list().map((w) => this.viewOf(w, currentId));
  }

  // 供 switch_workspace 工具调用，失败抛 Error（信息直接给模型看）。
  private switchWorkspace(sessionId: string, target: string): WorkspaceView {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error("会话已关闭");
    const all = this.deps.workspaces.list();
    const byId = all.find((w) => w.id === target);
    const byName = all.filter((w) => w.name === target);
    if (!byId && byName.length > 1)
      throw new Error(
        `名称「${target}」对应多个 workspace，请改用 id：${byName.map((w) => w.id).join("、")}`,
      );
    const hit = byId ?? byName[0];
    if (!hit)
      throw new Error(
        `workspace 不存在：${target}。已登记的：${all.map((w) => w.name).join("、")}`,
      );
    const bad = this.workspaceProblem(hit);
    if (bad) throw new Error(bad);
    if (!this.envOf(hit)) throw new Error(`环境不可用：${hit.environmentId}`);
    const view = this.viewOf(hit, hit.id);
    entry.workspaceId = hit.id;
    entry.workspaceNotice = switchNotice(view);
    // 运行结束时索引会按条目上的 id 写入；这里同步一次，避免中途崩溃后回到旧 workspace。
    this.deps.store.updateWorkspaceId(sessionId, hit.id);
    return view;
  }

  get canCreate(): boolean {
    return this.deps.factory !== null;
  }

  // 会话创建时会话条目还不存在，扩展按 id 惰性取。
  private extensions(
    id: string,
    ws: Workspace,
    mode: Mode,
  ): ExtensionFactory[] {
    const ask = (spec: PromptSpec) =>
      this.entries.get(id)?.ask(spec) ??
      Promise.resolve<PromptResult>({ outcome: "cancelled" });
    const { workspaces, rules, reviewerFactory } = this.deps;
    // 会话当前所在的 workspace：切换会改条目上的 id，创建期间条目还没有就用起始值。
    const current = (): Workspace =>
      workspaces.get(this.entries.get(id)?.workspaceId ?? ws.id) ?? ws;
    const where = () => {
      const w = current();
      const env = this.envOf(w);
      if (!env) throw new Error(`环境不可用：${w.environmentId}`);
      return { env, cwd: w.path };
    };
    return [
      // 模式是上限，排在权限扩展之前。
      modeExtension(mode),
      askUserExtension(ask),
      routedToolsExtension(where),
      workspaceExtension({
        list: () => this.workspaceViews(current().id),
        switchTo: (target) => this.switchWorkspace(id, target),
        takeNotice: () => {
          const entry = this.entries.get(id);
          const n = entry?.workspaceNotice ?? null;
          if (entry) entry.workspaceNotice = null;
          return n;
        },
      }),
      permissionExtension({
        where,
        // 每次工具调用即时读取：改档位/删规则立刻生效；workspace 被删时按最严的一档。
        tier: () => workspaces.get(current().id)?.tier ?? "rules",
        rules: () => {
          const all = rules.list(current().id);
          return {
            path: all.flatMap((r) =>
              r.kind === "path" && r.access
                ? [{ access: r.access, value: r.value }]
                : [],
            ),
            command: all
              .filter((r) => r.kind === "command")
              .map((r) => r.value),
          };
        },
        addRule: (r) => rules.add(current().id, r),
        ask,
        audit: (rec) =>
          this.deps.audit?.record({
            ...rec,
            kind: "permission",
            sessionId: id,
            environmentId: current().environmentId,
          }),
        ...(reviewerFactory
          ? {
              review: (call) => {
                const entry = this.entries.get(id);
                let history: ChatEntry[] = [];
                let toolOutputs: string[] = [];
                try {
                  const file = findSessionFile(this.deps.sessionDir, id);
                  if (file) {
                    history = readMessages(file, this.deps.sessionDir, id);
                    toolOutputs = readToolOutputs(
                      file,
                      this.deps.sessionDir,
                      id,
                    );
                  }
                } catch {
                  // 取不到证据就只带空证据，仍由审核方或降级兜底
                }
                return runReview(
                  reviewerFactory,
                  entry?.reviewPolicy ?? null,
                  call,
                  entry?.evidence(history, toolOutputs) ?? {
                    trusted: [],
                    untrusted: [],
                  },
                  this.deps.reviewTimeoutMs,
                );
              },
            }
          : {}),
      }),
    ];
  }

  private entryOptions(): Pick<
    EntryOptions,
    "onRunEnded" | "onCompacted" | "promptTimeoutMs" | "onAudit"
  > {
    const { audit, workspaces } = this.deps;
    return {
      onRunEnded: (e) => {
        this.persist(e);
        if (e.rebasePending) void this.rebase(e.id).catch(() => {});
      },
      onCompacted: (e) => {
        if (!e.busy) void this.rebase(e.id).catch(() => {});
      },
      ...(audit
        ? {
            onAudit: (e, rec) =>
              audit.record({
                ...rec,
                actor: "agent",
                kind: "tool",
                sessionId: e.id,
                environmentId:
                  workspaces.get(e.workspaceId)?.environmentId ?? null,
              }),
          }
        : {}),
      ...(this.deps.promptTimeoutMs === undefined
        ? {}
        : { promptTimeoutMs: this.deps.promptTimeoutMs }),
    };
  }

  // 会话一旦有了 JSONL 就进索引；之后每次运行结束更新 updated_at 与名称缓存。
  private persist(e: SessionEntry): void {
    if (!findSessionFile(this.deps.sessionDir, e.id)) return;
    this.deps.store.upsert({
      id: e.id,
      name: e.name,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      workspaceId: e.workspaceId,
      reviewPolicy: e.reviewPolicy,
      agentId: e.agentId,
      promptText: e.promptText,
      mode: e.mode,
    });
  }

  private agentOf(agentId: string | null | undefined): Agent | undefined {
    const { agents } = this.deps;
    if (!agents) return undefined;
    return agentId ? agents.get(agentId) : agents.default();
  }

  // 按 agent 的块引用与 workspace 拼提示词；供会话创建、同步与预览共用。
  async assemblePrompt(
    blockIds: string[],
    ws: Workspace | undefined,
    mode: Mode = "build",
  ): Promise<Assembled> {
    const prompts = this.deps.prompts;
    if (!prompts) return { text: "", parts: [] };
    const env = ws ? this.envOf(ws) : null;
    return prompts.assemble(
      blockIds,
      ws && env
        ? { env, cwd: ws.path, injectProject: ws.injectConventions }
        : null,
      mode,
    );
  }

  private factoryAgent(
    id: string,
    agent: Agent,
    initial: string,
  ): FactoryAgent {
    return {
      // ask_user 是会话与用户的交互通道，不属于可勾选的能力；SDK 的白名单会把未列出的扩展工具一并关掉。
      tools: [
        ...new Set([
          ...agent.capabilities
            .filter((c) => c.kind === "tool")
            .map((c) => c.name),
          "ask_user",
        ]),
      ],
      promptText: () => this.entries.get(id)?.promptText ?? initial,
      modelId: agent.model,
      thinkingLevel: agent.defaultThinkingLevel,
    };
  }

  // 立即同步：按当前块内容重建提示词基线。运行中的会话不动（返回 busy），压缩后会自动重建。
  async rebase(
    id: string,
  ): Promise<"synced" | "unchanged" | "busy" | "not_found"> {
    const { store, workspaces } = this.deps;
    const entry = this.entries.get(id);
    const row = store.get(id);
    if (!entry && !row) return "not_found";
    if (entry?.busy) return "busy";
    const agent =
      this.agentOf(entry ? entry.agentId : row?.agentId) ?? this.agentOf(null);
    if (!agent) return "unchanged";
    const wsId = entry ? entry.workspaceId : row?.workspaceId;
    const ws =
      (wsId ? workspaces.get(wsId) : undefined) ?? workspaces.getDefault();
    const mode = entry ? entry.mode : modeOf(row?.mode);
    const { text } = await this.assemblePrompt(agent.promptBlocks, ws, mode);
    // 拼装期间可能开始了新一轮运行。
    if (entry?.busy) return "busy";
    if (entry) entry.rebasePending = false;
    if (text === (entry ? entry.promptText : row?.promptText))
      return "unchanged";
    if (entry) {
      entry.promptText = text;
      await entry.reloadPrompt();
    }
    if (store.get(id)) store.setPromptText(id, text);
    return "synced";
  }

  // 全部同步：只处理空闲会话，返回各结果的计数。
  async rebaseAll(): Promise<Record<"synced" | "unchanged" | "busy", number>> {
    const out = { synced: 0, unchanged: 0, busy: 0 };
    const ids = new Set([
      ...this.entries.keys(),
      ...this.deps.store.list().map((r) => r.id),
    ]);
    for (const id of ids) {
      const r = await this.rebase(id).catch(() => "unchanged" as const);
      if (r !== "not_found") out[r]++;
    }
    return out;
  }

  // 索引行的 workspace：空值读作默认（最早登记）的 workspace。
  private rowWorkspaceId(workspaceId: string | null | undefined): string {
    return workspaceId ?? this.deps.workspaces.getDefault()?.id ?? "";
  }

  // 登记路径此刻是否仍指向登记时的那个目录：消失、或被换成符号链接指向别处（realpath 与登记值不一致）都不能用。
  private workspaceProblem(ws: Workspace): string | null {
    // 远程目录不在本机，预检无从谈起；不存在会在工具调用时如实报错。
    if (ws.environmentId !== LOCAL_ENV_ID) return null;
    const r = resolveDirectory(ws.path);
    if (!r.ok) return "workspace 目录已不存在";
    if (r.path !== ws.path)
      return `workspace 路径已变化：登记为 ${ws.path}，现解析为 ${r.path}`;
    return null;
  }

  async create(
    opts: { workspaceId?: string; agentId?: string } = {},
  ): Promise<SessionInfo> {
    if (this.disposed) throw new PoolError("disposed", "会话池已关闭");
    const factory = this.deps.factory;
    if (!factory) throw new PoolError("load_failed", "没有会话后端");
    const ws =
      opts.workspaceId === undefined
        ? this.deps.workspaces.getDefault()
        : this.deps.workspaces.get(opts.workspaceId);
    if (!ws) throw new PoolError("bad_request", "workspace 不存在");
    const bad = this.workspaceProblem(ws);
    if (bad) throw new PoolError("bad_request", bad);
    const agent = this.agentOf(opts.agentId);
    if (!agent && opts.agentId !== undefined)
      throw new PoolError("bad_request", "agent 不存在");
    const mode = modeOf(agent?.defaultMode);
    const promptText = agent
      ? (await this.assemblePrompt(agent.promptBlocks, ws, mode)).text
      : null;
    const id = uuidv7();
    const n = this.pending.get(ws.id) ?? 0;
    this.pending.set(ws.id, n + 1);
    let session: Awaited<ReturnType<typeof factory>>;
    try {
      session = await factory({
        id,
        sessionDir: this.deps.sessionDir,
        cwd: ws.path,
        extensions: this.extensions(id, ws, mode),
        ...(agent
          ? { agent: this.factoryAgent(id, agent, promptText ?? "") }
          : {}),
      });
    } finally {
      const n = this.pending.get(ws.id) ?? 0;
      if (n > 1) this.pending.set(ws.id, n - 1);
      else this.pending.delete(ws.id);
    }
    if (this.disposed) {
      session.dispose();
      throw new PoolError("disposed", "会话池已关闭");
    }
    // 工厂完成后再次校验 workspace 仍存在（删除可能发生在工厂等待期间）。
    if (!this.deps.workspaces.get(ws.id)) {
      session.dispose();
      throw new PoolError("bad_request", "workspace 已被删除");
    }
    const entry = new SessionEntry(session, {
      id,
      workspaceId: ws.id,
      agentId: agent?.id ?? null,
      mode,
      promptText,
      ...this.entryOptions(),
    });
    this.entries.set(id, entry);
    return entry.info;
  }

  // 仅查池内已加载的会话。
  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  // 按需加载：池内有就用；否则从 JSONL 恢复。并发的首次访问只加载一次。
  // 返回 null 表示没有这个会话；文件损坏抛 PoolError("load_failed")。
  async acquire(id: string): Promise<SessionEntry | null> {
    if (!UUID_RE.test(id)) return null;
    const resident = this.entries.get(id);
    if (resident) return resident;
    const inflight = this.loading.get(id);
    if (inflight) return inflight;
    const p = this.load(id).finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  private async load(id: string): Promise<SessionEntry | null> {
    if (this.disposed) throw new PoolError("disposed", "会话池已关闭");
    const { sessionDir, store, factory, workspaces } = this.deps;
    const file = findSessionFile(sessionDir, id);
    if (!file) return null;
    let seed: ChatMessage[];
    let seedTotal: number;
    let interrupted: boolean;
    let createdAt: string;
    try {
      const header = readHeader(file, id);
      if (!header) throw new Error("会话文件头无效");
      createdAt = header.createdAt;
      const all = readMessages(file, sessionDir, id);
      seedTotal = all.length;
      seed = all.slice(-WINDOW).map(({ index: _i, ...m }) => m);
      interrupted = hasDanglingToolCall(file, sessionDir, id);
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    if (!factory) throw new PoolError("load_failed", "没有会话后端");
    const row = store.get(id);
    const ws =
      (row?.workspaceId ? workspaces.get(row.workspaceId) : undefined) ??
      workspaces.getDefault();
    if (!ws) throw new PoolError("load_failed", "没有可用的 workspace");
    const bad = this.workspaceProblem(ws);
    if (bad) throw new PoolError("load_failed", bad);
    // 迁移前的会话没有 agent 记录，读作默认 agent；提示词基线沿用创建时记下的版本，没有就现拼。
    const agent = this.agentOf(row?.agentId) ?? this.agentOf(null);
    const mode = modeOf(row?.mode);
    const promptText =
      row?.promptText ??
      (agent
        ? (await this.assemblePrompt(agent.promptBlocks, ws, mode)).text
        : null);
    let session: AgentSession;
    try {
      session = await factory({
        id,
        sessionDir,
        file,
        cwd: ws.path,
        extensions: this.extensions(id, ws, mode),
        ...(agent
          ? { agent: this.factoryAgent(id, agent, promptText ?? "") }
          : {}),
      });
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    if (this.disposed) {
      session.dispose();
      throw new PoolError("disposed", "会话池已关闭");
    }
    const entry = new SessionEntry(session, {
      id,
      workspaceId: ws.id,
      reviewPolicy: row?.reviewPolicy ?? null,
      agentId: agent?.id ?? null,
      mode,
      promptText,
      createdAt: row?.createdAt ?? createdAt,
      updatedAt: row?.updatedAt,
      seed,
      seedTotal,
      interrupted,
      ...this.entryOptions(),
    });
    this.entries.set(id, entry);
    return entry;
  }

  // 索引里的会话加上池内尚未持久化的会话；池内的状态（运行中、最新名称）优先。
  list(): SessionInfo[] {
    const out = new Map<string, SessionInfo>();
    for (const r of this.deps.store.list()) out.set(r.id, this.rowInfo(r));
    for (const e of this.entries.values()) out.set(e.id, e.info);
    return [...out.values()].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  }

  info(id: string): SessionInfo | null {
    const e = this.entries.get(id);
    if (e) return e.info;
    const r = this.deps.store.get(id);
    return r ? this.rowInfo(r) : null;
  }

  private rowInfo(r: IndexRow): SessionInfo {
    return {
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      running: false,
      workspaceId: this.rowWorkspaceId(r.workspaceId),
      reviewPolicy: r.reviewPolicy ?? null,
      agentId: r.agentId ?? this.deps.agents?.default()?.id ?? null,
      mode: modeOf(r.mode),
    };
  }

  // 是否有会话（池内或索引中）引用该 workspace；删除 workspace 前检查。
  workspaceInUse(id: string): boolean {
    for (const e of this.entries.values())
      if (e.workspaceId === id) return true;
    const created = this.pending.get(id) ?? 0;
    return created > 0 || this.deps.workspaces.sessionCount(id) > 0;
  }

  // 池内未持久化的会话（还没跑过）也算引用，否则删 agent 会让它们悬空。
  agentInUse(id: string): boolean {
    for (const e of this.entries.values()) if (e.agentId === id) return true;
    return this.deps.store.countByAgent(id) > 0;
  }

  // 改名：已加载的走池内会话；未加载的只追加 JSONL 并更新索引，不进池。
  async rename(id: string, nameRaw: string): Promise<SessionInfo | null> {
    const name = nameRaw.trim();
    if (name.length < 1 || name.length > NAME_MAX)
      throw new PoolError("bad_request", `name 需要 1 到 ${NAME_MAX} 个字符`);
    if (!UUID_RE.test(id)) return null;
    const { store, sessionDir } = this.deps;
    const resident = this.entries.get(id);
    if (resident) {
      resident.rename(name);
      if (store.get(id)) store.rename(id, name);
      return resident.info;
    }
    const file = findSessionFile(sessionDir, id);
    if (!file) return null;
    try {
      if (!readHeader(file, id)) throw new Error("会话文件头无效");
      SessionManager.open(file, sessionDir).appendSessionInfo(name);
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    if (!store.get(id)) this.indexFromFile(id, file, name);
    else store.rename(id, name);
    return this.info(id);
  }

  // 设置会话级审核策略：去空白后 0–4000 字符，空串清除。
  async setReviewPolicy(id: string, raw: string): Promise<SessionInfo | null> {
    const policy = raw.trim();
    if (policy.length > POLICY_MAX)
      throw new PoolError(
        "bad_request",
        `reviewPolicy 最多 ${POLICY_MAX} 个字符`,
      );
    if (!UUID_RE.test(id)) return null;
    const value = policy === "" ? null : policy;
    const { store, sessionDir } = this.deps;
    const resident = this.entries.get(id);
    if (resident) resident.reviewPolicy = value;
    if (!store.get(id)) {
      const file = findSessionFile(sessionDir, id);
      if (file) this.indexFromFile(id, file, readName(file));
      else if (!resident) return null;
    }
    if (store.get(id)) store.setReviewPolicy(id, value);
    return this.info(id);
  }

  private indexFromFile(id: string, file: string, name: string | null): void {
    const header = readHeader(file, id);
    if (!header) return;
    this.deps.store.upsert({
      id,
      name,
      createdAt: header.createdAt,
      updatedAt: header.createdAt,
    });
  }

  // 某会话的完整历史；会话存在但还没有 JSONL（空会话）时为空数组，不存在为 null。
  history(id: string): ChatEntry[] | null {
    if (!UUID_RE.test(id)) return null;
    const { sessionDir } = this.deps;
    const file = findSessionFile(sessionDir, id);
    if (file) {
      try {
        return readMessages(file, sessionDir, id);
      } catch (err) {
        throw new PoolError("load_failed", reason(err));
      }
    }
    return this.entries.has(id) ? [] : null;
  }

  // 删除：运行中拒绝；先删文件（失败则什么都不动），再删索引与池内会话。
  async remove(id: string): Promise<"ok" | "not_found" | "running"> {
    if (!UUID_RE.test(id)) return "not_found";
    const { store, sessionDir } = this.deps;
    // 加载中的会话还没进池；不等它就删，加载完成后会话会带着已删除的文件复活。
    await this.loading.get(id)?.catch(() => {});
    const entry = this.entries.get(id);
    if (entry?.busy) return "running";
    const file = findSessionFile(sessionDir, id);
    if (!entry && !file && !store.get(id)) return "not_found";
    if (file) {
      try {
        unlinkSync(file);
      } catch (err) {
        throw new PoolError("delete_failed", reason(err));
      }
    }
    store.remove(id);
    if (entry) {
      this.entries.delete(id);
      entry.dispose();
    }
    return "ok";
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) e.dispose();
    this.entries.clear();
  }
}
