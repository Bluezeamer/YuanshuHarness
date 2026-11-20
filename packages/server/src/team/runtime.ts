// 团队运行时（team.md）：成员就是子代理（派发、限额、协作区、链式停止、交付全部沿用 subagent/），
// 这里只加花名册、成员间消息与公告板。
import {
  type ChangeTracker,
  relOf,
  type TurnChangeSet,
} from "../changes/tracker.js";
import type { ExecEnv } from "../env/types.js";
import type { JobManager } from "../job/manager.js";
import type { SessionPool } from "../session/pool.js";
import type { SubagentStore } from "../store/subagents.js";
import {
  type MemberRow,
  type TeamStore,
  teamChangeKey,
} from "../store/teams.js";
import type { CollabArea } from "../subagent/collab.js";
import { SUBAGENT_LIMITS } from "../subagent/limits.js";
import type {
  MemberHooks,
  SpawnCall,
  SubagentRuntime,
  ToolText,
} from "../subagent/runtime.js";
import {
  appendEntry,
  archiveBoard,
  readBoard,
  recentEntries,
} from "./board.js";
import {
  announcementText,
  createdText,
  memberBrief,
  privateText,
} from "./messages.js";

/** 信息直接给模型看。 */
export class TeamError extends Error {}

export const TEAM_LIMITS = {
  /** 一条公告或私信的字符上限：板子应当简短，细节放文件 */
  postMax: 4000,
  /** 板子摘要不可用时附上的最近原文条数 */
  rawEntries: 20,
  /** team_diff 单个文件的 diff 字符上限 */
  diffMax: 60_000,
} as const;

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export interface MemberInput {
  name: string;
  agent?: string;
  task: string;
  context?: "fresh" | "fork";
}

interface Role {
  leadId: string;
  /** 署名：lead 固定叫 lead */
  name: string;
  /** 成员的会话 id；lead 为 null */
  childId: string | null;
}

