import { HttpError } from "../lib/http-error.js";
import type { IndexRow, Lifecycle } from "../store/sessions.js";
import type { SessionInfo, SessionPool } from "./pool.js";

export const TITLE_MAX = 48;
const UNTITLED = "新对话";
const FORK_MARK = " · 分支";

export const STATUSES = ["running", "idle", "blocked", "archived"] as const;
export type SessionStatus = (typeof STATUSES)[number];

// 对外的会话实体：SessionInfo 的全部旧字段原样保留，再叠加会话库元数据。
export interface SessionView extends SessionInfo {
  title: string;
  // 展示编号 "#0042"；子会话等尚未进索引的会话为 null。
  no: string | null;
  status: SessionStatus;
  lifecycle: Lifecycle;
  // 工作区取池内的（新建会话索引行可能还没落库）；派生的父子关系与标记取索引行。
  workspaceId: string | null;
  parentSessionId: string | null;
  forkEntryId: string | null;
  unreadResult: boolean;
  unreadError: boolean;
  pinned: boolean;
}

type LibraryErrorCode =
  | "bad_request"
  | "not_found"
  | "session_running"
  | "not_archived";

const LIBRARY_STATUS: Record<LibraryErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  session_running: 409,
  not_archived: 409,
};

export class LibraryError extends HttpError {
  constructor(
    readonly code: LibraryErrorCode,
    message: string = code,
  ) {
    super(code, message, LIBRARY_STATUS[code]);
  }
}

export interface ListQuery {
  status?: string;
  q?: string;
}

export interface PatchBody {
  title?: unknown;
  name?: unknown;
  pinned?: unknown;
}

const formatNo = (n: number | null | undefined): string | null =>
  n == null ? null : `#${String(n).padStart(4, "0")}`;

/** 会话的显示名：手动名优先，否则取首条用户消息的种子，再没有就是「新对话」。 */
export const sessionTitle = (
  info: Pick<SessionInfo, "name" | "preview">,
): string => info.name ?? info.preview ?? UNTITLED;

// 会话库：在 pool（运行时状态、JSONL）与索引表（元数据）之上组出对外的会话实体与动作。
// title 是显示名：手动名优先，否则取首条用户消息的种子，再没有就是「新对话」。
export class SessionLibrary {
  constructor(
    private readonly pool: SessionPool,
    private readonly hooks: { onArchived?: (id: string) => void } = {},
  ) {}

  private get store() {
    return this.pool.store;
  }

  private titleOf(info: SessionInfo): string {
    return sessionTitle(info);
  }

  // active 的会话按 agentloop 是否在跑分 running / idle；有待答复的弹窗则是 blocked。
  private statusOf(id: string, lifecycle: Lifecycle): SessionStatus {
    if (lifecycle !== "active") return lifecycle;
    const blocked = (this.pool.get(id)?.prompts.list().length ?? 0) > 0;
    if (blocked) return "blocked";
    // 名下有在跑的子代理（含工作流 agent）也算执行中：后台任务与命令不算。
    if (this.pool.info(id)?.running || this.pool.hasRunningInTree(id))
      return "running";
    return "idle";
  }

  private view(info: SessionInfo, row: IndexRow | undefined): SessionView {
    const lifecycle = row?.lifecycle ?? "active";
    return {
      ...info,
      title: this.titleOf(info),
      no: formatNo(row?.seqNo ?? this.pool.get(info.id)?.seqNo),
      status: this.statusOf(info.id, lifecycle),
      lifecycle,
      workspaceId: this.pool.workspaceIdOf(info.id),
      parentSessionId: row?.parentSessionId ?? null,
      forkEntryId: row?.forkEntryId ?? null,
      unreadResult: row?.unreadResult === true,
      unreadError: row?.unreadError === true,
      pinned: row?.pinned === true,
    };
  }

  get(id: string): SessionView | null {
    const info = this.pool.info(id);
    return info ? this.view(info, this.store.get(id)) : null;
  }

  list(query: ListQuery = {}): SessionView[] {
    let statuses: Set<string> | null = null;
    if (query.status !== undefined && query.status !== "") {
      statuses = new Set(query.status.split(",").map((s) => s.trim()));
      for (const s of statuses)
        if (!(STATUSES as readonly string[]).includes(s))
          throw new LibraryError("bad_request", `未知的 status：${s}`);
    }
    const q = query.q?.trim().toLowerCase() ?? "";
    const rows = new Map(this.store.list().map((r) => [r.id, r]));
    return this.pool
      .list()
      .filter((info) => !this.pool.isChild(info.id))
      .map((info) => this.view(info, rows.get(info.id)))
      .filter((v) => {
        if (statuses && !statuses.has(v.status)) return false;
        return q === "" || matches(v, q);
      })
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
  }

