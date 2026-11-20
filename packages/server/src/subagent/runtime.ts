// 子代理运行时（subagent.md）：派发、交付、联系、停止。
// 子会话就是普通会话；每个子代理对应一个后台任务（kind = subagent，任务 id 就是子代理 id），
// 提醒、回调、停止都走 job/ 那一套。这里只管父子关系、上下文、限额、交付与完成判定。
import { readFileSync, rmSync } from "node:fs";
import { blockOrDetach } from "../job/block.js";
import type { JobHandle, JobManager } from "../job/manager.js";
import { clampRemindMs } from "../job/manager.js";
import { TEAM_MEMBER, WORKFLOW_AGENT } from "../job/messages.js";
import { PAGE_READER_PRESET_ID } from "../prompt/builtin-agents.js";
import { readHead } from "../session/frozen.js";
import {
  PoolError,
  type RunOutcome,
  type SessionEntry,
  type SessionPool,
  type SubagentHooks,
} from "../session/pool.js";
import type { SubagentLimits } from "../store/defaults.js";
import type { Directory, DirectoryStore } from "../store/directories.js";
import type {
  PromptPreset,
  PromptPresetStore,
} from "../store/prompt-presets.js";
import type { ConfigBody, ConfigModel } from "../store/session-configs.js";
import type { SubagentStore } from "../store/subagents.js";
import type { CollabArea, Report } from "./collab.js";
import { type BranchEntry, forkPoint } from "./fork.js";
import { SUBAGENT_LIMITS } from "./limits.js";
import {
  abortedWhileWaitingText,
  callerMessage,
  callerNote,
  deliveredText,
  failedText,
  isWorkDone,
  NUDGE_TEXT,
  openingBrief,
  stillRunningText,
  stoppedText,
  unchangedText,
  undeliveredText,
} from "./messages.js";
import { subagentExtension } from "./tools.js";

/** 页面阅读子代理的调用参数（页面快照管线拼好任务文字再进来） */
export interface ReadPageArgs {
  /** 完整任务文字（调用方拼好，含结构视图与输出格式） */
  task: string;
  /** 总时限；到点还没交付就把子代理停掉 */
  timeoutMs: number;
  /** 调用方的中止信号（用户停止了这一步） */
  signal?: AbortSignal;
  /** 子代理标签上显示的名字，如「页面阅读：GitHub issues」 */
  label: string;
}

export interface SpawnInput {
  task: string;
  // Agent 预设的 id 或名称；缺省与调用方相同，fork 时不可指定。
  agent?: string;
  context?: "fresh" | "fork";
  // 仅调用方没有激活模式时可选；有则子代理沿用。
  mode?: string;
  // 「供应商id/模型id」；仅 fresh。
  model?: string;
  // 子会话工作的目录，写 `<host>:<name>`；缺省是调用方当前所在的那个。子代理只在一个目录里工作，不能切换。
  directory?: string;
  // 比继承来的更严时才有意义。
  tier?: "rules" | "auto";
  // 阻塞到这么久（秒）还没交付就先返回、转后台；也是之后的提醒间隔。
  remindAfter?: number;
}

/** 发起这次调用的上下文：fork 的分叉点与 fresh 沿用的冻结物都从调用方的会话分支里取。 */
export interface SpawnCall {
  toolCallId: string;
  signal: AbortSignal | undefined;
  branch: readonly BranchEntry[];
}

export interface ToolText {
  text: string;
  isError?: boolean;
}

// 信息直接给模型看。
export class SubagentError extends Error {}

/** 存活数到了上限：暂时的，等别的子代理交付后就能再派发 */
export class AliveLimitError extends SubagentError {}

/** 开场消息要用到的、派发过程中才知道的信息 */
export interface BriefContext {
  childId: string;
  root: string;
  depth: number;
  maxDepth: number;
  fork: boolean;
  mode: string | null;
  /** 协作区：自己的子目录在虚拟主机 collab 里的路径（如 `/019a…`） */
  collab?: { ownPath: string };
}

/** 团队成员的派发：同一套机制，开场消息与登记另算（team.md） */
export interface MemberLaunch {
  name: string;
  /** 会话建好、开场消息发出之前：登记花名册（回调文案与 post 工具要先认得它） */
  onCreated(childId: string): void;
  brief(c: BriefContext): string;
}