export interface TeamDeps {
  pool: SessionPool;
  rt: SubagentRuntime;
  teams: TeamStore;
  subagents: SubagentStore;
  jobs: JobManager;
  collab: CollabArea;
  /** 板子摘要（辅助模型）；缺省或失败时附最近的原文 */
  summarize?: (leadId: string, board: string) => Promise<string>;
  /** 团队整体改动：建队时拍基线，team_diff 对比当前；缺省时没有 team_diff */
  changes?: {
    tracker: ChangeTracker;
    /** 团队所在 directory 的环境与根目录 */
    context: (directoryId: string) => { env: ExecEnv; root: string } | null;
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** 运行时借它给团队成员改文案、把交付记进公告板 */
export function memberHooks(teams: TeamStore, collab: CollabArea): MemberHooks {
  return {
    nameOf: (childId) => teams.member(childId)?.name ?? null,
    delivered: (childId, name, summary, report) => {
      const m = teams.member(childId);
      if (!m) return;
      appendEntry(
        collab.boardPath(m.leadId),
        teams.nextSeq(m.leadId),
        name,
        "all",
        `Delivered: ${summary}${report ? `\nReport: host="collab", path="${collab.virtualPath(m.leadId, report.path)}"` : ""}`,
      );
    },
  };
}

export class TeamRuntime {
  constructor(private readonly deps: TeamDeps) {}

  /** 会话是否有 post 工具：lead 有队，或自己是成员 */
  canPost(id: string): boolean {
    return (
      this.deps.teams.get(id) !== undefined ||
      this.deps.teams.member(id) !== undefined
    );
  }

  private role(id: string): Role | null {
    const { teams } = this.deps;
    if (teams.get(id)) return { leadId: id, name: "lead", childId: null };
    const m = teams.member(id);
    return m ? { leadId: m.leadId, name: m.name, childId: id } : null;
  }

  // 只有根会话（与用户对话的那个）能管团队；成员也是子代理，不能再建队。
  private requireLead(id: string): void {
    if (this.deps.subagents.get(id))
      throw new TeamError(
        "Only the session the user talks to (the lead) can manage a team; you are a subagent.",
      );
  }

  private teamOf(leadId: string) {
    this.requireLead(leadId);
    const team = this.deps.teams.get(leadId);
    if (!team)
      throw new TeamError("You have no team. Create one with team_create.");
    return team;
  }

  private checkMembers(
    list: MemberInput[],
    taken: Set<string>,
    leadId: string,
  ): (MemberInput & { agentId: string; agentName: string })[] {
    const lead = this.deps.pool.get(leadId);
    if (!lead) throw new TeamError("The session is not available.");
    const seen = new Set(taken);
    return list.map((m) => {
      const name = m.name.trim();
      if (!NAME_RE.test(name))
        throw new TeamError(
          `Member name "${m.name}" is not valid: start with a letter, then letters, digits, "-" or "_", at most 32 characters.`,
        );
      const key = name.toLowerCase();
      if (key === "lead" || key === "all" || seen.has(key))
        throw new TeamError(
          `Member name "${name}" is reserved or already used in this team.`,
        );
      seen.add(key);
      const task = m.task.trim();
      if (task === "") throw new TeamError(`The task of ${name} is empty.`);
      if (task.length > SUBAGENT_LIMITS.taskMax)
        throw new TeamError(
          `The task of ${name} is longer than ${SUBAGENT_LIMITS.taskMax} characters.`,
        );
      if (m.context === "fork" && m.agent !== undefined)
        throw new TeamError(
          `Member ${name}: with context "fork" the member uses your own Agent; do not set agent.`,
        );
      const preset = this.deps.rt.resolvePreset(m.agent, lead);
      return {
        ...m,
        name,
        task,
        agentId: preset.id,
        agentName: preset.name,
      };
    });
  }

  // 启动一批成员：登记花名册后立即返回，不等交付。
  private async launch(
    leadId: string,
    members: ReturnType<TeamRuntime["checkMembers"]>,
    board: string,
    call: SpawnCall,
  ): Promise<void> {
    const { teams, rt } = this.deps;
    const text = readBoard(board);
    for (const m of members)
      await rt.launch(
        leadId,
        {
          task: m.task,
          ...(m.context === "fork" ? { context: "fork" as const } : {}),
          ...(m.context !== "fork" && m.agent !== undefined
            ? { agent: m.agentId }
            : {}),
        },
        call,
        {
          kind: "member",
          member: {
            name: m.name,
            onCreated: (childId) =>
              teams.addMember({
                childId,
                leadId,
                name: m.name,
                agentName: m.agentName,
              }),
            brief: (ctx) => memberBrief({ name: m.name, board: text, ctx }),
          },
        },
      );
  }

  async create(
    leadId: string,
    input: { members: MemberInput[]; note?: string },
    call: SpawnCall,
  ): Promise<ToolText> {
    const { pool, rt, teams, collab } = this.deps;
    this.requireLead(leadId);
    const lead = pool.get(leadId);
    if (!lead) throw new TeamError("The session is not available.");
    if (teams.get(leadId))
      throw new TeamError(
        "You already have a team. Add members with team_update, or end it with team_disband first.",
      );
    if (input.members.length === 0)
      throw new TeamError("A team needs at least one member.");
    const note = input.note?.trim() ?? "";
    if (note.length > TEAM_LIMITS.postMax)
      throw new TeamError(
        `note is longer than ${TEAM_LIMITS.postMax} characters.`,
      );
    const members = this.checkMembers(input.members, new Set(), leadId);
    rt.ensureRoom(leadId, members.length);

    // 先占住队伍：上面的检查与这一步之间没有 await，并行的第二次 team_create 过不了检查
    teams.create(leadId, lead.directoryId);
    const board = collab.boardPath(leadId);
    try {
      // 基线要在任何成员动手之前拍好
      await this.baseline(leadId, lead.directoryId);

      // 建队时一次性写好首批公告：全员看到全局，各自只做自己那份。
      archiveBoard(board);
      const post = (text: string) =>
        appendEntry(board, teams.nextSeq(leadId), "lead", "all", text);
      if (note) post(note);
      for (const m of members)
        post(`Task for ${m.name} (agent: ${m.agentName}):\n${m.task}`);

      await this.launch(leadId, members, board, call);
    } catch (err) {
      await this.disband(leadId).catch(() => {});
      throw err;
    }
    return {
      text: createdText(members.map((m) => m.name)),
    };
  }

  async update(
    leadId: string,
    input: { add?: MemberInput[]; remove?: string[] },
    call: SpawnCall,
  ): Promise<ToolText> {
    const { rt, teams, subagents, collab } = this.deps;
    this.teamOf(leadId);
    const roster = teams.members(leadId);
    const add = input.add ?? [];
    const remove = input.remove ?? [];
    if (add.length === 0 && remove.length === 0)
      throw new TeamError("Nothing to do: give add and/or remove.");
    // 先整批校验，再动手：减人只能减没在运行的
    const gone = remove.map((n) => {
      const m = teams.memberByName(leadId, n);
      if (!m)
        throw new TeamError(
          `There is no member named "${n}". Members: ${roster.map((r) => r.name).join(", ") || "(none)"}.`,
        );
      if (subagents.get(m.childId)?.state === "running")
        throw new TeamError(
          `Member ${m.name} is running. Stop it with team_stop { "member": "${m.name}" } first; only members that are not running can be removed.`,
        );
      return m;
    });
    const taken = new Set(
      roster.filter((r) => !gone.includes(r)).map((r) => r.name.toLowerCase()),
    );
    const members = this.checkMembers(add, taken, leadId);
    if (members.length > 0) rt.ensureRoom(leadId, members.length);

    for (const m of gone) teams.removeMember(m.childId);
    const board = collab.boardPath(leadId);
    if (members.length > 0) {
      const existing = teams.members(leadId);
      const lines = members.map(
        (m) => `${m.name} (agent: ${m.agentName})\n${m.task}`,
      );
      const seq = teams.nextSeq(leadId);
      const text = `New member${members.length === 1 ? "" : "s"} joined:\n${lines.join("\n\n")}`;
      appendEntry(board, seq, "lead", "all", text);
      // 先启动新成员再通知旧的：旧成员被唤醒也占存活名额，先唤醒会让后面的新成员放不下；
      // 新成员的开场说明里已含这条公告
      await this.launch(leadId, members, board, call);
      await this.pushTo(
        existing,
        leadId,
        { leadId, name: "lead", childId: null },
        (wake) => announcementText(seq, "lead", text, wake),
      );
    }
    const parts: string[] = [];
    if (members.length > 0)
      parts.push(`Added: ${members.map((m) => m.name).join(", ")}.`);
    if (gone.length > 0)
      parts.push(`Removed: ${gone.map((m) => m.name).join(", ")}.`);
    return { text: parts.join(" ") };
  }

  private async stopMembers(
    leadId: string,
    only?: MemberRow,
  ): Promise<string[]> {
    const { teams, jobs } = this.deps;
    const stopped: string[] = [];
    for (const m of only ? [only] : teams.members(leadId)) {
      const job = jobs.byRef(m.childId);
      if (!job || job.state !== "running") continue;
      await jobs.stop(leadId, job.id, "owner");
      stopped.push(m.name);
    }
    return stopped;
  }

  async stop(leadId: string, member?: string): Promise<ToolText> {
    const { teams } = this.deps;
    this.teamOf(leadId);
    if (member === undefined) {
      const stopped = await this.stopMembers(leadId);
      return {
        text:
          stopped.length === 0
            ? "No member was running."
            : `Stopped: ${stopped.join(", ")}. Their background jobs and subagents were stopped too.`,
      };
    }
    const m = teams.memberByName(leadId, member);
    if (!m)
      throw new TeamError(
        `There is no member named "${member}". Members: ${
          teams
            .members(leadId)
            .map((r) => r.name)
            .join(", ") || "(none)"
        }.`,
      );
    const stopped = await this.stopMembers(leadId, m);
    return {
      text:
        stopped.length === 0
          ? `Member ${m.name} is not running.`
          : `Stopped ${m.name}. Its background jobs and subagents were stopped too. It stays on the roster; post to it to wake it up.`,
    };
  }

  async disband(leadId: string): Promise<ToolText> {
    this.teamOf(leadId);
    const stopped = await this.stopMembers(leadId);
    this.deps.teams.removeTeam(leadId);
    this.deps.changes?.tracker.forget(teamChangeKey(leadId));
    return {
      text: `Team disbanded${stopped.length > 0 ? `; stopped: ${stopped.join(", ")}` : ""}. The board and the members' folders stay readable in the shared folder.`,
    };
  }

  private async baseline(leadId: string, directoryId: string): Promise<void> {
    const c = this.deps.changes;
    const ctx = c?.context(directoryId);
    if (!c || !ctx) return;
    const key = teamChangeKey(leadId);
    c.tracker.forget(key);
    // 拍不到基线（比如 git 命令失败）就退回只记 write / edit 的写入，不阻止建队
    await c.tracker.begin(key, ctx.env, ctx.root).catch(() => {});
  }

  // 团队目录的环境与追踪键；目录不可用（或没开改动追踪）时抛给调用方
  private target(leadId: string) {
    const team = this.teamOf(leadId);
    const c = this.deps.changes;
    const ctx = c?.context(team.directoryId);
    if (!c || !ctx)
      throw new TeamError("The team's directory is not available for diffing.");
    return {
      tracker: c.tracker,
      env: ctx.env,
      root: ctx.root,
      key: teamChangeKey(leadId),
    };
  }

  /** 建队以来改动的文件清单（team_diff 不带路径，也给界面） */
  async changeSet(leadId: string): Promise<TurnChangeSet> {
    const t = this.target(leadId);
    return t.tracker.finish(t.key, t.env);
  }

  /** 单个文件建队以来的 diff：路径相对团队目录，绝对路径要在目录里；没有改动时 diff 为 null */
  async fileDiff(
    leadId: string,
    path: string,
  ): Promise<{ rel: string; diff: string | null }> {
    const t = this.target(leadId);
    const rel = path.startsWith("/") ? relOf(t.root, path) : path;
    if (rel === null || rel.split("/").includes(".."))
      throw new TeamError("path must be inside the team's directory.");
    return { rel, diff: await t.tracker.diff(t.key, t.env, rel) };
  }

  /**
   * team_diff：不带路径列出建队以来改动的文件，带路径看单个文件的 diff。
   * git 目录用建队时的目录树对比，连 bash 的改动也看得到；非 git 目录只看得到 write / edit 的。
   */
  async diff(leadId: string, path?: string): Promise<ToolText> {
    if (path === undefined) {
      const set = await this.changeSet(leadId);
      if (set.files.length === 0)
        return { text: "No changes since the team was created." };
      const sign = { added: "A", modified: "M", deleted: "D" } as const;
      const lines = set.files.map(
        (f) => `${sign[f.status]} ${f.path} (+${f.added} -${f.removed})`,
      );
      return {
        text: `Changes since the team was created (${set.mode === "git" ? "git: includes changes made by shell commands" : "not a git repository: only changes made with the write and edit tools are visible"}):\n${lines.join("\n")}${set.total > lines.length ? `\n… and ${set.total - lines.length} more files` : ""}\nCall team_diff with path to see one file's diff.`,
      };
    }
    const { rel, diff: d } = await this.fileDiff(leadId, path);
    if (d === null || d.trim() === "")
      return { text: `No changes to ${rel} since the team was created.` };
    return {
      text:
        d.length > TEAM_LIMITS.diffMax
          ? `${d.slice(0, TEAM_LIMITS.diffMax)}\n… diff truncated`
          : d,
    };
  }

  private memberLine(m: MemberRow): string {
    const { subagents, jobs } = this.deps;
    const row = subagents.get(m.childId);
    const head = `- ${m.name} (agent: ${m.agentName}):`;
    switch (row?.state) {
      case "running": {
        const job = jobs.byRef(m.childId);
        const last = job ? jobs.tail(job.id, 1) : "";
        return `${head} running${last ? `; latest action: ${clip(oneLine(last), 160)}` : ""}`;
      }
      case "done":
        return `${head} delivered: ${clip(oneLine(row.result ?? ""), 300)}${row.report ? ` (report: ${row.report})` : ""}`;
      case "failed":
        return `${head} failed: ${clip(oneLine(row.result ?? ""), 300)}`;
      default:
        return `${head} stopped`;
    }
  }

  async status(leadId: string): Promise<ToolText> {
    const { teams, collab, summarize } = this.deps;
    this.teamOf(leadId);
    const roster = teams.members(leadId).map((m) => this.memberLine(m));
    const board = readBoard(collab.boardPath(leadId));
    let summary: string;
    if (board.trim() === "") summary = "(the board is empty)";
    else {
      let s: string | null = null;
      if (summarize) s = await summarize(leadId, board).catch(() => null);
      summary =
        s !== null && s.trim() !== ""
          ? s.trim()
          : `Summary unavailable; the ${TEAM_LIMITS.rawEntries} most recent entries:\n${recentEntries(board, TEAM_LIMITS.rawEntries)}`;
    }
    return {
      text: `Members:\n${roster.join("\n") || "(none)"}\n\nBoard (host="collab", path="/board.md"):\n${summary}`,
    };
  }

  // 把一条消息推给指定的成员：运行中的在下一步前收到，已交付的被唤醒；停止与失败的不被公告唤醒。
  private async pushTo(
    targets: MemberRow[],
    leadId: string,
    from: Role,
    textFor: (wake: boolean) => string,
  ): Promise<{ notified: string[]; skipped: string[] }> {
    const { rt, subagents } = this.deps;
    const notified: string[] = [];
    const skipped: string[] = [];
    for (const m of targets) {
      if (m.childId === from.childId) continue;
      const state = subagents.get(m.childId)?.state;
      if (state !== "running" && state !== "done") {
        skipped.push(
          `${m.name} (${state === "failed" ? "failed" : "stopped"})`,
        );
        continue;
      }
      try {
        // 公告引起的唤醒不回调 lead：lead 只在自己需要时读板子
        await rt.tell(leadId, m.childId, {
          steer: textFor(false),
          wake: textFor(true),
          quiet: true,
        });
        notified.push(m.name);
      } catch (e) {
        skipped.push(
          `${m.name} (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
    return { notified, skipped };
  }

  /** post：不写 to 是公告（进板子，推给其他成员，不推 lead）；写 to 是私信（不进板子）。 */
  async post(
    senderId: string,
    input: { text: string; to?: string },
  ): Promise<ToolText> {
    const { pool, rt, teams, collab, jobs } = this.deps;
    const role = this.role(senderId);
    if (!role)
      throw new TeamError(
        "You are not part of a team, so there is nobody to post to.",
      );
    const text = input.text.trim();
    if (text === "") throw new TeamError("text cannot be empty.");
    if (text.length > TEAM_LIMITS.postMax)
      throw new TeamError(
        `text is ${text.length} characters; the limit is ${TEAM_LIMITS.postMax}. Put the long content in a file and post a short pointer to it.`,
      );
    const { leadId } = role;
    const to = input.to?.trim();

    if (to === undefined || to === "") {
      const seq = teams.nextSeq(leadId);
      appendEntry(collab.boardPath(leadId), seq, role.name, "all", text);
      const { notified, skipped } = await this.pushTo(
        teams.members(leadId),
        leadId,
        role,
        (wake) => announcementText(seq, role.name, text, wake),
      );
      return {
        text: `Announcement #${seq} is on the board.${
          notified.length > 0 ? ` Notified: ${notified.join(", ")}.` : ""
        }${
          skipped.length > 0
            ? ` Not notified: ${skipped.join(", ")}; they will see the board when they next run.`
            : ""
        }`,
      };
    }

    if (to.toLowerCase() === "lead") {
      if (role.childId === null) throw new TeamError("You are the lead.");
      const lead = pool.get(leadId);
      if (!lead) throw new TeamError("The lead session is not available.");
      jobs.detached(() =>
        lead.notify(privateText(role.name, text, false), "steer"),
      );
      return { text: "Message sent to the lead." };
    }

    const m = teams.memberByName(leadId, to);
    if (!m)
      throw new TeamError(
        `There is no team member named "${to}". Members: ${
          teams
            .members(leadId)
            .map((r) => r.name)
            .join(", ") || "(none)"
        }; the lead is "lead".`,
      );
    if (m.childId === role.childId)
      throw new TeamError("You cannot message yourself.");
    const how = await rt.tell(leadId, m.childId, {
      steer: privateText(role.name, text, false),
      wake: privateText(role.name, text, true),
      // 成员之间的私信不该让 lead 收到「交付没变」
      quiet: role.childId !== null,
    });
    return {
      text:
        how === "steered"
          ? `Message sent to ${m.name}.`
          : `Message sent to ${m.name}; it was idle and has been woken.`,
    };
  }
}
