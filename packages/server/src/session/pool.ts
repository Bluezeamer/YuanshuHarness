import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  type ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { BrowserService } from "../browser/service.js";
import type { CanvasService } from "../canvas/service.js";
import type { TurnChangeStore } from "../changes/store.js";
import type { ChangeTracker } from "../changes/tracker.js";
import type { EnvHub } from "../env/hub.js";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import type { PointId } from "../hooks/points.js";
import { type HookRuntime, hookCtx } from "../hooks/runtime.js";
import { uuidv7 } from "../id.js";
import type { JobManager } from "../job/manager.js";
import { snapshotOf } from "../job/messages.js";
import type { McpContextItem } from "../mcp/context.js";
import { configSig, piMcpConfig } from "../mcp/pi-config.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { McpSessionStatus } from "../mcp/session-status.js";
import { liveToolDefs, type McpToolDef } from "../mcp/tools.js";
import type { DirectoryCtx } from "../permission/extension.js";
import type { Evidence, ReviewerFactory } from "../permission/review.js";
import { SudoProbe } from "../permission/sudo.js";
import type { Tier } from "../permission/tier.js";
import { makeExtensionUiContext } from "../plugins/ui-context.js";
import type { ModelRef } from "../prompt/items.js";
import type { ModelResolver } from "../provider/resolve.js";
import {
  type SessionSkill,
  type SkillRuntime,
  skillNotice,
} from "../skills/runtime.js";
import type { AuditInput, AuditLog } from "../store/audit.js";
import type { CallStore } from "../store/calls.js";
import {
  type ImageCompression,
  PI_IMAGE_COMPRESSION,
} from "../store/defaults.js";
import {
  type Directory,
  type DirectoryStore,
  resolveDirectory,
} from "../store/directories.js";
import {
  ATTACHMENT_ENV_ID,
  COLLAB_ENV_ID,
  type EnvironmentStore,
  LOCAL_ENV_ID,
} from "../store/environments.js";
import {
  type BranchEntry,
  type ChatEntry,
  hasDanglingToolCall,
  projectMessages,
  readMessages,
} from "../store/history.js";
import type { JobRow } from "../store/jobs.js";
import type { ReferenceStore } from "../store/references.js";
import type { RuleStore } from "../store/rules.js";
import type { SecretStore } from "../store/secrets.js";
import type { ConfigBody, ConfigModel } from "../store/session-configs.js";
import type { SessionFileStore } from "../store/session-files.js";
import { firstPreview, readPreview } from "../store/session-preview.js";
import {
  emptyState,
  type SessionState,
  type SessionStateStore,
} from "../store/session-state.js";
import {
  conversationLeafId,
  type ForkUserMessage,
  readSessionTree,
  readUserMessages,
  type SessionTreeView,
  treeOf,
  userMessagesOf,
} from "../store/session-tree.js";
import {
  findSessionFile,
  type IndexRow,
  readHeader,
  type SessionStore,
  sessionDirFor,
  UUID_RE,
} from "../store/sessions.js";
import type { SubagentSpec, SubagentStore } from "../store/subagents.js";
import { type TeamStore, teamChangeKey } from "../store/teams.js";
import type { ToolDescriptionStore } from "../store/tool-descriptions.js";
import type { ToolRuleStore } from "../store/tool-rules.js";
import {
  WORKSPACE_DIRECTORIES_MAX,
  type WorkspaceDirectoryStore,
} from "../store/workspace-directories.js";
import type { WorkspaceVariableStore } from "../store/workspace-variables.js";
import type { WorkspaceStore } from "../store/workspaces.js";
import type { CollabArea } from "../subagent/collab.js";
import type { NamedWorkflows } from "../workflow/named.js";
import {
  type AddressBook,
  COLLAB_HOST,
  createAddressBook,
  directoryRef,
  hostLabel,
} from "./address.js";
import { type AgentsFiles, NO_AGENTS_FILES } from "./agents-md.js";
import {
  type AttachmentDirectories,
  type AttachmentRef,
  splitAttachmentMarkers,
} from "./attachments.js";
import { toolAudit } from "./audit.js";
import { toolsOfCaps, unlimitedTools } from "./capabilities.js";
import { type ContextSkill, type ContextView, fileView } from "./context.js";
import { SessionFiles } from "./context-files.js";
import { DELEGATION_TAG, delegationSection } from "./delegation.js";
import {
  allowlist,
  type Delivery,
  type DeliveryHost,
  type ModeView,
  promptSlotsOf,
} from "./delivery.js";
import {
  type DirectoryView,
  directoriesChangedNotice,
  switchNotice,
} from "./directory-tools.js";
import {
  CWD_TAG,
  cwdSection,
  ENVIRONMENT_TAG,
  type EnvironmentHost,
  environmentSection,
  localFacts,
  probeFacts,
} from "./environment.js";
import {
  type Block,
  type ChatMessage,
  cut,
  EVENT_STRING_MAX,
  FRAME_DATA_MAX,
  MAX_ACTIVE_TOOLS,
  MAX_ID,
  MAX_QUEUE_ITEM,
  MAX_QUEUE_ITEMS,
  mapEvent,
  SNAPSHOT_MESSAGE_MAX,
  sanitizeData,
} from "./events.js";
import {
  buildExtensions,
  type ExtensionHost,
  type McpSetup,
} from "./extensions.js";
import { type HeadData, REBUILD_TYPE } from "./frozen.js";
import { GOAL_ROUND_LIMIT_DEFAULT, type GoalNotice } from "./goal.js";
import { GoalDriver, type GoalHost } from "./goal-driver.js";
import type { ImageResize } from "./image-compression.js";
import type { PresetChoice, PresetSelection } from "./preset-selection.js";
import {
  promptText,
  type RenderOutput,
  renderOutput,
} from "./prompt-source.js";
import { type PromptResult, type PromptSpec, PromptTable } from "./prompts.js";
import {
  bodyOf,
  explicitModel,
  type SessionConfigService,
} from "./session-config.js";
import type { SessionFeed } from "./session-feed.js";
import { SessionStateHolder, savedPct } from "./session-state.js";
import { FRAMEWORK_TOOLS, TOOL_NAMES } from "./tool-catalog.js";
import {
  ContentError,
  type ImageInput,
  type ResolvedContent,
  resolveUserContent,
} from "./user-content.js";
import { WorkspaceBinding } from "./workspace-binding.js";

// 索引或 agent 里的模式值读作模式；迁移前或空值按 build。

// 一次运行的结局；subagent 据此给子会话落终态。
export interface RunOutcome {
  aborted: boolean;
  error: string | undefined;
  // 本次运行里最后一条有文字的助手消息。
  text: string;
}

// subagent 运行时挂进池的钩子（ADR-0060）；池本身不依赖它的实现。
export interface SubagentHooks {
  // 该会话可用的子代理工具（派发、联系、交付）。
  tools(sessionId: string, isChild: boolean): ExtensionFactory;
  runEnded(entry: SessionEntry, outcome: RunOutcome): void;
  // 用户在子代理自己的标签里点了停止：按 subagent.md S5 链式停止，并回调给派发它的会话。
  userStopped(sessionId: string): void;
  // 子代理开始了一次工具调用：记进任务日志，父用 job_list 看得到「最近的动作」。
  toolStarted(sessionId: string, tool: { name: string; args: unknown }): void;
}

// 子会话创建时给池的父子信息。
export interface ChildInit {
  parentId: string;
  depth: number;
  task: string;
  spec: SubagentSpec;
  // 子会话的激活模式：沿用父的，没有时是派发时指定的（子会话不能自己切换模式）。
  activeModeId: string | null;
  // 是否计入存活上限（工作流的 agent 不计入，走工作流自己的并发限制）。
  counted?: boolean;
  // 工作流里的 agent：所属运行（工作流任务 id）与阶段。
  run?: { id: string; phase: string | null };
}

// 工厂按 agent 定义装配会话：工具白名单、提示词基线、模型与推理强度。
export interface FactoryAgent {
  tools: string[];
  // 每次 reload 时重新取，所以基线更新后下一次 compaction 重建即可生效。
  promptText: () => string;
  /** 接管后的 preamble（送进 pi 的 customPrompt） */
  identity: () => string;
  // 模型登记 id（旧登记）或供应商 id；与 modelName 一起定位供应商里的某个模型。
  modelId: string | null;
  modelName: string | null;
  thinkingLevel: string | null;
}

export interface FactoryOptions {
  id: string;
  sessionDir: string;
  // 会话所属 directory 的绝对路径，即工具的工作目录。
  cwd: string;
  // 恢复已有会话时给出其 JSONL 路径；新建时缺省。
  file?: string;
  // 池提供的扩展（ask_user、权限拦截），由工厂交给资源加载器的 extensionFactories。
  extensions: ExtensionFactory[];
  // 缺省（测试里的假工厂）时不做 agent 装配。
  agent?: FactoryAgent;
  // 本会话此刻应生效的 skill（已同步到 directory 的环境），工厂注入提示词（ADR-0055）。
  // 是函数：重载 / 重建时 pi 会重新读技能，要拿到会话此刻的，而不是创建那一刻的。
  skills?: () => SessionSkill[];
  // 新会话直接沿用这份冻结物（子代理与父同一 Agent 时，开头系统消息与工具声明逐字节相同）。
  seedHead?: HeadData;
  // 插件 UI 通道（plugin.md §4）：有它 pi 的 hasUI() 为真，插件才会走弹窗路径。
  // 会话条目在工厂执行期间还不存在，所以由池给一个按 id 惰性取条目的实现；无人值守的子会话不给。
  ui?: ExtensionUIContext;
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
  /** 首条用户消息的标题种子；常驻会话现算，否则取索引行 */
  preview: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  directoryId: string;
  promptPresetId: string | null;
  /** 会话可切换的模式预设清单 */
  modePresetIds: string[];
  /** 当前激活的模式预设；null = 没有 */
  activeModeId: string | null;
}

export class PoolError extends Error {
  constructor(
    readonly code:
      | "bad_request"
      | "disposed"
      | "load_failed"
      | "delete_failed"
      | "prompt_resolved"
      | "prompt_unknown"
      | "session_running",
    message: string,
  ) {
    super(message);
  }
}

const WINDOW = 50;
// 协作区目录的 createdAt：它不入库、没有真实创建时间，固定值免得清单每次比较都变。
const COLLAB_CREATED_AT = "1970-01-01T00:00:00.000Z";
// 单条排队输入的长度上限：只为挡住异常载荷，正常输入远小于它。
const MAX_QUEUE_TEXT = 32 * 1024;

type SdkAgent = AgentSession["agent"];
type QueuedMessage = ReturnType<SdkAgent["peekQueuedMessages"]>[number];
type QueueImage = NonNullable<Parameters<AgentSession["steer"]>[1]>[number];

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// 重排排队消息时把原始消息里的图片原样带回：文本用编辑后的值重建，图片没有编辑入口。
function queueImages(m: QueuedMessage): QueueImage[] | undefined {
  if (m.role !== "user" || !Array.isArray(m.content)) return undefined;
  const images = m.content.filter(
    (c): c is QueueImage => (c as { type?: unknown }).type === "image",
  );
  return images.length > 0 ? images : undefined;
}

const requireQueueIndex = (index: number, total: number): void => {
  if (!Number.isInteger(index) || index < 0 || index >= total)
    throw new PoolError("bad_request", "排队消息不存在（可能已经送达）");
};

// 重排队列时的单条内容；images 是这次编辑解析出的图片（没编辑的条目不给，沿用原图）。
type QueuedEdit = { text: string; images?: QueueImage[] };
const toEdit = (text: string): QueuedEdit => ({ text });

export interface EntryOptions {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  directoryId?: string;
  activeModeId?: string | null;
  // 所属工作区：会话不换工作区。
  workspaceId?: string | null;
  // 提示词基线（会话创建或最近一次同步时拼好的文本）。
  promptText?: string | null;
  /** 最近一次渲染结果：preamble 走 customPrompt，其余段走 sections */
  promptRender?: RenderOutput | null;
  /** user 通道：首条用户消息前注入一次 */
  userPromptText?: string | null;
  /** 是否已经发过首条用户消息（user 通道只注入一次） */
  prompted?: boolean;
  promptPresetId?: string | null;
  /** 创建时多选的应用模式预设（按选择顺序） */
  modePresetIds?: string[];
  /** 基线时刻读到的两份 AGENTS.md；缺省为都没有 */
  agentsFiles?: AgentsFiles;
  // 恢复时用 JSONL 里最近的消息播种窗口。
  seed?: ChatMessage[];
  // 恢复时会话里已有的消息总数（含窗口之外的）；缺省等于 seed 的条数。
  seedTotal?: number;
  // 恢复时发现悬挂的工具调用：下一次发送前先附加“上次被中断”的通知。
  interrupted?: boolean;
  // 每次运行结束后调用（持久化索引）；抛错不影响事件流。
  onRunEnded?: (entry: SessionEntry, outcome: RunOutcome) => void;
  // 发送失败在运行开始之前（没有模型 / 缺密钥）：不会有 run.ended，要靠它收尾。
  onRunFailed?: (entry: SessionEntry, error: string) => void;
  /** 一轮开始（自动重试不重复触发）：改动追踪在这里取基线。 */
  onRunStart?: (entry: SessionEntry) => void;
  /** 弹窗出现 / 消除：列表上的状态与标记随之变化。 */
  onPromptsChanged?: (entry: SessionEntry) => void;
  /** 写类工具开始前：非 git 目录靠它留下旧内容。 */
  onToolStart?: (
    entry: SessionEntry,
    tool: { name: string; args: unknown },
  ) => void;
  // send / notify 收尾后调用：run.ended 到来时发送调用还没返回（busy 仍为真），要等到这里才真正空闲。
  onSettled?: (entry: SessionEntry) => void;
  // 用户中断该会话时调用（先于 abort）。
  onStop?: (entry: SessionEntry) => void;
  // 目标的轮数上限缺省值（设置里现取）；不给按 50。
  goalMaxRounds?: () => number | null;
  // 本会话名下有在跑的后台任务；缺省按没有。
  runningJobs?: (id: string) => boolean;
  // 本会话名下有在跑的子代理（目标续跑等它）；缺省按没有。
  hasRunningInTree?: (id: string) => boolean;
  // 发消息前取走待告知的系统提示，随这条消息的下一轮带给模型。
  takeNotices?: (entry: SessionEntry) => { text: string; job: JobRow }[];
  // 发消息前、会话空闲时调用：把登记里新增的能力（MCP）接上。失败不拦发送。
  beforeSend?: (entry: SessionEntry) => Promise<void>;
  // 工具调用开始/结束时记审计。
  onAudit?: (
    entry: SessionEntry,
    rec: Pick<AuditInput, "summary" | "detail">,
  ) => void;
  // 压缩成功后调用：提示词基线在此挂点重建。
  onCompacted?: (entry: SessionEntry) => void;
  // 弹窗超时（毫秒），缺省 30 分钟；测试用。
  promptTimeoutMs?: number;
  // 目标 / 计划 / 压缩状态的落库；缺省时只在内存里。
  states?: SessionStateStore;
  // 调用记录：运行结束事件与快照据此带用量；缺省时不带。
  calls?: CallStore;
  // 读取的文件表（右栏上下文）；缺省时不记录。
  files?: SessionFileStore;
  // 工具调用结束时会话所在的环境 id（文件表的 hostId）。
  hostOf?: (entry: SessionEntry) => string;
}

const INTERRUPTED_NOTICE =
  "The previous run was interrupted (server restart); its tool calls got no result. Decide yourself whether to redo them.";