/** 谁在派发：团队成员（开场消息与登记另算），动态工作流里的 agent()（结果交给脚本，不回调调用方），
 * 或页面快照的只读阅读 agent（不占存活名额，也不属于任何工作流运行） */
export type LaunchAs =
  | { kind: "member"; member: MemberLaunch }
  | { kind: "workflow"; label: string; runId: string; phase: string | null }
  | { kind: "reader"; label: string };

/** 子代理是团队成员时，运行时借它改文案、记公告板 */
export interface MemberHooks {
  nameOf(childId: string): string | null;
  delivered(
    childId: string,
    name: string,
    summary: string,
    report?: Report,
  ): void;
}

export interface RuntimeDeps {
  pool: SessionPool;
  store: SubagentStore;
  jobs: JobManager;
  directories: DirectoryStore;
  presets: PromptPresetStore;
  /** 供应商里有没有这个模型 */
  hasModel: (provider: string, model: string) => boolean;
  /** 辅助模型（页面快照的阅读 agent 用它）；没配就不起这个 agent */
  auxModel: () => { provider: string; model: string } | null;
  limits: () => SubagentLimits;
  collab: CollabArea;
  members?: MemberHooks;
}

export type RoundResult =
  | { kind: "delivered"; summary: string; report?: Report }
  | { kind: "unchanged" }
  | { kind: "undelivered"; text: string }
  | { kind: "failed"; error: string }
  | { kind: "stopped" };

// 子代理的一「轮」：从派发（或被联系唤醒）到交付 / 失败 / 被停止。
export interface Round {
  handle: JobHandle;
  // 被 message_subagent 唤醒的轮次：只回复 work done 表示对原交付没有影响。
  wake: boolean;
  // 「交付没变」不回调派发者（团队里公告与成员私信引起的唤醒，不该吵到 lead）。
  quiet: boolean;
  nudges: number;
  // deliver 的缓冲：可多次调用，后一次覆盖前一次。
  delivery?: { summary: string; report?: Report };
  done: Promise<ToolText>;
  resolve: (r: ToolText) => void;
  /** 这一轮的结构化结果（工作流据此取交付的 summary，不要框架口吻的文字） */
  settled: Promise<RoundResult>;
  settle: (r: RoundResult) => void;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const briefArgs = (args: unknown): string => {
  if (args && typeof args === "object") {
    const v = Object.values(args).find((x) => typeof x === "string");
    if (typeof v === "string") return clip(oneLine(v), 120);
  }
  return "";
};

export class SubagentRuntime {
  private readonly rounds = new Map<string, Round>();
  // 正在被停止的子会话：防止「停止 → 中断运行 → 再停止」循环。
  private readonly stopping = new Set<string>();
  // 用户在子代理标签里点的停止：会话自己已经在停了，不必再对它调一次 stop。
  private readonly userStop = new Set<string>();
  // 派发进行中、行还没登记的数量，防止并行 spawn 冲破存活上限。
  private readonly reservedDirect = new Map<string, number>();
  private readonly reservedTree = new Map<string, number>();

  constructor(private readonly deps: RuntimeDeps) {
    // 上一个进程里还在跑的子会话都已不存在；任务表那边同样落成 interrupted，父下次发消息前被告知。
    deps.store.interruptRunning();
  }

  // 挂进会话池的钩子。
  hooks(): SubagentHooks {
    return {
      tools: (id, isChild) => subagentExtension(this, id, isChild),
      runEnded: (e, o) => this.runEnded(e, o),
      userStopped: (id) => this.userStopped(id),
      toolStarted: (id, t) => {
        const round = this.rounds.get(id);
        if (!round) return;
        // 催交付的次数按「连续」算：它又动手干活了就清零
        round.nudges = 0;
        round.handle.write(`→ ${t.name} ${briefArgs(t.args)}\n`);
      },
    };
  }

  private presetOf(entry: SessionEntry): PromptPreset | undefined {
    const { presets } = this.deps;
    return (
      (entry.promptPresetId ? presets.get(entry.promptPresetId) : undefined) ??
      presets.list("agent")[0]
    );
  }