  // 元数据要有索引行才能落库；池内尚未持久化的会话（如子会话）在此补建。
  private ensureIndexed(info: SessionInfo): void {
    if (this.store.get(info.id)) return;
    this.store.upsert({
      id: info.id,
      name: info.name,
      preview: info.preview,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      directoryId: info.directoryId,
      promptPresetId: info.promptPresetId,
      modePresetIds: info.modePresetIds,
      activeModeId: info.activeModeId,
      // 池内会话已经绑好工作区：补建索引行时一并落库，不留下无工作区的行。
      workspaceId: this.pool.workspaceIdOf(info.id),
      seqNo: this.pool.get(info.id)?.seqNo ?? null,
    });
  }

  private require(id: string): SessionInfo {
    const info = this.pool.info(id);
    if (!info) throw new LibraryError("not_found");
    return info;
  }

  // 先校验再改：多个字段同时给时任一非法都不产生部分修改。title 与旧入参 name 是同一件事，title 优先。
  async patch(id: string, body: PatchBody): Promise<SessionView> {
    const { title, name, pinned } = body;
    if ([title, name, pinned].every((v) => v === undefined))
      throw new LibraryError("bad_request", "没有可修改的字段");
    if (title !== undefined) {
      const t = typeof title === "string" ? title.trim() : "";
      if (t.length < 1 || t.length > TITLE_MAX)
        throw new LibraryError(
          "bad_request",
          `title 需要 1 到 ${TITLE_MAX} 个字符`,
        );
    }
    if (name !== undefined && typeof name !== "string")
      throw new LibraryError("bad_request", "name 必须是字符串");
    if (pinned !== undefined && typeof pinned !== "boolean")
      throw new LibraryError("bad_request", "pinned 必须是布尔");

    const info = this.require(id);
    const newName = title ?? name;
    if (typeof newName === "string") await this.pool.rename(id, newName);
    if (pinned !== undefined) {
      this.ensureIndexed(info);
      this.store.setPinned(id, pinned);
    }
    // 改名走池已推过一次；置顶是直改库，这里统一补一次（重复的由去重挡掉）。
    this.pool.touch(id);
    const out = this.get(id);
    if (!out) throw new LibraryError("not_found");
    return out;
  }

  private setLifecycle(id: string, lifecycle: Lifecycle): SessionView {
    this.ensureIndexed(this.require(id));
    this.store.setLifecycle(id, lifecycle);
    this.pool.touch(id);
    return this.get(id) as SessionView;
  }

  private lifecycleOf(id: string): Lifecycle {
    this.require(id);
    return this.store.get(id)?.lifecycle ?? "active";
  }

  // 运行中不能归档；已归档再归档是幂等的。
  archive(id: string): SessionView {
    this.require(id);
    if (this.pool.get(id)?.busy) throw new LibraryError("session_running");
    const view = this.setLifecycle(id, "archived");
    this.hooks.onArchived?.(id);
    return view;
  }

  // 取消归档直接回 active；agentloop 没跑时对外就是 idle。
  unarchive(id: string): SessionView {
    if (this.lifecycleOf(id) !== "archived")
      throw new LibraryError("not_archived");
    return this.setLifecycle(id, "active");
  }

  // 刷新上下文：原地。历史、配置、模式都不动，只重读约定文件、技能、MCP 并重建前缀（缓存失效）；运行中不动。
  async refreshContext(id: string): Promise<SessionView> {
    this.require(id);
    const r = await this.pool.refreshContext(id);
    if (r === "busy") throw new LibraryError("session_running");
    if (r === "not_found") throw new LibraryError("not_found");
    return this.get(id) as SessionView;
  }

  // P09 复制会话分叉：标题 = 「父名 · 分支N」，N = 该父会话已有派生数 + 1。
  async fork(
    id: string,
    entryId: string,
  ): Promise<{ id: string; title: string }> {
    const src = this.require(id);
    const suffix = `${FORK_MARK}${this.store.forkCount(id) + 1}`;
    const base = this.titleOf(src).slice(0, TITLE_MAX - suffix.length);
    const title = `${base}${suffix}`;
    const created = await this.pool.fork(id, entryId, title);
    this.pool.touch(created.id);
    return { id: created.id, title: created.name ?? title };
  }
}

// 搜 title / name / 编号 / 提示词预设；编号按数字部分匹配，"#42" 与 "42" 都能命中 "#0042"。
function matches(v: SessionView, q: string): boolean {
  if (
    [v.title, v.name ?? "", v.promptPresetId ?? ""].some((s) =>
      s.toLowerCase().includes(q),
    )
  )
    return true;
  const digits = q.replace(/^#/, "");
  return v.no !== null && digits !== "" && v.no.slice(1).includes(digits);
}