export class SessionEntry {
  readonly id: string;
  readonly createdAt: string;
  directoryId: string;
  // 所属工作区；会话不换工作区。
  workspaceId: string | null;
  // 切换 directory 后待在下一轮末尾追加的通知。
  directoryNotice: string | null = null;
  // 提示词与通知里已列出的 skill 目录，切换时只补没列过的。
  readonly listedSkills = new Set<string>();
  // 创建时由预设的权限档位定下，会话内固定。
  activeModeId: string | null;
  promptText: string | null;
  /** 最近一次渲染结果：preamble 走 customPrompt，其余段走 sections */
  promptRender: RenderOutput | null;
  /** user 通道：首条用户消息前注入一次 */
  userPromptText: string | null;
  /** 是否已经发过首条用户消息 */
  prompted: boolean;
  /** 创建时选择的 agent 预设（提示词来源）；null = 默认预设 */
  promptPresetId: string | null;
  /** 创建时多选的应用模式预设（按选择顺序） */
  modePresetIds: string[];
  /** 基线时刻读到的两份 AGENTS.md */
  agentsFiles: AgentsFiles;
  // 压缩后待重建基线（运行中不能 reload，等空闲）。
  rebasePending = false;
  // 运行中收到的模型 / 档位变更，等本轮结束再应用。
  modelSyncPending = false;
  private reloading: Promise<void> | null = null;
  updatedAt: string;
  running = false;
  // 当前运行的 id，只给调用记录分组用；空闲时为 null。
  runId: string | null = null;
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
  // 运行中的工具：id → { 名字, 父 id }。父 id 用来让前端把嵌套调用（如 call_tool 转发的）挂到父调用下。
  private readonly activeTools = new Map<
    string,
    { name: string; parent?: string }
  >();
  private queue: string[] = [];
  private runError: string | undefined;
  private readonly unsubscribeSdk: () => void;
  private disposed = false;
  // 弹窗只存内存；表的钩子负责占 seq 广播。
  readonly prompts: PromptTable;
  // 展示编号；新建的会话在落库前暂存在这里，从索引加载的会话为 null（以索引行为准）。
  seqNo: number | null = null;
  // 长期目标 / 任务清单 / 压缩状态；变更即落库并广播。
  readonly state: SessionStateHolder;
  // 目标续跑：唯一入口（用户侧操作、模型工具、续跑判定、事件钩子）。
  readonly goal: GoalDriver;
  // 手动压缩进行中：期间收到的发送先排在 held 里，不能再压缩。
  private compacting = false;
  // 压缩期间收到的发送：当作排队消息显示与编辑，压缩结束后依次发出。
  private held: { text: string; images: ImageInput[] }[] = [];
  // 压缩后发出的第一条开始运行时才把其余的排进去：同一时刻起两个 prompt 会撞车。
  private afterStart: (() => void) | null = null;
  // read / edit / write 命中的文件表；变化时推 context.updated。
  private readonly files: SessionFiles;
  // 本会话实际注入的 skill（启动、恢复、切换 directory 时 prepare 的结果，按 SKILL.md 路径去重）。
  private readonly loadedSkills = new Map<string, ContextSkill>();

  constructor(
    private readonly session: AgentSession,
    private readonly opts: EntryOptions = {},
  ) {
    this.id = opts.id ?? uuidv7();
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.updatedAt = opts.updatedAt ?? this.createdAt;
    this.directoryId = opts.directoryId ?? "";
    this.workspaceId = opts.workspaceId ?? null;
    this.activeModeId = opts.activeModeId ?? null;
    this.promptText = opts.promptText ?? null;
    this.promptRender = opts.promptRender ?? null;
    this.userPromptText = opts.userPromptText ?? null;
    this.prompted = opts.prompted ?? false;
    this.promptPresetId = opts.promptPresetId ?? null;
    this.modePresetIds = opts.modePresetIds ?? [];
    this.agentsFiles = opts.agentsFiles ?? NO_AGENTS_FILES;
    this.interrupted = opts.interrupted === true;
    // 排队消息一次全部注入：SDK 默认 one-at-a-time 会把连续输入拆到多个步骤，体感像“分批次注入”。
    const agent = this.session.agent;
    if (agent) {
      agent.steeringMode = "all";
      agent.followUpMode = "all";
    }
    this.state = new SessionStateHolder(this.id, opts.states, (t, d) =>
      this.emit(t, d),
    );
    this.goal = new GoalDriver(
      {
        busy: () => this.busy,
        hasPendingWork: () => this.hasPendingWork(),
        inject: (text, notice, images) => this.injectGoal(text, notice, images),
        note: (notice) => this.noteGoal(notice),
        stop: () => this.stop(),
        defaultMaxRounds: () =>
          (opts.goalMaxRounds ?? (() => GOAL_ROUND_LIMIT_DEFAULT))(),
      } satisfies GoalHost,
      this.state,
    );
    // 载入时还在跑的目标转为暂停，等用户点继续（打开会话不是授权花钱）。
    this.goal.restore();
    this.files = new SessionFiles(
      this.id,
      opts.files,
      () => opts.hostOf?.(this) ?? LOCAL_ENV_ID,
      (files) => this.publish("context.updated", { files }),
    );
    this.prompts = new PromptTable(
      {
        requested: (d) => {
          this.emit("prompt.requested", { ...d });
          this.opts.onPromptsChanged?.(this);
        },
        resolved: (d) => {
          this.emit("prompt.resolved", d);
          this.opts.onPromptsChanged?.(this);
        },
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
      this.markRebuild();
      this.rebasePending = true;
      this.opts.onCompacted?.(this);
      this.state.setCompact(
        e.result.summary,
        savedPct(e.result.tokensBefore, e.result.estimatedTokensAfter),
      );
    }
    const mapped = mapEvent(e);
    if (!mapped) return;
    if (e.type === "tool_execution_start" || e.type === "tool_execution_end")
      this.opts.onAudit?.(this, toolAudit(e));
    if (e.type === "tool_execution_start") {
      try {
        this.opts.onToolStart?.(this, { name: e.toolName, args: e.args });
      } catch {
        // 同上：追踪不影响运行
      }
    }
    let outcome: RunOutcome | undefined;
    if (mapped.type === "run.started") {
      // 自动重试会反复 agent_start；一次运行只对外开始一次。
      if (this.running) return;
      this.running = true;
      this.runId = uuidv7();
      this.runError = undefined;
      try {
        this.opts.onRunStart?.(this);
      } catch {
        // 追踪失败不影响运行
      }
      const next = this.afterStart;
      this.afterStart = null;
      next?.();
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
      Object.assign(mapped.data, this.runStats());
      if (this.runError !== undefined)
        this.emit("run.failed", { message: this.runError });
      outcome = {
        aborted: (mapped.data as { aborted?: unknown }).aborted === true,
        error: this.runError,
        text: this.lastAssistantText(),
      };
      this.runError = undefined;
      this.running = false;
      this.runId = null;
    }
    this.emit(mapped.type, mapped.data);
    this.files.observe(e);
    if (outcome) {
      this.updatedAt = new Date().toISOString();
      try {
        this.opts.onRunEnded?.(this, outcome);
      } catch {
        // 索引写入失败不得影响事件流；下次启动对账会补齐。
      }
    }
  }

  // 本轮的累计用量与步数、会话累计轮数；没有调用记录库时不带。
  private runStats(): Record<string, unknown> {
    const { calls } = this.opts;
    if (!calls || !this.runId) return {};
    try {
      const r = calls.runUsage(this.id, this.runId);
      return { usage: r.tokens, steps: r.steps, turn: r.turns };
    } catch {
      return {};
    }
  }

  // 窗口里最近一条有文字的助手消息（子会话的最终结果取自这里）。
  /** 最后一条助手消息的落定时间：轮次改动卡片靠它挂到对应消息下面。 */
  lastAssistantTs(): string | null {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const m = this.recent[i];
      if (m?.role === "assistant" && m.ts) return m.ts;
    }
    return null;
  }