  /** 按名称或 id 找 Agent 预设；缺省取调用方自己的 */
  resolvePreset(ref: string | undefined, parent: SessionEntry): PromptPreset {
    const { presets } = this.deps;
    if (ref === undefined) {
      const own = this.presetOf(parent);
      if (!own) throw new SubagentError("没有可用的 agent 预设");
      return own;
    }
    const all = presets.list("agent");
    const byId = all.find((p) => p.id === ref);
    const byName = all.filter((p) => p.name === ref);
    if (!byId && byName.length > 1)
      throw new SubagentError(`agent 预设名称「${ref}」不唯一，请改用 id`);
    const hit = byId ?? byName[0];
    if (!hit)
      throw new SubagentError(
        `agent 预设不存在：${ref}。可用的：${all.map((p) => p.name).join("、")}`,
      );
    return hit;
  }

  // 子代理只在一个目录里工作：`<host>:<name>` 走父会话的地址簿（父可见的目录），缺省取父当前所在的目录。
  private pickDirectory(
    ref: string | undefined,
    parent: SessionEntry,
  ): Directory {
    if (ref === undefined || ref.trim() === "") {
      const cur = this.deps.pool
        .visibleDirectories(parent.id)
        .find((w) => w.id === parent.directoryId);
      if (!cur) throw new SubagentError("父会话当前的 directory 不可用");
      return cur;
    }
    // 地址簿的报错原文直接给模型看（它已列出这台会话有哪些目录）
    try {
      return this.deps.pool.addressBookOf(parent.id).directory(ref);
    } catch (err) {
      throw new SubagentError(err instanceof Error ? err.message : String(err));
    }
  }

  // 子代理的模式：调用方有激活模式就沿用（不能另指定），没有则可从它的可切换清单里指定一个。
  private pickMode(
    ref: string | undefined,
    parent: SessionEntry,
  ): { id: string | null; name: string | null } {
    const { pool } = this.deps;
    const choices = pool.modeChoices(parent.id);
    if (parent.activeModeId) {
      if (ref !== undefined)
        throw new SubagentError(
          "子代理沿用你当前的模式，不能另外指定 mode 参数。",
        );
      return {
        id: parent.activeModeId,
        name: choices.find((m) => m.id === parent.activeModeId)?.name ?? null,
      };
    }
    if (ref === undefined) return { id: null, name: null };
    const hit = choices.find(
      (m) => m.id === ref || m.name.toLowerCase() === ref.toLowerCase(),
    );
    if (!hit)
      throw new SubagentError(
        `模式不存在：${ref}。可用的：${choices.map((m) => m.name).join("、") || "（没有）"}`,
      );
    return { id: hit.id, name: hit.name };
  }

  // fresh 的模型：显式指定的，否则与调用方相同（同模型才能共享缓存）。fork 一律与调用方相同。
  private pickModel(
    ref: string | undefined,
    parentModel: ConfigModel,
  ): ConfigModel {
    if (ref === undefined) return parentModel;
    const i = ref.indexOf("/");
    const provider = i > 0 ? ref.slice(0, i) : "";
    const model = i > 0 ? ref.slice(i + 1) : "";
    if (!provider || !model || !this.deps.hasModel(provider, model))
      throw new SubagentError(`模型不存在：${ref}。写成「供应商id/模型id」。`);
    const same =
      parentModel.mode === "explicit" &&
      parentModel.provider === provider &&
      parentModel.model === model;
    return {
      mode: "explicit",
      provider,
      model,
      reasoning: same ? parentModel.reasoning : "off",
    };
  }

  private reserve(parentId: string, rootId: string, delta: 1 | -1): void {
    const bump = (m: Map<string, number>, k: string) => {
      const n = (m.get(k) ?? 0) + delta;
      if (n > 0) m.set(k, n);
      else m.delete(k);
    };
    bump(this.reservedDirect, parentId);
    bump(this.reservedTree, rootId);
  }

  // 存活 = 没交付也没被停止。超限直接返回错误并写明别重试：阻塞的子代理若排队等名额，
  // 名额被在跑的占着（其中包括正在等它的父），会死循环。
  // n > 1：团队一次启动几个成员，要整批放得下才开始。
  private checkAlive(parentId: string, rootId: string, n = 1): void {
    const { store } = this.deps;
    const lim = this.deps.limits();
    const more = n > 1 ? ` Starting ${n} more would exceed it.` : "";
    const direct =
      store.runningCount(parentId) + (this.reservedDirect.get(parentId) ?? 0);
    if (direct + n > lim.perCaller)
      throw new AliveLimitError(
        `You already have ${direct} subagents alive (limit ${lim.perCaller}).${more} This is a hard limit: do NOT retry now. Wait until some have delivered, or stop some with job_stop.`,
      );
    const tree =
      store.aliveInTree(rootId) + (this.reservedTree.get(rootId) ?? 0);
    if (tree + n > lim.perTree)
      throw new AliveLimitError(
        `The whole tree of subagents already has ${tree} alive (limit ${lim.perTree}).${more} This is a hard limit: do NOT retry now. Wait until some have delivered.`,
      );
  }