  /** 最近一条用户消息（浏览器清洗层拿它当「agent 在找什么」）。 */
  lastUserText(): string {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const m = this.recent[i];
      if (m?.role === "user" && m.text.trim() !== "") return m.text;
    }
    return "";
  }

  private lastAssistantText(): string {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const m = this.recent[i];
      if (m?.role === "assistant" && m.text.trim() !== "") return m.text;
    }
    return "";
  }

  get name(): string | null {
    return this.session.sessionManager.getSessionName() ?? null;
  }

  // 常驻会话的消息都在内存里：标题种子现算，发完首条消息下一次列表就能用上。
  get preview(): string | null {
    return firstPreview(this.session.sessionManager.getEntries());
  }

  // 只读句柄：树与当前分支按运行中的会话读，回退后 JSONL 末行并不代表当前 leaf。
  get sessionManager(): SessionManager {
    return this.session.sessionManager;
  }

  rename(name: string): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    this.session.sessionManager.appendSessionInfo(name);
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      name: this.name,
      preview: this.preview,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      running: this.running,
      directoryId: this.directoryId,
      promptPresetId: this.promptPresetId,
      modePresetIds: this.modePresetIds,
      activeModeId: this.activeModeId,
    };
  }

  // 当前模型与生效的工具名（SDK 视角）；flows 清单展示用。
  runtimeInfo(): {
    model: string | null;
    window: number | null;
    tools: string[];
  } {
    const m = this.session.model;
    return {
      model: m?.id ?? null,
      window: m?.contextWindow ?? null,
      tools: this.disposed ? [] : this.session.getActiveToolNames(),
    };
  }

  // 外部模块（如 subagent 运行时）向本会话订阅者广播一个事件；占 seq，与内部事件同序。
  publish(type: string, data: Record<string, unknown>): void {
    if (!this.disposed) this.emit(type, data);
  }

  // 记下注入的 skill：目录进 listedSkills（切换通知只补没列过的），SKILL.md 路径进 loadedSkills。
  noteSkills(skills: SessionSkill[] | undefined): void {
    const at = new Date().toISOString();
    for (const s of skills ?? []) {
      this.listedSkills.add(s.baseDir);
      if (!this.loadedSkills.has(s.filePath))
        this.loadedSkills.set(s.filePath, {
          name: s.name,
          source: s.scope === "global" ? "library" : "directory",
          path: s.filePath,
          loadedAt: at,
        });
    }
  }

  get skillsLoaded(): ContextSkill[] {
    return [...this.loadedSkills.values()];
  }

  /** pi 此刻注册的全部工具名（含扩展在连上之后才注册的 MCP 工具）。 */
  get registeredTools(): string[] {
    return this.disposed ? [] : this.session.getAllTools().map((t) => t.name);
  }

  // 后续的发送要先等这件事做完（运行结束后的模型同步），否则紧接着发的消息会用上旧模型。
  holdSend(p: Promise<unknown>): void {
    const prev = this.reloading;
    const q: Promise<void> = Promise.all([
      prev?.catch(() => {}),
      p.catch(() => {}),
    ])
      .then(() => {})
      .finally(() => {
        if (this.reloading === q) this.reloading = null;
      });
    this.reloading = q;
  }

  // 空闲时把会话切到另一个模型 / 思考档位；同一个模型就只调档位。
  async applyModel(
    model: Parameters<AgentSession["setModel"]>[0],
    thinkingLevel: string | null,
  ): Promise<void> {
    const cur = this.session.model;
    if (!cur || cur.provider !== model.provider || cur.id !== model.id) {
      await this.session.setModel(model);
      this.markRebuild();
    }
    if (thinkingLevel && this.session.thinkingLevel !== thinkingLevel)
      this.session.setThinkingLevel(
        thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0],
      );
  }

  // 作废冻结物：下一次请求按那时的提示词与工具重新冻结（压缩、重载、换模型都走这里）。
  private markRebuild(): void {
    this.session.sessionManager.appendCustomEntry(REBUILD_TYPE, {});
  }

  // 只让扩展重新读配置并重连（MCP 登记变了）：不写重建标记，前缀不动，新增的工具之后走尾部通知。
  reconnect(): Promise<void> {
    return this.session.reload();
  }

  // 让 SDK 重新读取提示词基线（resourceLoader.reload）；发送会等它完成。
  reloadPrompt(): Promise<void> {
    this.markRebuild();
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
            ...(typeof data.ts === "string" ? { ts: data.ts } : {}),
            ...(Array.isArray(data.blocks)
              ? { blocks: data.blocks as Block[] }
              : {}),
            ...(Array.isArray(data.attachments)
              ? { attachments: data.attachments as AttachmentRef[] }
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
          this.activeTools.set(data.toolCallId, {
            name: data.toolName,
            ...(typeof data.parentToolCallId === "string" &&
            data.parentToolCallId.length <= MAX_ID
              ? { parent: data.parentToolCallId }
              : {}),
          });
        break;
      case "tool.ended": {
        const id = typeof data.toolCallId === "string" ? data.toolCallId : null;
        if (id) {
          this.activeTools.delete(id);
          // 历史/快照里的工具块也要补上结果：模型消息本身只带 toolCall，结果在之后的工具事件里。
          const output = typeof data.output === "string" ? data.output : "";
          const isError = data.isError === true;
          const parent =
            typeof data.parentToolCallId === "string"
              ? data.parentToolCallId
              : null;
          const dur =
            typeof data.durationMs === "number" ? data.durationMs : undefined;
          const name = typeof data.toolName === "string" ? data.toolName : "";
          for (const m of this.recent)
            for (const b of m.blocks ?? []) {
              if (b.type !== "tool") continue;
              if (b.id === id) {
                b.result = output;
                b.isError = isError;
                continue;
              }
              // 嵌套调用：挂到父工具块里，随历史与快照一起下发
              if (parent && b.id === parent && name) {
                b.children = [
                  ...(b.children ?? []),
                  {
                    id,
                    name,
                    result: output,
                    isError,
                    ...(dur === undefined ? {} : { durationMs: dur }),
                  },
                ];
              }
            }
        }
        break;
      }
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
    const activeTools = [...this.activeTools].map(([toolCallId, t]) => ({
      toolCallId,
      toolName: t.name,
      ...(t.parent === undefined ? {} : { parentToolCallId: t.parent }),
    }));
    const { goal, todo, compact } = this.state.view();
    let usage: unknown;
    try {
      usage = this.opts.calls?.usage(this.id);
    } catch {
      // 用量取不到只是指标行暂时没数据，不挡快照
    }
    const extra = {
      goal,
      todos: todo,
      compact,
      ...(usage === undefined ? {} : { usage }),
    };
    for (const limit of [SNAPSHOT_MESSAGE_MAX, 4 * 1024, 0]) {
      const trim = (m: ChatMessage) => ({
        role: m.role,
        text: cut(m.text, limit),
        ...(m.ts === undefined ? {} : { ts: m.ts }),
        ...(m.attachments ? { attachments: m.attachments } : {}),
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
        ...extra,
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

  get isCompacting(): boolean {
    return this.compacting;
  }

  get busy(): boolean {
    return this.running || this.starting > 0;
  }

  /** 当前模型是否支持图片输入（附件里的图片据此决定是否拒绝）。 */
  get supportsImages(): boolean {
    return this.session.model?.input.includes("image") === true;
  }

  // 返回时命令已被接受；整个运行是否成功由事件流告知。
  send(text: string, images: ImageInput[] = []): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    if (text.trim() === "") throw new PoolError("bad_request", "text 不能为空");
    this.prompted = true;
    // 模型不支持图片时 SDK 会把图片悄悄换成一句占位文字，必须在这里拒绝。
    if (images.length && !this.supportsImages)
      throw new PoolError("bad_request", "当前模型不支持图片输入");
    // 压缩期间 SDK 不收 prompt：先排着，压缩结束后由 flushHeld 发出。
    if (this.compacting) {
      if (this.held.length >= MAX_QUEUE_ITEMS)
        throw new PoolError("bad_request", "排队的消息太多了");
      this.held.push({ text, images });
      this.publishHeld();
      return;
    }
    const notice = this.interrupted;
    this.interrupted = false;
    const notices = this.opts.takeNotices?.(this) ?? [];
    this.starting++;
    (async () => {
      await this.reloading?.catch(() => {});
      // 别的运行还在跑时（这条是排队的插话）不动连接；空闲才接上新增的能力
      if (!this.running) await this.opts.beforeSend?.(this).catch(() => {});
      if (notice)
        await this.session.sendCustomMessage(
          {
            customType: "yuanshu.interrupted",
            content: INTERRUPTED_NOTICE,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      for (const n of notices)
        await this.session.sendCustomMessage(
          {
            customType: "yuanshu.subagent",
            content: n.text,
            display: false,
            details: { job: snapshotOf(n.job) },
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
      .catch((err) => this.runFailed(err))
      .finally(() => {
        this.starting--;
        this.opts.onSettled?.(this);
      });
  }

  // 编辑 / 删除一条排队中的用户消息；index 是 queue_update 里的顺序（steering 在前、follow-up 在后）。
  // pi 没有单条增删 API：先取出文本队列与 agent 队列里的原始消息，清空后按原类型与顺序重排。
  // 取舍：重排期间队列短暂为空（会多发几帧 queue.updated），且重排会重新走一遍输入扩展；
  // 原型阶段接受，正常点击编辑/删除时当前步骤还没结束，SDK 不会在这期间排空队列。
  // text 是已经解析好的用户内容（含 `[attach_file]` 标记行），images 是这次解析出来的图片，
  // 它们一起替换该条排队消息原有的内容；长度上限按不含标记行的原文判。
  editQueue(
    index: number,
    text: string,
    images: ImageInput[] = [],
  ): Promise<void> {
    const { text: body, attachments } = splitAttachmentMarkers(text);
    if (body.trim() === "" && !attachments)
      return Promise.reject(new PoolError("bad_request", "text 不能为空"));
    if (body.trim().length > MAX_QUEUE_TEXT)
      return Promise.reject(
        new PoolError("bad_request", `text 不能超过 ${MAX_QUEUE_TEXT} 个字符`),
      );
    if (this.compacting)
      return this.rewriteHeld((held) => {
        requireQueueIndex(index, held.length);
        held[index] = { text, images };
      });
    return this.rewriteQueue((steering, followUp) => {
      requireQueueIndex(index, steering.length + followUp.length);
      const edit = {
        text,
        images: images.map((i) => ({ type: "image" as const, ...i })),
      };
      if (index < steering.length) steering[index] = edit;
      else followUp[index - steering.length] = edit;
    });
  }

  removeQueue(index: number): Promise<void> {
    if (this.compacting)
      return this.rewriteHeld((held) => {
        requireQueueIndex(index, held.length);
        held.splice(index, 1);
      });
    return this.rewriteQueue((steering, followUp) => {
      requireQueueIndex(index, steering.length + followUp.length);
      if (index < steering.length) steering.splice(index, 1);
      else followUp.splice(index - steering.length, 1);
    });
  }

  // 编辑排队消息需要完整内容：快照 / queue_update 里的 queue 为显示做了截断（MAX_QUEUE_ITEM），
  // 拿截断文本当编辑起点会静默丢掉头部之后的内容，所以单独取一次全文。
  // 附着在末尾的 `[attach_file]` 标记行剥出来当附件引用，text 只留用户原文。
  // 条数与一帧的体量沿用现有队列上限；超过一帧能装下的量时明确拒绝，而不是再截断一次。
  queueTexts(): { text: string; attachments?: AttachmentRef[] }[] {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    const queue = (
      this.compacting
        ? this.held.map((h) => h.text)
        : [
            ...this.session.getSteeringMessages(),
            ...this.session.getFollowUpMessages(),
          ]
    )
      .slice(0, MAX_QUEUE_ITEMS)
      .map((q) => splitAttachmentMarkers(q));
    if (Buffer.byteLength(JSON.stringify(queue)) > FRAME_DATA_MAX)
      throw new PoolError("bad_request", "排队内容过大，暂不支持在线编辑");
    return queue;
  }

  // plan 先按当前文本算出重排结果（越界在这里抛错），此时还没动队列；
  // 再把 agent 队列里的原始消息取出来、清空，最后按原类型顺序重排。
  // 压缩期间排着的消息：编辑 / 删除后把队列重新广播出去。
  private async rewriteHeld(
    change: (held: { text: string; images: ImageInput[] }[]) => void,
  ): Promise<void> {
    change(this.held);
    this.publishHeld();
  }

  private publishHeld(): void {
    this.emit("queue.updated", {
      queue: this.held.map((h) => cut(h.text, MAX_QUEUE_ITEM)),
    });
  }

  // 压缩结束（成功或失败）：把期间排着的消息发出去，第一条起运行，其余等它开始后作为插话排进队列。
  private flushHeld(): void {
    const [first, ...rest] = this.held;
    if (!first || this.disposed) return;
    this.held = [];
    this.publishHeld();
    if (rest.length)
      this.afterStart = () => {
        for (const h of rest) this.send(h.text, h.images);
      };
    try {
      this.send(first.text, first.images);
    } catch (err) {
      this.afterStart = null;
      this.runFailed(err);
    }
  }

  private async rewriteQueue(
    plan: (steering: QueuedEdit[], followUp: QueuedEdit[]) => void,
  ): Promise<void> {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    const steering = this.session.getSteeringMessages().map(toEdit);
    const followUp = this.session.getFollowUpMessages().map(toEdit);
    plan(steering, followUp);
    // 文本队列之外，agent 队列还存着图片与自定义消息（子代理结果通知等）；它们不在 queue_update 里。
    const { steering: steeringRaw, followUp: followUpRaw } =
      this.takeAgentQueues();
    this.session.clearQueue();
    await this.replayQueue(steeringRaw, steering, "steer");
    await this.replayQueue(followUpRaw, followUp, "followUp");
  }

  // 取出 agent 两个队列里的全部原始消息（含图片与自定义消息），steering 顺手清空，follow-up 只取不清；
  // 调用方随后 clearQueue 再按需放回。peek 在 steering 有内容时只给 steering、否则给 follow-up，
  // mode 要调成 all 才拿全量；清空 steering 后再看一次：前后是同一批对象，说明 steering 本来就是空的。
  private takeAgentQueues(): {
    steering: QueuedMessage[];
    followUp: QueuedMessage[];
  } {
    const { agent } = this.session;
    const modes = { steer: agent.steeringMode, followUp: agent.followUpMode };
    agent.steeringMode = "all";
    agent.followUpMode = "all";
    const first = agent.peekQueuedMessages();
    agent.clearSteeringQueue();
    const followUp = agent.peekQueuedMessages();
    agent.steeringMode = modes.steer;
    agent.followUpMode = modes.followUp;
    const same =
      first.length === followUp.length &&
      first.every((m, i) => m === followUp[i]);
    return { steering: same ? [] : first, followUp };
  }

  // 按原始顺序重排：用户消息用（编辑后的）内容重建并带回图片，自定义消息原样放回；
  // 编辑过的条目（plan 里指定的 images）优先用它自己的图片，其余条目仍带回各自原图；
  // 被删掉的那条原始消息（连同图片）直接跳过。
  private async replayQueue(
    raw: QueuedMessage[],
    edits: QueuedEdit[],
    behavior: "steer" | "followUp",
  ): Promise<void> {
    const { agent } = this.session;
    const queue = (text: string, images?: QueueImage[]): Promise<unknown> =>
      behavior === "steer"
        ? this.session.steer(text, images)
        : this.session.followUp(text, images);
    let i = 0;
    for (const m of raw) {
      if (m.role !== "user") {
        if (behavior === "steer") agent.steer(m);
        else agent.followUp(m);
        continue;
      }
      const edit = edits[i];
      i += 1;
      if (edit === undefined) continue;
      await queue(edit.text, edit.images ?? queueImages(m));
    }
    // 兜底：正常一一对应；万一原始消息缺了用户条目，文本也要排回去。
    for (; i < edits.length; i += 1) {
      const edit = edits[i];
      if (edit !== undefined) await queue(edit.text, edit.images);
    }
  }

  // 系统消息（子会话的结果、后台任务的回调等）：不是用户输入，不进可信证据；空闲则唤醒本会话。
  // 运行中：followUp 排在本轮结束之后；steer 在下一步模型调用之前注入（后台任务的回调用它——提醒与回调都走这里）。
  // 给了 job（终态回调）就在消息上带卡片用的快照，实时事件与历史接口据此出卡片。
  notify(
    text: string,
    deliverAs: "followUp" | "steer" = "followUp",
    job?: JobRow,
  ): boolean {
    if (this.disposed) return false;
    this.starting++;
    this.session
      .sendCustomMessage(
        {
          customType: "yuanshu.subagent",
          content: text,
          display: false,
          ...(job ? { details: { job: snapshotOf(job) } } : {}),
        },
        { triggerTurn: true, deliverAs },
      )
      .catch((err) => this.runFailed(err))
      .finally(() => {
        this.starting--;
        this.opts.onSettled?.(this);
      });
    return true;
  }

  private runFailed(err: unknown): void {
    this.afterStart = null;
    this.emit("run.failed", { message: reason(err) });
    if (!this.running) this.opts.onRunFailed?.(this, reason(err));
  }

  // 有排队的用户消息，或有在跑的后台任务 / 子代理（它们结束的回调会再唤醒本会话）。
  private hasPendingWork(): boolean {
    if (this.queue.length > 0) return true;
    if (this.opts.runningJobs?.(this.id) === true) return true;
    return this.opts.hasRunningInTree?.(this.id) ?? false;
  }

  // 目标轮：注入一条 custom 消息并触发一轮；卡片随消息一起下发（与 notify 同一条路径）。
  // 带图片时内容是文字 + 图片块（custom 消息的 content 本来就允许）。
  private injectGoal(
    text: string,
    notice: GoalNotice,
    images?: ImageInput[],
  ): void {
    if (this.disposed) return;
    this.starting++;
    this.session
      .sendCustomMessage(
        {
          customType: "yuanshu.goal",
          content:
            images && images.length > 0
              ? [
                  { type: "text" as const, text },
                  ...images.map((i) => ({
                    type: "image" as const,
                    data: i.data,
                    mimeType: i.mimeType,
                  })),
                ]
              : text,
          display: false,
          details: { goal: notice },
        },
        { triggerTurn: true, deliverAs: "steer" },
      )
      .catch((err) => this.runFailed(err))
      .finally(() => {
        this.starting--;
        this.opts.onSettled?.(this);
      });
  }

  // 只出卡片、不进模型上下文：写一条只带数据的 custom 条目，再实时推一帧。
  private noteGoal(notice: GoalNotice): void {
    if (this.disposed) return;
    try {
      this.session.sessionManager.appendCustomEntry("yuanshu.goal", {
        goal: notice,
      });
    } catch {
      // 会话文件写不进去不能影响目标本身的状态
    }
    this.publish("notice", {
      kind: "goal",
      goal: notice,
      ts: new Date().toISOString(),
    });
  }

  // 用户的这条消息被 hook 挡下：告知前端（该消息没有交给模型）。
  reject(message: string): void {
    if (!this.disposed) this.emit("run.failed", { message });
  }

  // 发弹窗并等结果；会话已关闭时直接视为撤销。
  ask(spec: PromptSpec, signal?: AbortSignal): Promise<PromptResult> {
    if (this.disposed) return Promise.resolve({ outcome: "cancelled" });
    return this.prompts.ask(spec, signal);
  }

  answerPrompt(
    promptId: string,
    a: {
      optionId?: unknown;
      text?: unknown;
      images?: ImageInput[];
      attached?: boolean;
    },
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
    try {
      this.opts.onStop?.(this);
    } catch {
      // 子会话的联动中断失败不得挡住本会话的停止。
    }
    // 先撤销弹窗，让卡在审批/提问上的工具调用按拒绝收场，abort 才能结束运行。
    this.prompts.cancelAll();
    // 先清队列再 abort（同步完成，期间没有 await）：不然运行收尾时仍可能把排队的消息送进下一步。
    this.dropQueued();
    await this.session.abort();
  }

  // 停止即放弃还没送达的排队消息：abort 不会碰队列，留着的话它们会被夹带进下一次发送。
  // 清空由 SDK 发 queue_update，经事件流（queue.updated）同步给所有订阅者。
  private dropQueued(): void {
    // pendingMessageCount 只数用户排队的消息（send 的 steer）。
    if (!(this.session.pendingMessageCount > 0)) return;
    const { agent } = this.session;
    // notify 排进队列的系统通知（子代理结果、后台任务回调）不是用户输入，已向调用方标记为已告知，丢了就再没人说；
    // SDK 的 clearQueue 会连它们一起清，所以先取出、清完再按原队列排回去。
    const { steering, followUp } = this.takeAgentQueues();
    this.session.clearQueue();
    for (const n of steering.filter((m) => m.role === "custom")) agent.steer(n);
    for (const n of followUp) agent.followUp(n);
  }

  // B20 历史回退：把 leaf 移到历史节点（同一文件内）。成功后按新分支重建窗口投影，
  // 并向已连接客户端广播一次完整快照替换——回退不产生事件帧，增量无从表达。
  // editor 里是这条用户消息的原文与剥出的附件（标记行不当文字吐回去）。
  async navigate(targetId: string): Promise<{
    editor?: { text: string; attachments?: AttachmentRef[] };
    leafId: string | null;
  }> {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    if (this.busy || this.compacting)
      throw new PoolError(
        "session_running",
        "会话正在运行或压缩中，不能回退历史",
      );
    let result: Awaited<ReturnType<AgentSession["navigateTree"]>>;
    try {
      result = await this.session.navigateTree(targetId, { summarize: false });
    } catch (err) {
      throw new PoolError("bad_request", reason(err));
    }
    // 扩展取消了导航时什么都没变，不重建也不广播。
    if (!result.cancelled) this.rebuildProjection();
    return {
      ...(result.editorText === undefined
        ? {}
        : { editor: splitAttachmentMarkers(result.editorText) }),
      // 与 /tree 的口径一致：leaf 落在状态条目上时映射到最近的对话节点。
      leafId: conversationLeafId(this.session.sessionManager),
    };
  }

  // 按当前 leaf 分支重建快照里的全部投影；回退后历史窗口与快照必须整体换掉。
  private rebuildProjection(): void {
    this.partial = null;
    this.activeTools.clear();
    // 回退只在空闲时发生，队列通常是空的；仍按 SDK 的实际排队内容重建，避免投影与实际不一致。
    this.queue = [
      ...this.session.getSteeringMessages(),
      ...this.session.getFollowUpMessages(),
    ]
      .slice(0, MAX_QUEUE_ITEMS)
      .map((q) => cut(q, MAX_QUEUE_ITEM));
    let messages: ChatMessage[];
    try {
      messages = projectMessages(
        this.session.sessionManager.getBranch() as unknown as BranchEntry[],
      ).map(({ index: _index, ...m }) => m);
    } catch {
      // 投影失败不该让已经完成回退的请求失败：退化为空窗口，客户端可用 resync 再取。
      messages = [];
    }
    this.total = messages.length;
    this.recent.length = 0;
    this.recent.push(...messages.slice(-WINDOW));
    this.broadcast(this.snapshotFrame());
  }

  // 手动压缩：接受即返回，成功由 context.compacted 事件告知，失败由 context.compact_failed。
  // 压缩本身由 SDK 执行（会调一次模型生成摘要）。
  compact(): void {
    if (this.disposed) throw new PoolError("disposed", "会话已关闭");
    if (this.busy || this.compacting)
      throw new PoolError("session_running", "会话正在运行或压缩中");
    this.compacting = true;
    this.session
      .compact()
      .catch((err) =>
        this.emit("context.compact_failed", { message: reason(err) }),
      )
      .finally(() => {
        this.compacting = false;
        this.flushHeld();
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.prompts.cancelAll();
    this.disposed = true;
    this.goal.dispose();
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
  // 已装载会话改模型 / 档位时用它重新解析；缺省时只能等下次装载生效。
  resolver?: ModelResolver;
  store: SessionStore;
  // 会话必须属于工作区，目录清单归它所有。
  workspaces: WorkspaceStore;
  workspaceDirectories: WorkspaceDirectoryStore;
  directories: DirectoryStore;
  rules: RuleStore;
  sessionDir: string;
  // 轮次改动追踪（缺省关闭）：清单入库，diff 按需从轮次副本重建。
  changes?: TurnChangeStore;
  tracker?: ChangeTracker;
  // 弹窗超时（毫秒），缺省 30 分钟；测试用。
  promptTimeoutMs?: number;
  // 注入的审核会话工厂；缺省时 auto 档同 rules。
  reviewerFactory?: ReviewerFactory;
  // 提示词预设的选择结果（提示词 + 预设默认能力/权限）；缺省时不做预设装配（只用于测试）。
  presetView?: (choice: PresetChoice) => PresetSelection | null;
  // 两份 AGENTS.md 的读取（按会话主目录）；缺省时都没有。
  agentsFiles?: (directoryId: string) => Promise<AgentsFiles>;
  // 可以派发的 Agent 定义（名称与「何时该用我」的描述），写进「子代理与模式」内置段；缺省为空。
  agentDefs?: () => { name: string; description: string }[];
  // 模式预设的运行时视图（提示词 + 对能力的操作）；缺省时没有模式。
  modeView?: (id: string, model?: ModelRef | null) => ModeView | null;
  // 审核超时（毫秒），缺省 60 秒；测试用。
  reviewTimeoutMs?: number;
  // 环境服务与登记；缺省时所有 directory 按本机处理（只用于没有远程环境的测试）。
  envHub?: EnvHub;
  environments?: EnvironmentStore;
  // 按工作区一块隐藏的 attachment directory 与虚拟附件环境；缺省时不能收发附件。
  attachments?: AttachmentDirectories;
  // 输入图片压缩设置：请求时实时读取（保存后下一次发消息即生效）；缺省按 pi 默认。
  imageCompression?: () => ImageCompression;
  /** 浏览器下载的单个文件上限（字节），沿用设置里的「单个文件上限」：请求时实时读取；缺省不限。 */
  uploadMaxBytes?: () => number;
  /** 全局默认审批档位；缺省按「规则」。 */
  defaultTier?: () => Tier;
  /** 审核的判别准则（全局 + 工作区合成后的最终值）；每次审核现取，设置改了下一次就生效。 */
  reviewCriteria?: (workspaceId: string | null) => string;
  // 压缩实现；缺省用 pi 的 resizeImage（测试可替换，避免真实 WASM 压缩）。
  imageResize?: ImageResize;
  // 执行审计；缺省时不记录。
  audit?: AuditLog;
  // 隐私变量库；缺省时不注入清单、不做替换与遮罩。
  secrets?: SecretStore;
  // 工作区启用的变量；缺省时没有任何变量对会话可见。
  workspaceVariables?: WorkspaceVariableStore;
  // 变量引用记录；缺省时不记录（也不维护 lastUsedAt）。
  references?: ReferenceStore;
  // skill 同步与注入；缺省时会话不带库里的 skill。
  skills?: SkillRuntime;
  // MCP 工具注入；缺省时会话不带 MCP 工具。
  mcp?: McpRuntime;
  // 内置工具出厂规则矩阵的覆盖；缺省按出厂值。
  toolRules?: ToolRuleStore;
  // 内置工具描述覆盖（工具页调优）；缺省用 pi 原生描述。
  toolDescriptions?: ToolDescriptionStore;
  // 浏览器服务；缺省则没有 browser_* 工具。
  browser?: BrowserService;
  // 父子关系存储；缺省时没有 subagent（所有会话都是根）。
  subagents?: SubagentStore;
  // 团队花名册（team.md）；缺省时没有团队。
  teams?: TeamStore;
  // 用户配置的 hook（ADR-0085）；缺省时不触发任何点位。
  hooks?: HookRuntime;
  // 协作区（subagent.md §8）：子代理的共享目录；缺省时没有（测试里的池）。
  collab?: CollabArea;
  // 后台任务（subagent.md §2–§3）；缺省时会话不带 job_* 工具，bash 也不转后台。
  jobs?: JobManager;
  // 模型调用记录；缺省时不记录（只用于测试）。
  calls?: CallStore;
  // 会话配置（审批档、模型、权限禁止项）；缺省时会话只按 directory 档位与 agent 定义运行。
  configs?: SessionConfigService;
  // 会话状态（长期目标、任务清单、压缩）；缺省时只在内存里，不落库。
  states?: SessionStateStore;
  // 目标的轮数上限缺省值（设置里现取）；缺省按 50。
  goalMaxRounds?: () => number | null;
  // 会话读取的文件表；缺省时不记录。
  files?: SessionFileStore;
  // 命名流程（workflow.md §6）；缺省时 workflow_run 只认 script。
  namedWorkflows?: NamedWorkflows;
  // 灵感画布（canvas.md）：会话里的 canvas_edit 写进这里；缺省时没有这个工具。
  canvas?: CanvasService;
}

const NAME_MAX = 200;
// 送审带的近期工具输出条数上限（每条另截断 200 字符）。
const TOOL_OUTPUT_MAX = 10;

// 在渲染结果里追加（或覆盖）一个我们生成的段，并重拼完整文本。
function withSection(
  base: RenderOutput,
  tag: string,
  body: string,
): RenderOutput {
  const sections = { ...base.sections, [tag]: body };
  return {
    preamble: base.preamble,
    sections,
    text: promptText({ preamble: base.preamble, sections }),
  };
}

export class SessionPool {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly loading = new Map<string, Promise<SessionEntry | null>>();
  // 创建中预占的会话数（按 directory）：工厂完成前删除 directory 要拒绝。
  private readonly pending = new Map<string, number>();
  // 创建中的根会话按主目录预定的工作区 id：同主目录的并发创建先用同一个，先绑定的那个真正建出来。
  private readonly pendingWorkspaces = new Map<string, string>();
  private disposed = false;

  // sudo 探测缓存按环境共享给所有会话。
  private readonly sudoProbe = new SudoProbe();

  private subagentHooks: SubagentHooks | null = null;

  // 列表级推送流；没挂时列表变化不发通知。
  private feed: SessionFeed | null = null;

  // 一轮结束的旁路回调（非子代理、非用户中止）；没挂时不发。
  private turnEnded: ((id: string, error: boolean) => void) | null = null;

  private readonly binding: WorkspaceBinding;

  constructor(private readonly deps: PoolDeps) {
    this.binding = new WorkspaceBinding({
      workspaces: deps.workspaces,
      mounts: deps.workspaceDirectories,
      sessions: deps.store,
    });
  }

  // subagent 运行时与池互相引用，所以事后挂接；挂接前创建的会话没有 subagent 工具。
  attachSubagents(hooks: SubagentHooks): void {
    this.subagentHooks = hooks;
  }

  // 命名流程要按会话当前的 directory 取项目层，所以也在池建好后挂接。
  attachNamedWorkflows(named: NamedWorkflows): void {
    this.deps.namedWorkflows = named;
  }

  private localEnv = new LocalEnv();

  private envOf(ws: Directory): ExecEnv | null {
    const hub = this.deps.envHub;
    if (hub) return hub.get(ws.environmentId);
    if (ws.environmentId === ATTACHMENT_ENV_ID)
      return this.deps.attachments?.env ?? null;
    if (ws.environmentId === COLLAB_ENV_ID)
      return this.deps.collab?.env ?? null;
    return ws.environmentId === LOCAL_ENV_ID ? this.localEnv : null;
  }

  // 一个环境在本会话里的主机名：与地址解析共用同一条规则（session/address.ts 的 hostLabel）。
  private connectionName(envId: string): string | undefined {
    return this.deps.environments?.get(envId)?.name;
  }

  private hostLabelOf(envId: string, localId: string): string {
    const primary = this.entryOfDirectory(localId);
    return hostLabel(envId, {
      primaryEnvId: primary?.environmentId ?? null,
      connectionName: (id) => this.connectionName(id),
    });
  }

  /**
   * 会话的地址簿：扩展、权限、传输、上传与子代理派发共用这一处接线。
   * 地址簿本身无状态（依赖全是闭包、每次现取），所以每次现造一个，不缓存。
   */
  addressBookOf(sessionId: string): AddressBook {
    return createAddressBook({
      directories: () => this.visibleDirectories(sessionId),
      primaryEnvId: () => this.primaryDirectoryOf(sessionId).environmentId,
      current: () => {
        const entry = this.entries.get(sessionId);
        const cur = this.deps.directories.get(entry?.directoryId ?? "");
        if (!cur) throw new Error("This session has no current directory.");
        return cur;
      },
      envOf: (w) => this.envOf(w),
      connectionName: (envId) => this.connectionName(envId),
    });
  }

  // directory id → 登记行；不存在返回 null（主目录被删时按「没有主目录」算）。
  private entryOfDirectory(id: string): Directory | null {
    return id === "" ? null : (this.deps.directories.get(id) ?? null);
  }

  private viewOf(
    w: Directory,
    currentId: string,
    localId: string,
  ): DirectoryView {
    const { envHub } = this.deps;
    const local = w.environmentId === LOCAL_ENV_ID;
    const virtual =
      w.environmentId === ATTACHMENT_ENV_ID ||
      w.environmentId === COLLAB_ENV_ID;
    const s = envHub?.status(w.environmentId);
    let state = "ready";
    if (!local && !virtual) {
      if (!s) state = "environment deleted";
      else if (s.state === "connected") state = "connected";
      else if (s.state === "error")
        state = `connection failed: ${s.error ?? ""}`;
      else state = "not connected";
    }
    const host = this.hostLabelOf(w.environmentId, localId);
    return {
      id: w.id,
      name: w.name,
      path: w.path,
      ref: directoryRef(host, w.name),
      host,
      state,
      current: w.id === currentId,
      hostId: w.environmentId,
      role: w.id === localId ? "local" : "remote",
    };
  }

  /**
   * 会话的 directory 清单（有序；第 1 个只是起始目录，谁是 local 见 primaryDirectoryOf）：
   * 子会话是派发时定下的子集，根会话是所在工作区的清单；没有工作区的旧会话读作只有当前这一个。
   */
  directoryIdsOf(sessionId: string): string[] {
    const spec = this.deps.subagents?.get(sessionId)?.spec;
    const wsId = spec ? null : this.boundWorkspaceId(sessionId);
    const stored = spec
      ? spec.directoryIds
      : wsId === null
        ? []
        : this.binding.directoryIds(wsId);
    if (stored.length > 0) return stored;
    const e = this.entries.get(sessionId);
    return [
      e
        ? e.directoryId
        : this.rowDirectoryId(this.deps.store.get(sessionId)?.directoryId),
    ];
  }

  // 会话所属的工作区：池内会话改了工作区就取内存（索引行可能还没写），否则读索引。
  private boundWorkspaceId(sessionId: string): string | null {
    return (
      this.entries.get(sessionId)?.workspaceId ??
      this.binding.workspaceIdOf(sessionId)
    );
  }

  // 会话文件路径（= 工作区子目录里，旧平铺文件则为数据根）；没有文件时 null。
  private sessionFileOf(id: string): string | null {
    return findSessionFile(this.deps.sessionDir, id);
  }

  // 会话索引行还没绑工作区的旧行：按当前目录补一个，供必须「一定有工作区」的操作使用。
  private ensureWorkspace(sessionId: string): string {
    const entry = this.entries.get(sessionId);
    const bound = this.boundWorkspaceId(sessionId);
    if (bound !== null) return bound;
    const current =
      entry?.directoryId ??
      this.rowDirectoryId(this.deps.store.get(sessionId)?.directoryId);
    const ws = this.deps.directories.get(current);
    if (!ws) throw new PoolError("bad_request", "directory 不存在");
    const wsId = this.binding.ensureFor(ws, [ws.id]);
    if (entry) entry.workspaceId = wsId;
    // 还没落库的会话（刚建好、空会话）没有索引行可改。
    if (this.deps.store.get(sessionId))
      this.deps.store.setWorkspace(sessionId, wsId);
    return wsId;
  }

  // 会话绑定的 directory（用户清单里的那些；不含隐藏的 attachment directory，已删除的跳过）。
  private boundDirectories(sessionId: string): Directory[] {
    return this.directoryIdsOf(sessionId).flatMap((id) => {
      const w = this.deps.directories.get(id);
      return w ? [w] : [];
    });
  }

  // agent 可见、可切换的 directory：绑定的那些 + 存在时追加到末尾的 attachment directory，
  // 再加上协作区（虚拟主机 collab，不入库：它不是一台机器，只是一个地址空间）。
  visibleDirectories(sessionId: string): Directory[] {
    const list = this.boundDirectories(sessionId);
    const attachment = this.deps.attachments?.get(sessionId);
    const withAttachment =
      attachment && !list.some((w) => w.id === attachment.id)
        ? [...list, attachment]
        : list;
    const collab = this.collabDirectory(sessionId);
    return collab ? [...withAttachment, collab] : withAttachment;
  }

  // 协作区在这会话里充当的目录（内存对象）：这棵树已经有目录才出现（子代理启动时就建好了自己那份）。
  private collabDirectory(sessionId: string): Directory | null {
    const collab = this.deps.collab;
    if (!collab) return null;
    const rootId = this.deps.subagents?.rootOf(sessionId) ?? sessionId;
    if (!existsSync(collab.treeDir(rootId))) return null;
    return {
      id: `collab:${rootId}`,
      name: COLLAB_HOST,
      path: collab.treeDir(rootId),
      environmentId: COLLAB_ENV_ID,
      createdAt: COLLAB_CREATED_AT,
    };
  }

  private directoryViews(
    sessionId: string,
    currentId: string,
  ): DirectoryView[] {
    const localId = this.primaryDirectoryOf(sessionId).id;
    return this.visibleDirectories(sessionId).map((w) =>
      this.viewOf(w, currentId, localId),
    );
  }

  // 校验并取出一份 directory 清单：非空、不超上限、无重复、都存在。
  private resolveDirectoryList(ids: readonly string[]): Directory[] {
    if (ids.length === 0)
      throw new PoolError("bad_request", "directory 清单不能为空");
    if (ids.length > WORKSPACE_DIRECTORIES_MAX)
      throw new PoolError(
        "bad_request",
        `一个会话最多 ${WORKSPACE_DIRECTORIES_MAX} 个 directory`,
      );
    if (new Set(ids).size !== ids.length)
      throw new PoolError("bad_request", "directory 清单里有重复项");
    return ids.map((id) => {
      const w = this.deps.directories.get(id);
      if (!w) throw new PoolError("bad_request", `directory 不存在：${id}`);
      return w;
    });
  }

  /** 名下有在跑的子代理（含工作流 agent） = 执行中；与 aliveInTree 不同，不数 counted。 */
  hasRunningInTree(id: string): boolean {
    return this.deps.subagents?.hasRunningInTree(id) ?? false;
  }

  // 子代理会话（有父）：目录范围是派发时定下的，不能改。
  isSubagent(id: string): boolean {
    return this.deps.subagents?.get(id) !== undefined;
  }

  /** 会话的 directory 清单（带角色与是否当前），给接口用；隐藏的 attachment directory 不返回。 */
  directoryRows(
    sessionId: string,
  ): (Directory & { role: "local" | "remote"; current: boolean })[] | null {
    const info = this.info(sessionId);
    if (!info) return null;
    const localId = this.primaryDirectoryOf(sessionId).id;
    return this.boundDirectories(sessionId).map((w) => ({
      ...w,
      role: w.id === localId ? "local" : "remote",
      current: w.id === info.directoryId,
    }));
  }

  /**
   * 整份替换工作区的 directory 清单，并让它的每个非子代理会话各自生效：已装载的会话在下一轮尾部
   * 收到通知；所在的 directory 被移除时退回 local。没装载的会话直接落库并重建存着的提示词基线。
   * 调用方负责清单的合法性。
   */
  async setWorkspaceDirectories(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<void> {
    const before = this.deps.workspaceDirectories
      .get(workspaceId)
      .flatMap((id) => {
        const w = this.deps.directories.get(id);
        return w ? [w] : [];
      });
    this.deps.workspaceDirectories.set(workspaceId, ids);
    // 库里的会话 + 同一工作区里还没落库的池内会话。
    const targets = new Set(this.binding.sessionIds(workspaceId));
    for (const e of this.entries.values())
      if (e.workspaceId === workspaceId) targets.add(e.id);
    for (const id of targets)
      if (!this.isSubagent(id))
        await this.applyDirectoryChange(id, before, ids);
  }

  // 清单落库后单个会话的生效部分：移回 local、更新索引里的当前 directory、已装载的挂通知。
  private async applyDirectoryChange(
    sessionId: string,
    before: readonly Directory[],
    ids: readonly string[],
  ): Promise<DirectoryView[]> {
    const entry = this.entries.get(sessionId);
    const oldCurrent = entry
      ? entry.directoryId
      : this.rowDirectoryId(this.deps.store.get(sessionId)?.directoryId);
    const movedToLocal = !ids.includes(oldCurrent);
    const currentId = movedToLocal ? (ids[0] as string) : oldCurrent;
    if (movedToLocal) {
      if (entry) entry.directoryId = currentId;
      this.deps.store.updateDirectoryId(sessionId, currentId);
    }
    const all = this.directoryViews(sessionId, currentId);
    if (!entry) {
      await this.rebase(sessionId).catch(() => {});
      return all;
    }
    const known = new Set(before.map((w) => w.id));
    const localId = this.primaryDirectoryOf(sessionId).id;
    const added = this.boundDirectories(sessionId)
      .filter((w) => !known.has(w.id))
      .map((w) => this.viewOf(w, currentId, localId));
    const removed = before
      .filter((w) => !ids.includes(w.id))
      .map((w) =>
        directoryRef(this.hostLabelOf(w.environmentId, localId), w.name),
      );
    if (added.length === 0 && removed.length === 0 && !movedToLocal) return all;
    const current = all.find((v) => v.current) ?? all[0];
    if (current) {
      const text = directoriesChangedNotice({
        added,
        removed,
        current,
        movedToLocal,
      });
      entry.directoryNotice = entry.directoryNotice
        ? `${entry.directoryNotice}\n\n${text}`
        : text;
    }
    return all;
  }

  // 供 switch_directory 工具调用，失败抛 Error（信息直接给模型看）。
  // `<host>:<name>` 的解析走地址簿（唯一的解析处）；附件区地址簿已经拒了。
  private switchDirectory(sessionId: string, ref: string): DirectoryView {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error("会话已关闭");
    const hit = this.addressBookOf(sessionId).directory(ref);
    const bad = this.directoryProblem(hit);
    if (bad) throw new Error(bad);
    const localId = this.primaryDirectoryOf(sessionId).id;
    if (!this.envOf(hit))
      throw new Error(
        `Host "${this.hostLabelOf(hit.environmentId, localId)}" is not available.`,
      );
    const view = this.viewOf(hit, hit.id, localId);
    entry.directoryId = hit.id;
    entry.directoryNotice = switchNotice(view);
    // 运行结束时索引会按条目上的 id 写入；这里同步一次，避免中途崩溃后回到旧 directory。
    this.deps.store.updateDirectoryId(sessionId, hit.id);
    return view;
  }

  /**
   * 用户内容（文字 + 附件）的统一解析入口：附件区取所属工作区的那块，校验、识别 mime、读图压缩都在
   * session/user-content.ts 里。任一附件越界、不存在或图片但模型不支持图片输入都整体拒绝。
   */
  async resolveContent(
    id: string,
    text: string,
    paths: readonly string[],
  ): Promise<ResolvedContent> {
    const entry = this.entries.get(id);
    if (!entry) throw new PoolError("bad_request", "会话不存在");
    try {
      return await resolveUserContent(
        {
          attachmentDir: () => {
            const ws = this.deps.attachments?.get(id);
            const env = ws ? this.envOf(ws) : null;
            return ws && env ? { env, path: ws.path } : null;
          },
          supportsImages: () => entry.supportsImages,
          compression: () =>
            this.deps.imageCompression?.() ?? PI_IMAGE_COMPRESSION,
          resize: this.deps.imageResize,
        },
        text,
        paths,
      );
    } catch (err) {
      if (err instanceof ContentError)
        throw new PoolError("bad_request", err.message);
      throw err;
    }
  }

  /**
   * 用户发消息：客户端只带附件路径引用，附件交给 resolveContent 解析后随原文一起发给会话。
   * 任一附件被拒绝就整体不发消息。
   */
  async sendUserMessage(
    id: string,
    text: string,
    paths: readonly string[],
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new PoolError("bad_request", "会话不存在");
    // 没有附件：保持原来的快路径，不碰附件区。
    if (paths.length === 0) {
      entry.send(text);
      return;
    }
    const c = await this.resolveContent(id, text, paths);
    entry.send(c.text, c.images);
  }

  // 会话生效的能力 id（tool:/skill:/mcp:）。创建时用调用方给的配置，之后读已存的配置，
  // 都没有就是 null —— 不限制。
  private capabilitiesOf(id: string, config?: ConfigBody): string[] | null {
    if (config) return config.capabilities;
    return this.deps.configs?.stored(id)?.capabilities ?? null;
  }

  // 能力 id 里某一类的名字；null（不限制）对技能与 MCP 等于「只用目录已分发的」。
  private capabilityNamesOf(
    id: string,
    kind: "skill" | "mcp",
    config?: ConfigBody,
  ): string[] {
    const caps = this.capabilitiesOf(id, config);
    if (caps === null) return [];
    const prefix = kind === "skill" ? "skill:" : "mcp:";
    return caps
      .filter((c) => c.startsWith(prefix))
      .map((c) => c.slice(prefix.length));
  }

  // 会话的工具白名单：能力为 null 表示全部内置工具（默认关闭的单元除外）；空数组表示只剩常驻工具。
  // 子会话不装 switch_directory（只在一个目录里工作），能力里点名了也不给：能起，只是少这个工具。
  private toolNamesOf(id: string, config?: ConfigBody): string[] {
    const caps = this.capabilitiesOf(id, config);
    const names =
      caps === null ? unlimitedTools(TOOL_NAMES) : toolsOfCaps(caps);
    return this.isSubagent(id)
      ? names.filter((t) => t !== "switch_directory")
      : names;
  }

  // 同步会话要用的 skill；不抛出，失败体现在 SkillRuntime 的 report 里。
  private async prepareSkills(
    id: string,
    ws: Directory,
    workspaceId: string | null,
    config?: ConfigBody,
  ): Promise<SessionSkill[] | undefined> {
    const env = this.envOf(ws);
    if (!this.deps.skills || !env) return undefined;
    return (
      await this.deps.skills.prepare(
        id,
        ws,
        env,
        this.capabilityNamesOf(id, "skill", config),
        workspaceId,
      )
    ).skills;
  }

  // 会话要用的 MCP 工具缓存（预设里勾选的 ∪ 全局 ∪ workspace 分配），只在 pi 连上之前顶用；连不上的 server 只是没有工具。
  private async prepareMcp(
    id: string,
    workspaceId: string | null,
    config?: ConfigBody,
  ): Promise<McpToolDef[]> {
    const mcp = this.deps.mcp;
    if (!mcp) return [];
    return mcp.prepare(
      id,
      workspaceId,
      this.capabilityNamesOf(id, "mcp", config),
    );
  }

  // 交给 pi 的 MCP 装配：连接与工具注册由 pi 负责，我们只提供登记内容。登记内容每次现取；
  // stdio 服务起在逻辑 local 目录所在的主机上，环境每次建连现取（重新激活会换新对象）。
  private mcpSetup(
    id: string,
    home: Directory,
    workspaceId: string | null,
    config?: ConfigBody,
  ): McpSetup | null {
    const mcp = this.deps.mcp;
    if (!mcp) return null;
    const setup: McpSetup = {
      // 创建那一刻配置还没落库，用传进来的；之后读已存的
      servers: () =>
        mcp.servers(
          workspaceId,
          this.capabilityNamesOf(
            id,
            "mcp",
            this.deps.configs?.stored(id) ? undefined : config,
          ),
        ),
      config: () =>
        piMcpConfig(
          setup.servers(),
          (secretId) => this.deps.secrets?.reveal(secretId) ?? null,
        ),
      home: { env: () => this.envOf(home), cwd: home.path },
      status: new McpSessionStatus(),
      loaded: { sig: null, names: new Set<string>() },
    };
    this.mcpSetups.set(id, { setup, homeId: home.id });
    return setup;
  }

  // 发消息前：登记 / 勾选 / 变量与 pi 读走的那份不一样（比如会话开着的时候新增了 MCP），先重连。
  // 只重连不重建前缀，新增的工具由下一次运行前的状态比较用尾部通知告诉模型。
  private async syncMcp(e: SessionEntry): Promise<void> {
    const m = this.mcpSetups.get(e.id);
    if (!m || m.setup.loaded.sig === null) return;
    if (configSig(m.setup.config()) === m.setup.loaded.sig) return;
    m.setup.status.clear();
    await e.reconnect();
  }

  // 技能：记下会话此刻生效的（已同步）与指纹。创建时工作区还没绑，id 由调用方给。
  private trackSkills(
    id: string,
    skills: SessionSkill[] | undefined,
    workspaceId: string | null,
    config?: ConfigBody,
  ): void {
    const rt = this.deps.skills;
    if (!rt || !skills) return;
    this.skillSets.set(id, skills);
    this.skillSigs.set(
      id,
      rt.signature(this.capabilityNamesOf(id, "skill", config), workspaceId),
    );
  }

  // 运行前调用：技能集合（全局 ∪ Agent 基线 ∪ 工作区勾选）变了就同步到当前环境，之后的状态映射才带新技能。
  async refreshSkills(id: string): Promise<void> {
    const rt = this.deps.skills;
    const entry = this.entries.get(id);
    if (!rt || !entry) return;
    const workspaceId = this.workspaceIdOf(id);
    const sig = rt.signature(this.capabilityNamesOf(id, "skill"), workspaceId);
    if (sig === this.skillSigs.get(id)) return;
    const ws = this.deps.directories.get(entry.directoryId);
    if (!ws) return;
    const skills = await this.prepareSkills(id, ws, workspaceId);
    if (!skills) return;
    this.skillSets.set(id, skills);
    this.skillSigs.set(id, sig);
    entry.noteSkills(skills);
  }

  // 切换后该环境新增的 skill 与同步问题，拼在切换通知后面。
  private async switchSkillNotice(entry: SessionEntry): Promise<string> {
    const ws = this.deps.directories.get(entry.directoryId);
    const env = ws && this.envOf(ws);
    if (!this.deps.skills || !ws || !env) return "";
    const { report, skills } = await this.deps.skills.prepare(
      entry.id,
      ws,
      env,
      this.capabilityNamesOf(entry.id, "skill"),
      this.workspaceIdOf(entry.id),
    );
    const text = skillNotice(report.items, entry.listedSkills);
    entry.noteSkills(skills);
    this.skillSets.set(entry.id, skills);
    return text === "" ? "" : `\n${text}`;
  }

  // 触发只观察的点位：不等结果，失败不影响会话。
  private observe(
    point: PointId,
    sessionId: string,
    ws: Directory,
    data: Record<string, unknown>,
  ): void {
    void this.deps.hooks
      ?.fire(point, hookCtx(ws, sessionId), data)
      .catch(() => {});
  }

  get canCreate(): boolean {
    return this.deps.factory !== null;
  }

  // 插件的 UI 通道：工厂拿不到会话条目（创建时还没有），所以按 id 惰性取。
  private uiFor(id: string): ExtensionUIContext {
    return makeExtensionUiContext({
      ask: (spec) =>
        this.entries.get(id)?.ask(spec) ??
        Promise.resolve({ outcome: "cancelled" as const }),
      publish: (type, data) => this.entries.get(id)?.publish(type, data),
    });
  }

  // 每个会话的送达计算（启用工具集、状态映射、拦截）；装配扩展时登记。
  private readonly deliveries = new Map<string, Delivery>();

  // 每个会话的 MCP 装配（登记内容现取，状态簿给 /mcp 弹窗）。
  private readonly mcpSetups = new Map<
    string,
    { setup: McpSetup; homeId: string }
  >();

  // 每个会话此刻生效的技能（已同步到当前所在环境）与对应的指纹；运行前指纹变了就重新同步。
  private readonly skillSets = new Map<string, SessionSkill[]>();
  private readonly skillSigs = new Map<string, string>();

  /** 会话此刻启用的工具名（含框架工具）；没装配过返回空。 */
  enabledTools(id: string): string[] {
    return this.deliveries.get(id)?.mapping().tools ?? [];
  }

  // 提示词送达需要的会话信息：基线工具、当前模式、可切换的模式数、我们生成的系统段。
  private deliveryHost(): DeliveryHost {
    return {
      baselineTools: (id, mcpTools) => [
        ...new Set([...this.toolNamesOf(id), ...mcpTools.map((d) => d.name)]),
      ],
      activeMode: (id) => {
        const modeId = this.entries.get(id)?.activeModeId;
        return modeId
          ? (this.deps.modeView?.(modeId, this.modelRefOf(id)) ?? null)
          : null;
      },
      modeCount: (id) => this.modeChoices(id).length,
      canPost: (id) =>
        this.deps.teams?.get(id) !== undefined ||
        this.deps.teams?.member(id) !== undefined,
      promptSlots: (id) => promptSlotsOf(this.liveRender(id)),
      skills: (id) => this.skillSets.get(id) ?? [],
      refreshSkills: (id) => this.refreshSkills(id),
    };
  }

  // 会话此刻按预设渲染出的提示词（预设是活引用：编辑后下一次运行的比较就会发现）；
  // 渲染不出来时退回创建 / 装载时的那一份。
  private liveRender(id: string): RenderOutput | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const base =
      this.renderPromptFor({
        agentPresetId: e.promptPresetId,
        model: this.modelRefOf(id),
        agentsFiles: e.agentsFiles,
      }) ?? e.promptRender;
    return base
      ? this.withDelegation(id, this.withEnvironment(id, base))
      : null;
  }

  // 追加「环境信息」内置段：会话创建时间 + 涉及的每台主机的系统事实与可用状态（environment.ts）。
  // 主机接入 / 移除 / 被断开会改这段的文本，下一次运行前的状态比较会发现并通知模型。
  private withEnvironment(id: string, base: RenderOutput): RenderOutput {
    const { envHub } = this.deps;
    const hosts = new Map<string, EnvironmentHost>();
    for (const v of this.directoryViews(id, "")) {
      // 两个虚拟主机（附件区、协作区）不是机器；上传附件或建协作区也不该让这一段变化
      if (v.hostId === ATTACHMENT_ENV_ID || v.hostId === COLLAB_ENV_ID)
        continue;
      const seen = hosts.get(v.hostId);
      if (seen) {
        seen.directories.push({ ref: v.ref, path: v.path });
        continue;
      }
      const local = v.hostId === LOCAL_ENV_ID;
      const probed = local ? null : (envHub?.factsOf(v.hostId) ?? null);
      hosts.set(v.hostId, {
        name: v.host,
        facts: local
          ? localFacts()
          : probed === null
            ? null
            : probeFacts(probed),
        disconnected: !local && (envHub?.isPaused(v.hostId) ?? false),
        directories: [{ ref: v.ref, path: v.path }],
      });
    }
    const text = environmentSection({
      startedAt: this.entries.get(id)?.createdAt ?? null,
      hosts: [...hosts.values()],
    });
    // <cwd>：pi 无条件产出一段裸路径，改成主目录的引用。切换目录不改它（切换由通知负责），
    // 否则每次切换都会改这段文本、多一条状态通知。
    const sub = this.isSubagent(id);
    const start = sub
      ? (this.deps.directories.get(this.directoryIdsOf(id)[0] ?? "") ??
        this.primaryDirectoryOf(id))
      : this.primaryDirectoryOf(id);
    return withSection(
      text === null ? base : withSection(base, ENVIRONMENT_TAG, text),
      CWD_TAG,
      cwdSection(
        { ref: this.addressBookOf(id).refOf(start), path: start.path },
        { sub },
      ),
    );
  }

  // 追加「子代理与模式」内置段：我们生成、用户不可改，随会话此刻有没有相关工具而定。
  private withDelegation(id: string, base: RenderOutput): RenderOutput {
    const text = delegationSection({
      canSpawn: this.toolNamesOf(id).includes("spawn_subagent"),
      canTeam: this.toolNamesOf(id).includes("team_create"),
      canWorkflow: this.toolNamesOf(id).includes("workflow_run"),
      isSubagent: this.isSubagent(id),
      modeCount: this.modeChoices(id).length,
      agents: this.deps.agentDefs?.() ?? [],
    });
    return text === null ? base : withSection(base, DELEGATION_TAG, text);
  }

  /** 会话可切换的模式（清单里已被删除的预设自动忽略）。 */
  modeChoices(id: string): { id: string; name: string }[] {
    const ids = this.entries.get(id)?.modePresetIds ?? [];
    return ids.flatMap((m) => {
      const v = this.deps.modeView?.(m);
      return v ? [{ id: v.id, name: v.name }] : [];
    });
  }

  /** 切换会话的当前模式（null = 退出）。只能切到清单里的模式；下一次运行由状态通知带上。 */
  setActiveMode(id: string, modeId: string | null): void {
    const e = this.entries.get(id);
    if (!e) throw new PoolError("bad_request", "会话未加载");
    if (modeId !== null && !this.modeChoices(id).some((m) => m.id === modeId))
      throw new PoolError("bad_request", "该模式不在会话的可切换清单里");
    e.activeModeId = modeId;
    this.deps.store.setActiveMode(id, modeId);
  }

  /** 改会话的可切换模式清单；当前模式被移出清单则一并退出。 */
  setModePresetIds(id: string, ids: string[]): void {
    const e = this.entries.get(id);
    if (!e) throw new PoolError("bad_request", "会话未加载");
    e.modePresetIds = ids;
    this.deps.store.setModePresetIds(id, ids);
    if (e.activeModeId !== null && !ids.includes(e.activeModeId))
      this.setActiveMode(id, null);
  }

  // 装配扩展要用的池内成员；每次现场组一个，subagentHooks 是事后挂接的，不能在构造时取。
  private extensionHost(): ExtensionHost {
    return {
      deps: this.deps,
      entries: this.entries,
      sudoProbe: this.sudoProbe,
      subagentHooks: () => this.subagentHooks,
      observe: (point, sessionId, ws, data) =>
        this.observe(point, sessionId, ws, data),
      envOf: (ws) => this.envOf(ws),
      visibleDirectories: (sessionId) => this.visibleDirectories(sessionId),
      workspaceIdOf: (sessionId) => this.workspaceIdOf(sessionId),
      liveRender: (id) => this.liveRender(id),
      directoryViews: (sessionId, currentId) =>
        this.directoryViews(sessionId, currentId),
      addressBookOf: (sessionId) => this.addressBookOf(sessionId),
      switchDirectory: (sessionId, ref) => this.switchDirectory(sessionId, ref),
      switchSkillNotice: (entry) => this.switchSkillNotice(entry),
      sessionTier: (id) => this.sessionTier(id),
      toolDescriptionOverrides: () => this.toolDescriptionOverrides(),
      delivery: this.deliveryHost(),
      bindDelivery: (id, d) => this.deliveries.set(id, d),
      modeChoices: (id) => this.modeChoices(id),
      setActiveMode: (id, modeId) => this.setActiveMode(id, modeId),
      permissionCtxOf: (id, ws, spec) => this.permissionCtxOf(id, ws, spec),
      primaryDirectory: (sessionId) => this.primaryDirectoryOf(sessionId),
      connectionName: (envId) => this.connectionName(envId),
      effectiveTier: (id, spec) => this.effectiveTier(id, spec),
    };
  }

  // 每会话当前轮次号：轮初取一次，轮末沿用它，避免中间算不一致
  private readonly turns = new Map<string, number>();

  /** 某个 directory 的环境与根目录；追踪改动与团队对比都按它取 */
  directoryContext(directoryId: string): { env: ExecEnv; root: string } | null {
    const ws = this.deps.directories.get(directoryId);
    if (!ws) return null;
    const env = this.envOf(ws);
    return env ? { env, root: ws.path } : null;
  }

  /** 会话当前所在 directory 的环境与根目录。 */
  private changeCtx(e: SessionEntry): { env: ExecEnv; root: string } | null {
    return this.directoryContext(e.directoryId);
  }

  private beginChanges(e: SessionEntry): void {
    const ctx = this.changeCtx(e);
    if (!ctx || !this.deps.tracker || !this.deps.changes) return;
    const turn = this.deps.changes.nextTurn(e.id);
    this.turns.set(e.id, turn);
    void this.deps.tracker
      .begin(`${e.id}:${turn}`, ctx.env, ctx.root)
      .catch(() => {});
  }

  private noteChange(
    e: SessionEntry,
    tool: { name: string; args: unknown },
  ): void {
    const tracker = this.deps.tracker;
    if (!tracker) return;
    const turn = this.turns.get(e.id);
    const ctx = this.changeCtx(e);
    if (turn === undefined || !ctx) return;
    // 只有写文件类工具才有「写前」这个概念；edit/write 的参数里都带 path
    if (!/^(write|edit)$/i.test(tool.name)) return;
    const p = (tool.args as { path?: unknown } | null)?.path;
    if (typeof p !== "string" || p === "") return;
    const abs = p.startsWith("/") ? p : `${ctx.root}/${p}`;
    void tracker
      .noteWrite(`${e.id}:${turn}`, ctx.env, ctx.root, abs)
      .catch(() => {});
    // 团队整体改动（team_diff）：lead 与成员在团队目录里的写入都记进团队的那份
    const team = this.deps.teams;
    const lead = team?.leadOf(e.id);
    if (lead !== undefined && team?.get(lead)?.directoryId === e.directoryId)
      void tracker
        .noteWrite(teamChangeKey(lead), ctx.env, ctx.root, abs)
        .catch(() => {});
  }

  private async finishChanges(e: SessionEntry): Promise<void> {
    const tracker = this.deps.tracker;
    const store = this.deps.changes;
    if (!tracker || !store) return;
    const turn = this.turns.get(e.id);
    const ctx = this.changeCtx(e);
    this.turns.delete(e.id);
    if (turn === undefined || !ctx) return;
    try {
      const anchorTs = e.lastAssistantTs();
      const set = await tracker.finish(`${e.id}:${turn}`, ctx.env);
      store.save(e.id, turn, set, anchorTs);
      // 清单落库后才推这一帧：收尾是 run.ended 之后异步做的，前端那时拉清单还没写进来，
      // 只靠「空闲时拉一次」会导致本轮卡片要刷新页面才出现。
      if (set.files.length > 0)
        e.publish("turn.changes", {
          turn,
          mode: set.mode,
          total: set.total,
          anchorTs,
        });
    } catch {
      // 追踪失败不能影响会话持久化
    }
  }

  private entryOptions(): Pick<
    EntryOptions,
    | "onRunEnded"
    | "onRunFailed"
    | "onRunStart"
    | "onPromptsChanged"
    | "onToolStart"
    | "onSettled"
    | "onCompacted"
    | "promptTimeoutMs"
    | "onAudit"
    | "onStop"
    | "takeNotices"
    | "beforeSend"
    | "states"
    | "calls"
    | "files"
    | "hostOf"
    | "goalMaxRounds"
    | "runningJobs"
    | "hasRunningInTree"
  > {
    const { audit, directories } = this.deps;
    return {
      onRunEnded: (e, outcome) => {
        try {
          this.persist(e);
          this.syncIfDue(e);
        } finally {
          this.subagentHooks?.runEnded(e, outcome);
          e.goal.runEnded(outcome);
          void this.finishChanges(e);
        }
        this.markEnded(e.id, outcome);
        this.feed?.touch(e.id);
      },
      onRunFailed: (e, error) => {
        this.subagentHooks?.runEnded(e, { aborted: false, error, text: "" });
        e.goal.runEnded({ aborted: false, error, text: "" });
        this.markEnded(e.id, { aborted: false, error, text: "" });
        this.feed?.touch(e.id);
      },
      onRunStart: (e) => {
        if (this.deps.changes && this.deps.tracker) this.beginChanges(e);
        e.goal.runStarted();
        this.feed?.touch(e.id);
      },
      onPromptsChanged: (e) => this.feed?.touch(e.id),
      onToolStart: (e, tool) => {
        if (this.deps.changes && this.deps.tracker) this.noteChange(e, tool);
        this.subagentHooks?.toolStarted(e.id, tool);
        e.goal.toolStarted();
      },
      onSettled: (e) => {
        this.syncIfDue(e);
        e.goal.settled();
      },
      onStop: (e) => {
        // 目标先暂停再中断：停下来的目标不会被自动拉起。
        e.goal.userStopped();
        // 用户停止根 agent 不停它的后台任务（subagent.md S5）；停止子代理则连它名下的一并停。
        if (!this.isSubagent(e.id)) return;
        this.subagentHooks?.userStopped(e.id);
        // 子代理自己被停：名下的任务一并停，不回调给正在被停的它。
        void this.deps.jobs?.stopOwned(e.id, "owner");
      },
      takeNotices: (e) => this.deps.jobs?.notices(e.id) ?? [],
      beforeSend: (e) => this.syncMcp(e),
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
                  directories.get(e.directoryId)?.environmentId ?? null,
              }),
          }
        : {}),
      ...(this.deps.promptTimeoutMs === undefined
        ? {}
        : { promptTimeoutMs: this.deps.promptTimeoutMs }),
      ...(this.deps.states ? { states: this.deps.states } : {}),
      ...(this.deps.calls ? { calls: this.deps.calls } : {}),
      ...(this.deps.files ? { files: this.deps.files } : {}),
      ...(this.deps.goalMaxRounds
        ? { goalMaxRounds: this.deps.goalMaxRounds }
        : {}),
      runningJobs: (id) =>
        this.deps.jobs?.list(id).some((r) => r.state === "running") ?? false,
      hasRunningInTree: (id) => this.hasRunningInTree(id),
      hostOf: (e) =>
        directories.get(e.directoryId)?.environmentId ?? LOCAL_ENV_ID,
    };
  }

  // 每个 Agent 定义被多少会话引用：已进索引的（含已归档），加上刚建好还没跑过、只在池里的。
  agentRefCounts(): Map<string, number> {
    const counts = this.deps.store.agentRefCounts();
    for (const e of this.entries.values()) {
      if (e.promptPresetId === null || this.deps.store.get(e.id)) continue;
      counts.set(e.promptPresetId, (counts.get(e.promptPresetId) ?? 0) + 1);
    }
    return counts;
  }

  // 会话一旦有了 JSONL 就进索引；之后每次运行结束更新 updated_at 与名称缓存。
  private persist(e: SessionEntry): void {
    if (!findSessionFile(this.deps.sessionDir, e.id)) return;
    this.deps.store.upsert(this.indexRow(e));
  }

  private indexRow(e: SessionEntry): IndexRow {
    return {
      id: e.id,
      name: e.name,
      preview: e.preview,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      directoryId: e.directoryId,
      workspaceId: e.workspaceId,
      promptText: e.promptText,
      promptPresetId: e.promptPresetId,
      modePresetIds: e.modePresetIds,
      activeModeId: e.activeModeId,
      seqNo: e.seqNo,
    };
  }

  // 记下目录里内置工具此刻的原始描述，调优页据此显示模型实际收到的原文（子会话与父会话用同一批工具，不重复记）
  private noteToolOriginals(session: AgentSession): void {
    const own = new Set<string>([
      ...TOOL_NAMES,
      ...FRAMEWORK_TOOLS.map((t) => t.name),
    ]);
    this.deps.toolDescriptions?.recordOriginals(
      session.getAllTools().filter((t) => own.has(t.name)),
    );
  }

  // 工具描述覆盖：工具页改过的描述，建/装载会话时合并进 pi 的工具声明。
  private toolDescriptionOverrides(): Record<string, string> | undefined {
    const rows = this.deps.toolDescriptions?.all() ?? [];
    return rows.length > 0
      ? Object.fromEntries(rows.map((r) => [r.name, r.description]))
      : undefined;
  }

  // 提示词基线里的两份 AGENTS.md：按会话主目录读，读不到就是没有。
  private async agentsFilesOf(directoryId: string): Promise<AgentsFiles> {
    return (await this.deps.agentsFiles?.(directoryId)) ?? NO_AGENTS_FILES;
  }

  // 会话提示词：全部来自预设（agent 预设 + 全局附加提示词）。
  private renderPromptFor(choice: PresetChoice): RenderOutput | null {
    const view = this.deps.presetView?.(choice);
    return view ? renderOutput(view.prompt) : null;
  }

  private factoryAgent(
    id: string,
    initial: string,
    initialRender: RenderOutput | null,
    tools: string[],
    config?: ConfigBody,
  ): FactoryAgent {
    return {
      tools,
      promptText: () => this.entries.get(id)?.promptText ?? initial,
      identity: () =>
        this.entries.get(id)?.promptRender?.preamble ??
        initialRender?.preamble ??
        "",
      ...this.modelChoice(id, config),
    };
  }

  // 提示词分组条件的输入：配置里显式选的模型，否则全局默认；都没有就是 null（只有「否则」成立）。
  private modelRefFor(m: ConfigModel | undefined): ModelRef | null {
    const e = explicitModel(m);
    if (e) return { provider: e.modelId, model: e.model };
    const d = this.deps.resolver?.default();
    return d ? { provider: d.provider, model: d.model } : null;
  }

  /** 会话此刻用的模型：配置里显式选的，否则全局默认 */
  modelRefOf(id: string): ModelRef | null {
    return this.modelRefFor(this.deps.configs?.stored(id)?.model);
  }

  // 会话该用哪个模型 / 档位：会话配置 > 交给 pi 的全局默认。
  private modelChoice(
    id: string,
    config?: ConfigBody,
  ): Pick<FactoryAgent, "modelId" | "modelName" | "thinkingLevel"> {
    const picked = config
      ? explicitModel(config.model)
      : (this.deps.configs?.modelOf(id) ?? null);
    return {
      modelId: picked?.modelId ?? null,
      modelName: picked?.model ?? null,
      thinkingLevel: picked?.thinkingLevel ?? null,
    };
  }

  // 运行中攒下的提示词重建（压缩）与模型变更，在会话真正空闲时补上；紧接着的发送会等它们做完。
  private syncIfDue(e: SessionEntry): void {
    if (e.busy) return;
    if (e.rebasePending) e.holdSend(this.rebase(e.id));
    if (e.modelSyncPending) {
      e.modelSyncPending = false;
      e.holdSend(this.syncModel(e.id));
    }
  }

  /**
   * 把已存的模型 / 档位应用到已装载的会话。true = 已生效（或会话未装载，装载时自然读到）；
   * false = 没能立即生效：运行中的等本轮结束再换；旧登记里的模型（独立 runtime，SDK 认不得）要等下次装载。
   */
  async syncModel(id: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e) return true;
    const { resolver } = this.deps;
    if (!resolver) return false;
    if (e.busy) {
      e.modelSyncPending = true;
      return false;
    }
    const c = this.modelChoice(id);
    try {
      const built = await resolver.build(c.modelId, c.modelName);
      if (!built) return false;
      // 解析期间可能开始了新一轮运行。
      if (e.busy) {
        e.modelSyncPending = true;
        return false;
      }
      e.modelSyncPending = false;
      await e.applyModel(
        built.model,
        c.thinkingLevel ?? resolver.default()?.thinking ?? null,
      );
      void this.rebase(id).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // 立即同步：按当前块内容重建提示词基线。运行中的会话不动（返回 busy），压缩后会自动重建。
  async rebase(
    id: string,
    reload = true,
  ): Promise<"synced" | "unchanged" | "busy" | "not_found"> {
    const { store } = this.deps;
    const entry = this.entries.get(id);
    const row = store.get(id);
    if (!entry && !row) return "not_found";
    if (entry?.busy) return "busy";
    // 重建基线时重读两份文件：运行中改过的约定下一次重建才带上（prompt.md S2）。
    const agentsFiles = await this.agentsFilesOf(
      this.directoryIdsOf(id)[0] ?? "",
    );
    const render = this.renderPromptFor({
      agentPresetId: entry?.promptPresetId ?? row?.promptPresetId ?? null,
      model: this.modelRefOf(id),
      agentsFiles,
    });
    if (!render) return "unchanged";
    const text = render.text;
    // 拼装期间可能开始了新一轮运行。
    if (entry?.busy) return "busy";
    if (entry) entry.rebasePending = false;
    if (text === (entry ? entry.promptText : row?.promptText))
      return "unchanged";
    if (entry) {
      entry.promptText = text;
      entry.promptRender = render;
      entry.agentsFiles = agentsFiles;
      if (reload) await entry.reloadPrompt();
    }
    if (store.get(id)) store.setPromptText(id, text);
    return "synced";
  }

  /**
   * 刷新上下文（原地）：重读两份 AGENTS.md、重新同步技能、重连 MCP、重抓主机的登录环境，并重建前缀（缓存失效）。
   * 历史、配置、模式都不动，也不新建会话。用户装好依赖、改了登记 / 勾选 / 约定文件之后用，输入框的 `/reload` 与左轨的「刷新上下文」都走它。
   * 运行中、正在压缩的会话不动（busy）；还没加载进内存的先加载。
   */
  async refreshContext(
    id: string,
  ): Promise<"refreshed" | "busy" | "not_found"> {
    const entry = await this.acquire(id);
    if (!entry) return "not_found";
    if (entry.busy || entry.isCompacting) return "busy";
    // 先把约定文件的新内容放进条目（liveRender 取它），重建前缀时才带上；这里不单独重载，下面一次做完
    if ((await this.rebase(id, false)) === "busy") return "busy";
    this.mcpSetups.get(id)?.setup.status.clear();
    await this.refreshSkills(id);
    // 依赖多半就是刚装的，PATH 变了：涉及的每台主机重抓登录环境
    const envs = new Set(this.visibleDirectories(id).map((d) => this.envOf(d)));
    await Promise.all(
      [...envs].map((e) => e?.refreshLoginEnv?.().catch(() => {})),
    );
    await entry.reloadPrompt();
    return "refreshed";
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

  // 索引行的 directory：空值读作默认（最早登记）的 directory。
  private rowDirectoryId(directoryId: string | null | undefined): string {
    return directoryId ?? this.deps.directories.getDefault()?.id ?? "";
  }

  // 登记路径此刻是否仍指向登记时的那个目录：消失、或被换成符号链接指向别处（realpath 与登记值不一致）都不能用。
  private directoryProblem(ws: Directory): string | null {
    // 远程目录不在本机，预检无从谈起；不存在会在工具调用时如实报错。
    if (ws.environmentId !== LOCAL_ENV_ID) return null;
    const r = resolveDirectory(ws.path);
    if (!r.ok) return `Directory "${ws.path}" no longer exists.`;
    if (r.path !== ws.path)
      return `Directory "${ws.path}" now resolves to "${r.path}"; re-register it with the current path.`;
    return null;
  }

  // 创建工作区绑定：子会话跟父同属一个；根会话要么加入指定工作区，要么按主目录与 roster 取（或新建）一个。
  // 分两步：工厂建文件前就要知道落点目录，所以这里先只解析出工作区 id（新建时用给定 id），
  // 工厂成功后才真正建（bind），失败时不留空工作区。
  private resolveWorkspaceAtCreate(
    wanted: { workspaceId?: string; parentId?: string },
    primary: Directory,
    roster: readonly string[],
  ): { id: string; bind: () => string } {
    const { workspaceId, parentId } = wanted;
    const existing = (id: string) => ({ id, bind: () => id });
    if (parentId !== undefined)
      return existing(
        this.binding.workspaceIdOf(parentId) ?? this.ensureWorkspace(parentId),
      );
    if (workspaceId !== undefined) return existing(workspaceId);
    const owner = this.binding.ownerOf(primary.id);
    if (owner !== null) return existing(owner);
    // 同主目录的创建共用一个预约 id（并发的、以及失败后重试的，都沿用它，不会各留一个空目录）。
    // bind 对已建出的工作区幂等，所以谁先绑定谁建；建出来之后预约就不再需要。
    const id = this.pendingWorkspaces.get(primary.id) ?? uuidv7();
    this.pendingWorkspaces.set(primary.id, id);
    return {
      id,
      bind: () => {
        const ws = this.binding.ensureFor(primary, roster, id);
        this.pendingWorkspaces.delete(primary.id);
        return ws;
      },
    };
  }

  async create(
    opts: {
      // 加入已有工作区：它的目录清单决定会话的 roster；不存在或清单为空都拒绝。
      workspaceId?: string;
      directoryId?: string;
      // 会话的完整 directory 清单（第 1 个是 local）；给了就以它为准，directoryId 须与第 1 个一致。
      directoryIds?: string[];
      child?: ChildInit;
      // 已校验的会话配置（模型 / 能力 / 权限档位）；缺省按预设默认值合成。
      config?: ConfigBody;
      // 创建时选择的 agent 预设（提示词来源）；缺省用默认预设。
      promptPresetId?: string;
      // 创建时多选的应用模式预设（按选择顺序）。
      modePresetIds?: string[];
      // 子代理 fork：会话文件已由 forkFile 截好，直接用它（id 要与文件一致）。
      resume?: { id: string; file: string };
      // 子代理 fresh：沿用父的冻结物。
      seedHead?: HeadData;
    } = {},
  ): Promise<SessionInfo> {
    if (this.disposed) throw new PoolError("disposed", "会话池已关闭");
    const factory = this.deps.factory;
    if (!factory) throw new PoolError("load_failed", "没有会话后端");
    // 子代理会话必须与父同属一个工作区，所以只认根会话给的 workspaceId。
    const requested = opts.child
      ? { parentId: opts.child.parentId }
      : { workspaceId: opts.workspaceId };
    const boundWorkspace =
      requested.workspaceId === undefined
        ? undefined
        : this.deps.workspaces.get(requested.workspaceId);
    if (requested.workspaceId !== undefined && !boundWorkspace)
      throw new PoolError("bad_request", "工作区不存在");
    const boundRoster = boundWorkspace
      ? this.binding.directoryIds(boundWorkspace.id)
      : [];
    if (boundWorkspace && boundRoster.length === 0)
      throw new PoolError("bad_request", "工作区的目录清单为空");
    if (
      opts.directoryIds &&
      opts.directoryId !== undefined &&
      opts.directoryIds[0] !== opts.directoryId
    )
      throw new PoolError(
        "bad_request",
        "directoryId 必须是 directoryIds 的第 1 个",
      );
    if (boundWorkspace) {
      const primaryId = boundRoster[0] as string;
      for (const given of [opts.directoryId, opts.directoryIds?.[0]])
        if (given !== undefined && given !== primaryId)
          throw new PoolError(
            "bad_request",
            "目录清单的第 1 个必须是工作区的主目录",
          );
    }
    const firstId =
      boundRoster[0] ?? opts.directoryIds?.[0] ?? opts.directoryId;
    const ws =
      firstId === undefined
        ? this.deps.directories.getDefault()
        : this.deps.directories.get(firstId);
    if (!ws) throw new PoolError("bad_request", "directory 不存在");
    const bad = this.directoryProblem(ws);
    if (bad) throw new PoolError("bad_request", bad);
    // 会话挂的 directory：加入工作区时取它的清单；自己给的清单先校验；子会话是派发时定下的子集。
    if (opts.directoryIds) this.resolveDirectoryList(opts.directoryIds);
    const rosterIds = boundWorkspace
      ? boundRoster
      : (opts.directoryIds ?? opts.child?.spec.directoryIds ?? [ws.id]);
    const promptPresetId = opts.promptPresetId ?? null;
    const modePresetIds = opts.modePresetIds ?? [];
    const agentsFiles = await this.agentsFilesOf(ws.id);
    const view =
      this.deps.presetView?.({
        agentPresetId: promptPresetId,
        model: this.modelRefFor(opts.config?.model),
        agentsFiles,
      }) ?? null;
    // 没给配置时按预设默认值合成；创建后不再跟预设变化（会话有自己的快照）。
    const config: ConfigBody = opts.config ?? {
      model: { mode: "follow-default" },
      capabilities: view?.capabilities ?? null,
      permissionTier: null,
    };
    // 子会话沿用父当前的模式；其余会话创建时没有激活的模式，之后用 switch_mode 或界面切换。
    const activeModeId = opts.child?.activeModeId ?? null;
    const promptRender = view ? renderOutput(view.prompt) : null;
    const promptText = promptRender?.text ?? null;
    const userPromptText = view?.prompt.userText ?? null;
    const id = opts.resume?.id ?? uuidv7();
    // 会话文件落在自己的工作区子目录下，所以工作区 id 必须在工厂之前定下。
    const plan = this.resolveWorkspaceAtCreate(requested, ws, rosterIds);
    const n = this.pending.get(ws.id) ?? 0;
    this.pending.set(ws.id, n + 1);
    let session: Awaited<ReturnType<typeof factory>>;
    let skills: SessionSkill[] | undefined;
    try {
      skills = await this.prepareSkills(id, ws, plan.id, config);
      this.trackSkills(id, skills, plan.id, config);
      const mcpTools = await this.prepareMcp(id, plan.id, config);
      session = await factory({
        id,
        sessionDir: sessionDirFor(this.deps.sessionDir, plan.id),
        cwd: ws.path,
        ...(opts.resume ? { file: opts.resume.file } : {}),
        ...(opts.seedHead ? { seedHead: opts.seedHead } : {}),
        extensions: [
          ...buildExtensions(
            this.extensionHost(),
            id,
            ws,
            mcpTools,
            this.mcpSetup(id, ws, plan.id, config),
            opts.child?.spec,
          ),
        ],
        ...(view
          ? {
              agent: this.factoryAgent(
                id,
                promptText ?? "",
                promptRender,
                allowlist(),
                config,
              ),
            }
          : {}),
        ...(skills
          ? { skills: () => this.skillSets.get(id) ?? skills ?? [] }
          : {}),
        // 子会话无人值守，不给 UI 通道（ask_user 也只在非子会话里装）。
        ...(opts.child ? {} : { ui: this.uiFor(id) }),
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
    this.noteToolOriginals(session);
    // 工厂完成后再次校验 directory 仍存在（删除可能发生在工厂等待期间）。
    if (!this.deps.directories.get(ws.id)) {
      session.dispose();
      throw new PoolError("bad_request", "directory 已被删除");
    }
    // 父子关系在所有可能失败的步骤之后登记，失败时不留悬空行。
    if (opts.child) this.deps.subagents?.create({ childId: id, ...opts.child });
    // 工厂与校验都过了才绑定：新建工作区发生在这里，前面失败时不会留下没人用的空工作区。
    const workspaceId = plan.bind();
    const entry = new SessionEntry(session, {
      id,
      directoryId: ws.id,
      workspaceId,
      activeModeId,
      promptText,
      promptRender,
      userPromptText,
      promptPresetId,
      modePresetIds,
      agentsFiles,
      ...this.entryOptions(),
    });
    entry.noteSkills(skills);
    this.entries.set(id, entry);
    this.deps.configs?.insert(id, config);
    // 展示编号建会话时就分配（全局单调、不复用），落库前暂存在会话上。
    entry.seqNo = this.deps.store.allocSeq();
    this.observe("SessionStart", id, ws, { source: "new" });
    if (opts.child) {
      // 派发属于父会话的动作：会话上下文取父当前所在的 directory。
      const parent = this.entries.get(opts.child.parentId);
      const parentWs =
        (parent && this.deps.directories.get(parent.directoryId)) || ws;
      this.observe("SubagentStart", opts.child.parentId, parentWs, {
        child_id: id,
        task: opts.child.task,
        depth: opts.child.depth,
      });
    }
    this.feed?.touch(id);
    return entry.info;
  }

  /**
   * 子代理 fork：以 leafEntryId 为分叉点，从父会话文件截出一份新会话文件（不改父文件），
   * 返回新会话的 id 与文件，交给 create({ resume }) 装载。
   */
  forkFile(
    parentId: string,
    leafEntryId: string,
  ): { id: string; file: string } {
    const file = this.sessionFileOf(parentId);
    if (!file) throw new PoolError("bad_request", "父会话还没有可复制的历史");
    // 单独的 SessionManager：createBranchedSession 会把它自己指向新文件，不能动 live 会话的 manager。
    // 落点目录取源文件所在目录：新文件与父会话同在一个工作区子目录。
    const manager = SessionManager.open(file, path.dirname(file));
    const forked = manager.createBranchedSession(leafEntryId);
    if (!forked || !existsSync(forked))
      throw new PoolError("bad_request", "分叉点之前没有对话内容");
    return { id: manager.getSessionId(), file: forked };
  }

  // 会话库（元数据、分组）直接读写同一个索引。
  get store(): SessionStore {
    return this.deps.store;
  }

  get configs(): SessionConfigService | undefined {
    return this.deps.configs;
  }

  // 预设选择的结果（提示词 + 默认能力/权限）：创建接口解析默认值用。
  choosePresets(choice: PresetChoice): PresetSelection | null {
    return this.deps.presetView?.(choice) ?? null;
  }

  // 生效的审批档：会话自己覆盖的优先，没覆盖就活地跟随全局默认（每次工具调用即时读）。
  private sessionTier(id: string): Tier {
    return (
      this.deps.configs?.tierOf(id) ?? this.deps.defaultTier?.() ?? "rules"
    );
  }

  // 子代理的档位：会话生效档与派发上限取较严的一档，且永远到不了「通过」档（subagent.md §7）。
  private effectiveTier(id: string, spec: SubagentSpec | undefined): Tier {
    const t = this.sessionTier(id);
    return spec && (t === "full" || (t === "auto" && spec.tierCap === "rules"))
      ? spec.tierCap
      : t;
  }

  // 某个 directory 的权限判定上下文（档位、规则与「记住」都按给定的 directory 取）；
  // 命令类工具的目标目录与文件类工具的目标地址都按它归属的 directory 判。
  private permissionCtxOf(
    id: string,
    ws: Directory,
    spec: SubagentSpec | undefined,
  ): DirectoryCtx {
    const env = this.envOf(ws);
    if (!env)
      throw new Error(
        `Host "${this.hostLabelOf(ws.environmentId, this.primaryDirectoryOf(id).id)}" is not available.`,
      );
    const all = this.deps.rules.list(ws.id);
    return {
      id: ws.id,
      name: ws.name,
      ref: directoryRef(
        this.hostLabelOf(ws.environmentId, this.primaryDirectoryOf(id).id),
        ws.name,
      ),
      where: { env, cwd: ws.path },
      tier: this.effectiveTier(id, spec),
      rules: {
        path: all.flatMap((r) =>
          r.kind === "path" && r.access
            ? [{ access: r.access, value: r.value }]
            : [],
        ),
        command: all.filter((r) => r.kind === "command").map((r) => r.value),
      },
      // 子会话不产生新的记住规则；无人值守时本来也走不到这里。
      addRule: (r) => {
        if (!spec) this.deps.rules.add(ws.id, r);
      },
    };
  }

  // 会话的主目录（local）：所属工作区的第 0 号目录；子会话取派发时记下的那一个（它的目录子集里可能没有）。
  // 地址簿的主机命名、提示词与子代理派发都取它，别处不再自己算「谁是主目录」。
  primaryDirectoryOf(id: string): Directory {
    const spec = this.deps.subagents?.get(id)?.spec;
    const wsId = spec ? null : this.boundWorkspaceId(id);
    const primaryId = spec
      ? spec.primaryDirectoryId
      : wsId === null
        ? ""
        : (this.binding.directoryIds(wsId)[0] ?? "");
    // 没有工作区的老会话（以及没记下主目录的子会话）：沿用原来的回退（当前目录 / 子集第一个）。
    const primary = this.deps.directories.get(
      primaryId || (this.directoryIdsOf(id)[0] ?? ""),
    );
    if (primary) return primary;
    // 主目录被删：退回当前目录。
    const current = this.deps.directories.get(
      this.entries.get(id)?.directoryId ?? "",
    );
    if (current) return current;
    throw new Error("This session has no directory.");
  }

  // 会话所属的工作区（新建会话没落库前也能取到）。
  workspaceIdOf(sessionId: string): string | null {
    return this.boundWorkspaceId(sessionId);
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
    const { sessionDir, store, factory, directories } = this.deps;
    const file = findSessionFile(sessionDir, id);
    if (!file) return null;
    const dir = path.dirname(file);
    let seed: ChatMessage[];
    let seedTotal: number;
    let interrupted: boolean;
    let createdAt: string;
    try {
      const header = readHeader(file, id);
      if (!header) throw new Error("会话文件头无效");
      createdAt = header.createdAt;
      const all = readMessages(file, dir, id);
      seedTotal = all.length;
      seed = all.slice(-WINDOW).map(({ index: _i, ...m }) => m);
      interrupted = hasDanglingToolCall(file, dir, id);
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    if (!factory) throw new PoolError("load_failed", "没有会话后端");
    const row = store.get(id);
    const ws =
      (row?.directoryId ? directories.get(row.directoryId) : undefined) ??
      directories.getDefault();
    if (!ws) throw new PoolError("load_failed", "没有可用的 directory");
    const bad = this.directoryProblem(ws);
    if (bad) throw new PoolError("load_failed", bad);
    const config = this.deps.configs?.get(id) ?? null;
    // 提示词基线沿用创建时记下的版本，没有就按记录的选择现拼；两份 AGENTS.md 在装载时重读。
    const agentsFiles = await this.agentsFilesOf(
      this.directoryIdsOf(id)[0] ?? ws.id,
    );
    const view =
      this.deps.presetView?.({
        agentPresetId: row?.promptPresetId ?? null,
        model: this.modelRefFor(config?.model),
        agentsFiles,
      }) ?? null;
    const promptRender = view ? renderOutput(view.prompt) : null;
    const promptText = row?.promptText ?? promptRender?.text ?? null;
    const userPromptText = view?.prompt.userText ?? null;
    let session: AgentSession;
    const skills = await this.prepareSkills(
      id,
      ws,
      this.workspaceIdOf(id),
      config ?? undefined,
    );
    this.trackSkills(id, skills, this.workspaceIdOf(id), config ?? undefined);
    // MCP 只在 local 上运行：按会话的 local directory 装载，不随当前所在的 directory 变。
    const localWs = this.deps.directories.get(this.primaryDirectoryOf(id).id);
    const mcpTools = await this.prepareMcp(
      id,
      this.workspaceIdOf(id),
      config ?? undefined,
    );
    // 子会话恢复时按派发约束重建，保证只收窄不放宽跨重启成立。
    const spec = this.deps.subagents?.get(id)?.spec;
    try {
      session = await factory({
        id,
        sessionDir: dir,
        file,
        cwd: ws.path,
        extensions: [
          ...buildExtensions(
            this.extensionHost(),
            id,
            ws,
            mcpTools,
            this.mcpSetup(
              id,
              localWs ?? ws,
              this.workspaceIdOf(id),
              config ?? undefined,
            ),
            spec,
          ),
        ],
        ...(view
          ? {
              agent: this.factoryAgent(
                id,
                promptText ?? "",
                promptRender,
                allowlist(),
                config ?? undefined,
              ),
            }
          : {}),
        ...(skills
          ? { skills: () => this.skillSets.get(id) ?? skills ?? [] }
          : {}),
        ...(spec ? {} : { ui: this.uiFor(id) }),
      });
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    if (this.disposed) {
      session.dispose();
      throw new PoolError("disposed", "会话池已关闭");
    }
    this.noteToolOriginals(session);
    const entry = new SessionEntry(session, {
      id,
      directoryId: ws.id,
      workspaceId: row?.workspaceId ?? null,
      activeModeId: row?.activeModeId ?? null,
      promptText,
      promptRender,
      userPromptText,
      promptPresetId: row?.promptPresetId ?? null,
      modePresetIds: row?.modePresetIds ?? [],
      agentsFiles,
      createdAt: row?.createdAt ?? createdAt,
      updatedAt: row?.updatedAt,
      seed,
      seedTotal,
      interrupted,
      ...this.entryOptions(),
    });
    entry.noteSkills(skills);
    this.entries.set(id, entry);
    this.observe("SessionStart", id, ws, { source: "resume" });
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

  /** 是否是某次 spawn 出来的子代理会话（它们归父会话的执行体管，不进会话库）。 */
  isChild(id: string): boolean {
    return Boolean(this.deps.subagents?.get(id));
  }

  // 列表级推送流的挂接：下游没挂时池内一切照旧。
  attachFeed(feed: SessionFeed): void {
    this.feed = feed;
  }

  // 一轮结束的旁路回调（推送通知用）：与列表流的标记互不影响。
  attachTurnEnded(fn: (id: string, error: boolean) => void): void {
    this.turnEnded = fn;
  }

  /** 某个会话的列表行可能变了（会话库直接改库的动作也走这里）。 */
  touch(id: string): void {
    this.feed?.touch(id);
  }

  // 一轮结束而没人在看：正常结束标「新结果」，失败结束标「出错」；用户主动中止不标。
  private markEnded(id: string, outcome: RunOutcome): void {
    if (outcome.aborted || this.isSubagent(id)) return;
    // 通知不看有没有人在看：要不要发由通知层按各设备的策略判。
    this.turnEnded?.(id, outcome.error !== undefined);
    const feed = this.feed;
    if (!feed || feed.watched(id)) return;
    if (outcome.error !== undefined) this.deps.store.markUnread(id, "error");
    else this.deps.store.markUnread(id, "result");
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
      preview: r.preview ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      running: false,
      directoryId: this.rowDirectoryId(r.directoryId),
      promptPresetId: r.promptPresetId ?? null,
      modePresetIds: r.modePresetIds ?? [],
      activeModeId: r.activeModeId ?? null,
    };
  }

  // 会话的目标 / 任务清单 / 压缩状态：已加载的取内存副本，否则读库。
  stateOf(id: string): SessionState {
    const e = this.entries.get(id);
    return e ? e.state.view() : (this.deps.states?.get(id) ?? emptyState());
  }

  // 会话此刻能看到什么：读过 / 改过的文件（落库）、注入的 skill（仅已加载的会话有）、可见的 MCP 服务。
  contextOf(id: string): ContextView | null {
    const info = this.info(id);
    if (!info) return null;
    const { files, truncated } = this.deps.files?.list(id) ?? {
      files: [],
      truncated: false,
    };
    return {
      files: files.map(fileView),
      ...(truncated ? { filesTruncated: true as const } : {}),
      skills: this.entries.get(id)?.skillsLoaded ?? [],
      mcp: this.mcpItemsOf(info.id),
    };
  }

  // 右栏与 /mcp 弹窗的 MCP 条目：会话在内存里就以它自己的连接状态为准，否则看 Server 最近一次检测。
  private mcpItemsOf(id: string): McpContextItem[] {
    const detected =
      this.deps.mcp?.contextOf(
        this.workspaceIdOf(id),
        this.capabilityNamesOf(id, "mcp"),
      ) ?? [];
    const live = this.mcpSetups.get(id);
    const entry = this.entries.get(id);
    if (!live || !entry) return detected;
    const registered = entry.registeredTools;
    const home = this.directoryViews(id, "").find((v) => v.id === live.homeId);
    const homeLabel =
      home && home.hostId !== LOCAL_ENV_ID ? home.host : "local";
    return detected.map((d): McpContextItem => {
      const where = d.transport === "http" ? "Server" : homeLabel;
      if (d.state === "disabled") return { ...d, where };
      // 登记了但 pi 没读走过这一项：这个会话开着的时候才新增的，下一条消息或重载时才会连
      if (!live.setup.loaded.names.has(d.name))
        return {
          name: d.name,
          global: d.global,
          transport: d.transport,
          state: "pending",
          tools: 0,
          where,
        };
      const lv = live.setup.status.get(d.name);
      const meta = live.setup.servers().find((s) => s.name === d.name);
      return {
        name: d.name,
        global: d.global,
        transport: d.transport,
        state: lv?.state ?? "connecting",
        tools: meta ? liveToolDefs(registered, [meta]).length : 0,
        where,
        ...(lv?.error ? { error: lv.error } : {}),
      };
    });
  }

  // 是否有工作区挂着该 directory（含作为主目录）；删除 directory 前检查。
  directoryInUse(id: string): boolean {
    for (const e of this.entries.values())
      if (e.directoryId === id || this.directoryIdsOf(e.id).includes(id))
        return true;
    const created = this.pending.get(id) ?? 0;
    return (
      created > 0 ||
      this.deps.workspaceDirectories.referenceCount(id) > 0 ||
      this.deps.directories.sessionCount(id) > 0
    );
  }

  // 改名：已加载的走池内会话；未加载的只追加 JSONL 并更新索引，不进池。
  async rename(id: string, nameRaw: string): Promise<SessionInfo | null> {
    const name = nameRaw.trim();
    if (name.length < 1 || name.length > NAME_MAX)
      throw new PoolError("bad_request", `name 需要 1 到 ${NAME_MAX} 个字符`);
    if (!UUID_RE.test(id)) return null;
    const { store } = this.deps;
    const resident = this.entries.get(id);
    if (resident) {
      resident.rename(name);
      if (store.get(id)) store.rename(id, name);
      this.feed?.touch(id);
      return resident.info;
    }
    const file = this.sessionFileOf(id);
    if (!file) return null;
    try {
      if (!readHeader(file, id)) throw new Error("会话文件头无效");
      SessionManager.open(file, path.dirname(file)).appendSessionInfo(name);
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    if (!store.get(id)) this.indexFromFile(id, file, name);
    else store.rename(id, name);
    this.feed?.touch(id);
    return this.info(id);
  }

  private indexFromFile(id: string, file: string, name: string | null): void {
    const header = readHeader(file, id);
    if (!header) return;
    this.deps.store.upsert({
      id,
      name,
      preview: readPreview(file),
      createdAt: header.createdAt,
      updatedAt: header.createdAt,
    });
  }

  // 某会话的完整历史；会话存在但还没有 JSONL（空会话）时为空数组，不存在为 null。
  history(id: string): ChatEntry[] | null {
    if (!UUID_RE.test(id)) return null;
    // 已装载的会话以内存里的分支为准：回退后 JSONL 末行仍在旧分支，直接读文件会拿错历史。
    const resident = this.entries.get(id);
    if (resident)
      return projectMessages(
        resident.sessionManager.getBranch() as unknown as BranchEntry[],
      );
    const file = this.sessionFileOf(id);
    if (file) {
      try {
        return readMessages(file, path.dirname(file), id);
      } catch (err) {
        throw new PoolError("load_failed", reason(err));
      }
    }
    return this.entries.has(id) ? [] : null;
  }

  // 会话 JSONL 的路径与所在目录（审计从压缩条目重建快照用）；还没有落盘文件时为 null。
  sessionFile(id: string): { file: string; dir: string } | null {
    if (!UUID_RE.test(id)) return null;
    const file = this.sessionFileOf(id);
    return file ? { file, dir: path.dirname(file) } : null;
  }

  // B20 会话树：已装载的会话按 live 分支读（回退后 leaf 不在 JSONL 末行），否则只读文件。
  sessionTree(id: string): SessionTreeView | null {
    if (!UUID_RE.test(id)) return null;
    const resident = this.entries.get(id);
    try {
      if (resident) return treeOf(resident.sessionManager);
      const file = this.sessionFileOf(id);
      if (file) return readSessionTree(file, path.dirname(file), id);
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    return this.deps.store.get(id)
      ? { leafId: null, activePath: [], nodes: [] }
      : null;
  }

  // B20 指令列表：当前分支上的用户原文；空会话返回空数组，会话不存在返回 null。
  userMessages(id: string): ForkUserMessage[] | null {
    if (!UUID_RE.test(id)) return null;
    const resident = this.entries.get(id);
    try {
      if (resident) return userMessagesOf(resident.sessionManager);
      const file = this.sessionFileOf(id);
      if (file) return readUserMessages(file, path.dirname(file), id);
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    return this.deps.store.get(id) ? [] : null;
  }

  // 回退到历史节点；会话不存在返回 null（未装载的先按需加载成 live 会话再回退）。
  async navigate(
    id: string,
    targetId: string,
  ): Promise<{
    editor?: { text: string; attachments?: AttachmentRef[] };
    leafId: string | null;
  } | null> {
    const entry = await this.acquire(id);
    return entry ? entry.navigate(targetId) : null;
  }

  /**
   * P09 复制会话分叉：以 entryId 为分叉点从原 JSONL 截出一条新会话文件（不改原文件）。
   * 新会话沿用原会话的 directory/agent/mode 与已落库的会话配置，写进索引后即可像普通会话一样打开。
   * title 由调用方（会话库）按分叉命名规则算好传入。
   */
  async fork(id: string, entryId: string, title: string): Promise<SessionInfo> {
    if (this.disposed) throw new PoolError("disposed", "会话池已关闭");
    const { store } = this.deps;
    const info = this.info(id);
    if (!info) throw new PoolError("bad_request", "会话不存在");
    const file = this.sessionFileOf(id);
    if (!file) throw new PoolError("bad_request", "会话还没有可复制的历史");
    // 单独的 SessionManager：createBranchedSession 会把它自己指向新文件，不能动 live 会话的 manager。
    // 落点目录取源文件所在目录，新文件与源会话同在一个工作区子目录。
    const manager = SessionManager.open(file, path.dirname(file));
    if (!manager.getEntry(entryId))
      throw new PoolError("bad_request", "分叉节点不存在");
    let newFile: string | undefined;
    let newId: string;
    try {
      newFile = manager.createBranchedSession(entryId);
      // 标题写进新 JSONL，顺带保证没有任何对话时文件也会落盘。
      manager.appendSessionInfo(title);
      newId = manager.getSessionId();
    } catch (err) {
      throw new PoolError("load_failed", reason(err));
    }
    // 分叉点之前没有对话（只有状态条目）时 pi 不落盘，这样的分叉无法打开，直接拒绝。
    if (!newFile || !existsSync(newFile))
      throw new PoolError("bad_request", "分叉节点之前没有对话内容");
    const header = manager.getHeader();
    const now = new Date().toISOString();
    const original = store.get(id);
    // 分叉会话与原会话同属一个工作区，并记下派生关系。
    const workspaceId = this.ensureWorkspace(id);
    store.upsert({
      id: newId,
      name: title,
      createdAt: header?.timestamp ?? now,
      updatedAt: now,
      directoryId: info.directoryId,
      workspaceId,
      promptPresetId: info.promptPresetId,
      modePresetIds: info.modePresetIds,
      activeModeId: info.activeModeId,
      // 提示词基线跟着原会话走，避免分叉会话在下次装载时重新拼出不一样的前缀。
      promptText: original?.promptText ?? null,
    });
    store.setParent(newId, id, entryId);
    const config = this.deps.configs?.stored(id);
    if (config) this.deps.configs?.insert(newId, bodyOf(config));
    const created = this.info(newId);
    if (!created) throw new PoolError("load_failed", "分叉会话没有进索引");
    return created;
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
    // 在下面拆索引与子代理行之前发：删除之后根会话解析不出来，也找不到该发哪一行。
    this.feed?.removed(id);
    this.deps.jobs?.removeSession(id);
    // 协作区随根会话删除（子代理自己被删时留着，同树的其他会话还可能读它）
    if (!this.deps.subagents?.get(id)) this.deps.collab?.remove(id);
    this.deps.tracker?.forget(teamChangeKey(id));
    this.deps.teams?.removeTeam(id);
    this.deps.teams?.removeMember(id);
    this.deps.subagents?.removeSession(id);
    this.deps.calls?.removeSession(id);
    this.deps.browser?.releaseSession(id).catch(() => {});
    this.deps.browser?.replay.removeSession(id);
    this.deps.configs?.remove(id);
    this.deps.states?.remove(id);
    this.deps.files?.remove(id);
    store.remove(id);
    this.deliveries.delete(id);
    this.mcpSetups.delete(id);
    this.skillSets.delete(id);
    this.skillSigs.delete(id);
    if (entry) {
      this.entries.delete(id);
      entry.dispose();
    }
    // 放在最后：这里有 await，前面的拆除必须一气呵成，别让并发的访问看到拆了一半的会话
    await this.deps.attachments?.removeSession(id).catch(() => {});
    return "ok";
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) e.dispose();
    this.entries.clear();
  }
}