  /** 团队建队前确认整批成员放得下存活上限 */
  ensureRoom(parentId: string, n: number): void {
    this.checkAlive(parentId, this.deps.store.rootOf(parentId), n);
  }

  async spawn(
    parentId: string,
    input: SpawnInput,
    call: SpawnCall,
  ): Promise<ToolText> {
    const { handle, round, remindMs, outer } = await this.launch(
      parentId,
      input,
      call,
    );
    // job_start 里：任务本身已在后台，等到交付即可（job_start 自己管观察期与转后台）。
    if (outer) return round.done;
    return blockOrDetach({
      handle,
      done: round.done,
      remindMs,
      signal: call.signal,
      stillRunning: (ranMs) => stillRunningText(handle.id, ranMs, remindMs),
      interrupted: () => abortedWhileWaitingText(handle.id),
    });
  }

  /**
   * 建子会话、登记任务、发出开场消息，不等它交付。普通派发、团队成员、工作流里的 agent() 共用；
   * 成员与工作流 agent 不会被包进 job_start，也不阻塞，成员的开场消息由团队给。
   */
  async launch(
    parentId: string,
    input: SpawnInput,
    call: SpawnCall,
    as?: LaunchAs,
  ): Promise<{
    childId: string;
    handle: JobHandle;
    round: Round;
    remindMs: number;
    outer: boolean;
  }> {
    const { pool, store, jobs } = this.deps;
    const member = as?.kind === "member" ? as.member : undefined;
    const workflow = as?.kind === "workflow" ? as : undefined;
    // 阅读 agent 与工作流一样不占存活名额，但不属于任何工作流运行（没有 run 记录）
    const reader = as?.kind === "reader" ? as : undefined;
    const uncounted = workflow !== undefined || reader !== undefined;
    const parent = pool.get(parentId);
    if (!parent) throw new SubagentError("父会话不可用");
    const task = input.task.trim();
    if (task === "") throw new SubagentError("task 不能为空");
    if (task.length > SUBAGENT_LIMITS.taskMax)
      throw new SubagentError(`task 最多 ${SUBAGENT_LIMITS.taskMax} 个字符`);
    const fork = input.context === "fork";
    if (fork && input.agent !== undefined)
      throw new SubagentError(
        "context 为 fork 时不能指定 agent：fork 沿用你的 Agent。",
      );
    if (fork && input.model !== undefined)
      throw new SubagentError(
        "context 为 fork 时不能指定 model：fork 沿用你的模型。",
      );
    const lim = this.deps.limits();
    const parentRow = store.get(parentId);
    const depth = (parentRow?.depth ?? 0) + 1;
    if (depth > lim.maxDepth)
      throw new SubagentError(
        `已达子代理深度上限（${lim.maxDepth}），不能再派发；请自己完成这项任务，别重试。`,
      );
    const root = store.rootOf(parentId);
    // 工作流与阅读 agent 不占存活名额
    if (!uncounted) this.checkAlive(parentId, root);

    const preset = this.resolvePreset(input.agent, parent);
    const target = this.pickDirectory(input.directory, parent);
    const mode = this.pickMode(input.mode, parent);
    const pc = pool.configs?.stored(parentId);
    const model = fork
      ? (pc?.model ?? { mode: "follow-default" as const })
      : this.pickModel(input.model, pc?.model ?? { mode: "follow-default" });
    // 档位上限只收窄：可更严，且不超过父自己的上限（永远到不了「通过」档由判定处保证）。
    const tierCap =
      input.tier === "rules" || parentRow?.spec.tierCap === "rules"
        ? "rules"
        : "auto";
    const config: ConfigBody = {
      model,
      // fork 沿用调用方此刻生效的能力（工具声明相同才能共享缓存）；fresh 用被选中的 Agent 自己的。
      capabilities: fork ? (pc?.capabilities ?? null) : preset.capabilities,
      // 继承父自己的覆盖；没覆盖就跟随全局。
      permissionTier: pc?.permissionTier ?? null,
    };

    // fork：从父的会话文件截到分叉点；fresh 且 Agent 与模型都与父相同：沿用父的冻结物，开头逐字节相同。
    let resume: { id: string; file: string } | undefined;
    let seedHead: ReturnType<typeof readHead>["data"] = null;
    if (fork) {
      const leaf = forkPoint(call.branch, call.toolCallId);
      if (leaf === null)
        throw new SubagentError(
          "找不到 fork 的分叉点（这次调用之前没有历史）。",
        );
      resume = pool.forkFile(parentId, leaf);
    } else if (
      preset.id === this.presetOf(parent)?.id &&
      input.model === undefined
    ) {
      const head = readHead(call.branch);
      if (!head.stale) seedHead = head.data;
    }

    // 工作流的 agent 与阅读 agent 不占名额，不用预留
    if (!uncounted) this.reserve(parentId, root, 1);
    let childId: string;
    try {
      const info = await pool.create({
        directoryId: target.id,
        promptPresetId: preset.id,
        modePresetIds: mode.id ? [mode.id] : [],
        config,
        child: {
          parentId,
          depth,
          task,
          activeModeId: mode.id,
          // 工作流的 agent 与阅读 agent 不计入存活上限；工作流再记下属于哪次运行、哪个阶段
          ...(uncounted
            ? {
                counted: false,
                ...(workflow
                  ? {
                      run: { id: workflow.runId, phase: workflow.phase },
                    }
                  : {}),
              }
            : {}),
          spec: {
            agentPresetId: preset.id,
            // 子代理只有一个目录（不能切换）：数组照旧，但永远只有一个元素。
            directoryIds: [target.id],
            primaryDirectoryId: pool.primaryDirectoryOf(parentId).id,
            tierCap,
          },
        },
        ...(resume ? { resume } : {}),
        ...(seedHead ? { seedHead } : {}),
      });
      childId = info.id;
    } catch (err) {
      // 会话没建成，fork 截出来的文件就成了没人认领的孤儿
      if (resume) rmSync(resume.file, { force: true });
      if (err instanceof PoolError) throw new SubagentError(err.message);
      throw err;
    } finally {
      if (!uncounted) this.reserve(parentId, root, -1);
    }
    this.flowsChanged(childId);
    member?.onCreated(childId);
    // 协作区：子代理的目录一开始就存在（list_directories 与 ls 立刻能看到它）
    this.deps.collab.ensureOwn(root, childId);

    // 子代理是一个任务：job_start 包着 spawn 时沿用那个任务，否则现登记一个，任务 id 就是子代理 id。
    // 成员不会被包进 job_start，也不阻塞：登记成 team_member，名字当标签。
    const cur = as ? undefined : jobs.current();
    const outer =
      cur &&
      jobs.get(cur.id)?.name === "spawn_subagent" &&
      !jobs.get(cur.id)?.ref
        ? cur
        : undefined;
    const remindMs =
      input.remindAfter === undefined
        ? jobs.defaultRemindMs()
        : clampRemindMs(input.remindAfter * 1000);
    let handle: JobHandle;
    if (outer) {
      jobs.link(outer.id, childId);
      handle = outer;
    } else {
      handle = jobs.register(parentId, {
        kind: "subagent",
        name: member
          ? TEAM_MEMBER
          : workflow
            ? WORKFLOW_AGENT
            : "spawn_subagent",
        label: member
          ? member.name
          : clip(oneLine(workflow?.label ?? reader?.label ?? task), 60),
        ref: childId,
        remindMs,
      });
      if (!member) handle.inline(true);
    }
    const round = this.startRound(childId, handle, false);
    handle.write(`Task: ${clip(oneLine(task), 300)}\n`);

    try {
      const child = pool.get(childId);
      if (!child) throw new Error("子会话创建后不可用");
      const ctx: BriefContext = {
        childId,
        root,
        depth,
        maxDepth: lim.maxDepth,
        fork,
        mode: mode.name,
        // 协作区是虚拟主机：任何目录上的子代理（包括 ssh 上的）都能用
        collab: {
          ownPath: this.deps.collab.virtualPath(
            root,
            this.deps.collab.ownDir(root, childId),
          ),
        },
      };
      // 子代理看到的主机名与父一致：用父会话的地址簿算它的目录引用。
      const where = {
        ref: pool.addressBookOf(parentId).refOf(target),
        path: target.path,
      };
      const brief = member
        ? member.brief(ctx)
        : openingBrief({ task, ...ctx, where });
      // 子会话的整个运行都从这里的异步上下文派生：必须脱离 job_start 的任务上下文，
      // 否则它里面的 bash、再派发的孙代理都会误当成外层任务的一部分。
      jobs.detached(() => child.send(brief));
    } catch (err) {
      this.finishRound(childId, {
        kind: "failed",
        error: `启动失败：${String(err)}`,
      });
      throw new SubagentError("子会话启动失败");
    }
    return { childId, handle, round, remindMs, outer: outer !== undefined };
  }

  /**
   * 起一个只读的页面阅读子代理（内置预设 PAGE_READER_PRESET_ID）并阻塞等它交付。
   * 返回它交付的**报告文本**（`deliver` 的 report；没有 report 就用 summary）；
   * 超出深度上限、被停止 / 超时 / 出错、没有交付、报告读不出都返回 null，由调用方回落。
   */
  async readPage(parentId: string, args: ReadPageArgs): Promise<string | null> {
    const aux = this.deps.auxModel();
    // 没有辅助模型就不起子代理，也不退回会话自己的模型（现行决定）。
    if (!aux) return null;
    let started: Awaited<ReturnType<SubagentRuntime["launch"]>>;
    try {
      started = await this.launch(
        parentId,
        {
          task: args.task,
          agent: PAGE_READER_PRESET_ID,
          model: `${aux.provider}/${aux.model}`,
          // 不带 directory：沿用调用方当前目录。页面正文以 attachment:/… 地址给进去，直接寻址读。
        },
        { toolCallId: "", signal: args.signal, branch: [] },
        { kind: "reader", label: args.label },
      );
    } catch {
      // 深度已满之类的失败：调用方按回落处理，不另记日志
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    const giveUp = async (): Promise<null> => {
      await this.stopChild(started.childId);
      return null;
    };
    // 没有信号时这个 promise 永远不落：让竞速只有一个形状
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((ok) => {
      if (!args.signal) return;
      onAbort = () => ok("aborted");
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([
        started.round.settled,
        new Promise<"timeout">((ok) => {
          timer = setTimeout(() => ok("timeout"), args.timeoutMs);
        }),
        aborted,
      ]);
      if (outcome === "timeout" || outcome === "aborted") return await giveUp();
      if (outcome.kind !== "delivered") return null;
      if (!outcome.report) return outcome.summary;
      try {
        return readFileSync(outcome.report.path, "utf8");
      } catch {
        return null;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // 信号可能比这次调用活得久：收尾时摘掉监听
      if (onAbort) args.signal?.removeEventListener("abort", onAbort);
    }
  }

  private startRound(
    childId: string,
    handle: JobHandle,
    wake: boolean,
    quiet = false,
  ): Round {
    let resolve: (r: ToolText) => void = () => {};
    const done = new Promise<ToolText>((ok) => {
      resolve = ok;
    });
    let settle: (r: RoundResult) => void = () => {};
    const settled = new Promise<RoundResult>((ok) => {
      settle = ok;
    });
    const round: Round = {
      handle,
      wake,
      quiet,
      nudges: 0,
      done,
      resolve,
      settled,
      settle,
    };
    this.rounds.set(childId, round);
    handle.signal.addEventListener(
      "abort",
      () => void this.stopChild(childId),
      {
        once: true,
      },
    );
    return round;
  }

  // 一轮结束：落终态，结果作为阻塞调用的返回，或作为回调交给派发它的会话（任务那边按 inline 区分）。
  private finishRound(childId: string, r: RoundResult): void {
    const round = this.rounds.get(childId);
    if (!round) return;
    this.rounds.delete(childId);
    const { store } = this.deps;
    const id = round.handle.id;
    const prev = store.get(childId);
    // 团队成员：文案称「团队成员 名字」，交付还要记进公告板
    const member = this.deps.members?.nameOf(childId) ?? undefined;
    let out: ToolText;
    let ok = true;
    switch (r.kind) {
      case "delivered":
        store.finish(childId, "done", r.summary, r.report?.path ?? null);
        out = {
          text: deliveredText(
            id,
            r.summary,
            r.report,
            member,
            r.report
              ? this.deps.collab.virtualPath(
                  store.rootOf(childId),
                  r.report.path,
                )
              : undefined,
          ),
        };
        if (member !== undefined)
          this.deps.members?.delivered(childId, member, r.summary, r.report);
        break;
      case "unchanged":
        store.finish(
          childId,
          "done",
          prev?.result ?? null,
          prev?.report ?? null,
        );
        out = { text: unchangedText(id, member) };
        // 静默的唤醒：交付没变就不回调，当作阻塞调用里直接得到结果（任务那边据此标为已知）
        if (round.quiet) round.handle.inline(true);
        break;
      case "undelivered":
        store.finish(
          childId,
          "done",
          clip(r.text, SUBAGENT_LIMITS.summaryMax),
          null,
        );
        out = { text: undeliveredText(id, r.text, member) };
        break;
      case "failed":
        store.finish(childId, "failed", r.error);
        out = { text: failedText(id, r.error, member), isError: true };
        ok = false;
        break;
      case "stopped":
        store.finish(childId, "interrupted", null);
        out = { text: stoppedText(id, member), isError: true };
        ok = false;
        break;
    }
    this.flowsChanged(childId);
    round.handle.end({
      ok,
      text: out.text,
      callback: out.text,
      ...(r.kind === "stopped" ? { stopped: true } : {}),
    });
    round.resolve(out);
    round.settle(r);
  }

  // 子会话一次运行结束：按有没有交付、名下有没有在等的任务，决定这一轮是否算完。
  runEnded(entry: SessionEntry, outcome: RunOutcome): void {
    const id = entry.id;
    const round = this.rounds.get(id);
    if (!round || this.stopping.has(id)) return;
    const done = (r: RoundResult) => {
      this.finishRound(id, r);
    };
    if (outcome.aborted) {
      done({ kind: "stopped" });
      return;
    }
    // 已经交付了，只是收尾那一轮出了错（供应商限流之类）：交付仍然有效
    if (round.delivery) {
      done({ kind: "delivered", ...round.delivery });
      return;
    }
    if (outcome.error !== undefined) {
      done({ kind: "failed", error: `运行失败：${outcome.error}` });
      return;
    }
    // 名下还有在跑的任务，说明它在等回调，回调会再唤醒它；不提醒。
    if (this.waitingOnJobs(id)) return;
    if (round.wake && isWorkDone(outcome.text)) {
      done({ kind: "unchanged" });
      return;
    }
    if (round.nudges < SUBAGENT_LIMITS.nudges) {
      round.nudges++;
      entry.notify(NUDGE_TEXT, "followUp");
      return;
    }
    done({ kind: "undelivered", text: outcome.text });
  }

  // 提醒为 0 的常驻命令（dev server 之类）不算「在等回调」。
  private runningJobs(childId: string) {
    return this.deps.jobs
      .list(childId)
      .filter((j) => j.state === "running" && j.remindMs > 0);
  }

  private waitingOnJobs(childId: string): boolean {
    return this.runningJobs(childId).length > 0;
  }

  /** deliver 工具：把交付存进缓冲，子代理这一轮结束时才送出；可重复调用，以最后一次为准。 */
  deliver(
    childId: string,
    input: { summary: string; report?: string },
  ): string {
    const round = this.rounds.get(childId);
    if (!round) throw new SubagentError("现在没有需要交付的任务。");
    const running = this.runningJobs(childId);
    if (running.length > 0)
      throw new SubagentError(
        `You still have background jobs running: ${running.map((j) => `${j.id} "${j.label}"`).join(", ")}. Wait for them (you will be notified) or stop them with job_stop, then deliver. Nothing was delivered.`,
      );
    const summary = input.summary.trim();
    if (summary === "") throw new SubagentError("summary 不能为空。");
    if (summary.length > SUBAGENT_LIMITS.summaryMax)
      throw new SubagentError(
        `summary is ${summary.length} characters; the limit is ${SUBAGENT_LIMITS.summaryMax}. Shorten it and put the long content in report.`,
      );
    const report =
      input.report !== undefined && input.report.trim() !== ""
        ? this.deps.collab.writeReport(
            this.deps.store.rootOf(childId),
            childId,
            input.report.slice(0, SUBAGENT_LIMITS.reportMax),
          )
        : undefined;
    round.delivery = { summary, ...(report ? { report } : {}) };
    return `Delivery recorded${report ? ` (report saved, ${report.bytes} bytes)` : ""}. It is sent to the session that dispatched you when you end this turn; calling deliver again replaces it. If you have nothing more to do, finish your turn now.`;
  }

  /** message_subagent：对运行中的子代理追加一句话；已结束的唤醒它开新一轮。 */
  async message(parentId: string, id: string, text: string): Promise<ToolText> {
    const { store, jobs } = this.deps;
    const job = jobs.own(parentId, id);
    const childId = job.ref;
    if (childId === null || !store.get(childId))
      throw new SubagentError(`Job ${id} is not a subagent.`);
    if (this.deps.members?.nameOf(childId))
      throw new SubagentError(
        `Job ${id} is a team member: talk to it with post { "to": name, "text": ... }.`,
      );
    const how = await this.tell(parentId, childId, {
      steer: callerNote(text),
      wake: callerMessage(text),
    });
    return {
      text:
        how === "steered"
          ? `Message queued for subagent ${id}; it sees it after its current step.`
          : `Subagent ${id} was woken up with your message. You will be notified when it delivers.`,
    };
  }

  /**
   * 对派发出去的子代理说话：运行中的排在当前步骤之后（steer）；已结束的唤醒它开新一轮（wake）。
   * quiet：唤醒后若只回 work done（交付没变），不回调派发者。
   */
  async tell(
    parentId: string,
    childId: string,
    msg: { steer: string; wake: string; quiet?: boolean },
  ): Promise<"steered" | "woken"> {
    const { pool, store, jobs } = this.deps;
    const id = jobs.byRef(childId)?.id ?? childId;
    if (store.get(childId)?.state === "running") {
      const child = pool.get(childId);
      if (!child) throw new SubagentError(`Subagent ${id} is not running.`);
      jobs.detached(() => child.notify(msg.steer, "steer"));
      return "steered";
    }
    // 唤醒同样检查存活上限；加载会话期间先占一个名额，免得并发的几次唤醒一起冲过上限。
    const root = store.rootOf(parentId);
    this.checkAlive(parentId, root);
    this.reserve(parentId, root, 1);
    let child: Awaited<ReturnType<typeof pool.acquire>>;
    try {
      child = await pool.acquire(childId);
    } finally {
      this.reserve(parentId, root, -1);
    }
    if (!child) throw new SubagentError(`Subagent ${id} no longer exists.`);
    if (!store.reopen(childId)) {
      // 加载期间另一条消息抢先唤醒了它：这一条跟着当前步骤送进去
      jobs.detached(() => child.notify(msg.steer, "steer"));
      return "steered";
    }
    const handle = jobs.reopen(id);
    if (!handle)
      throw new SubagentError(`Subagent ${id} could not be reopened.`);
    this.startRound(childId, handle, true, msg.quiet === true);
    this.flowsChanged(childId);
    jobs.detached(() => child.notify(msg.wake, "followUp"));
    return "woken";
  }

  // 用户在子代理自己的标签里点了停止：走任务的停止，这样链式停止与回调给派发者都是同一条路。
  private userStopped(childId: string): void {
    const job = this.deps.jobs.byRef(childId);
    if (!job || job.state !== "running" || this.stopping.has(childId)) return;
    this.userStop.add(childId);
    void this.deps.jobs.stop(job.sessionId, job.id, "user").catch(() => {});
  }

  // 任务被停止（job_stop、用户停止、父被删除）：停子会话，名下的任务由池的 onStop 接着停。
  private async stopChild(childId: string): Promise<void> {
    if (this.stopping.has(childId)) return;
    this.stopping.add(childId);
    try {
      if (!this.userStop.delete(childId))
        await this.deps.pool
          .get(childId)
          ?.stop()
          .catch(() => {});
    } finally {
      this.finishRound(childId, { kind: "stopped" });
      this.stopping.delete(childId);
    }
  }

  // 子会话状态变了：通知它所有祖先会话的订阅者重新拉 flows（只带变化的执行体 id）。
  private flowsChanged(childId: string): void {
    const { store, pool } = this.deps;
    for (let row = store.get(childId); row; row = store.get(row.parentId))
      pool.get(row.parentId)?.publish("flows.updated", { changed: [childId] });
  }
}
