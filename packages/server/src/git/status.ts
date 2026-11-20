// Git 面板用的 git 服务：仓库状态、本地分支列表、单文件 HEAD/工作区对比、切换分支。
// 只依赖 ExecEnv（ADR-0034），本机与 ssh 环境共用同一份实现；只读命令失败一律折算成「空状态」，不抛错。
// 写操作（checkout）与只读接口的区别：失败必须让调用方知道原因，所以抛 GitError 由 API 折算成状态码。
import path from "node:path";
import type { ExecEnv } from "../env/types.js";

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

/** path 相对仓库根，统一用 / 分隔 */
export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
}

export interface GitStatus {
  /** 仓库根绝对路径；不是 git 仓库时为 null */
  root: string | null;
  /** 当前分支名；detached HEAD 时是 "HEAD" */
  branch: string | null;
  detached: boolean;
  entries: GitStatusEntry[];
  /** 超过上限被截断 */
  truncated: boolean;
}

/** 本地分支列表与当前分支。 */
export interface GitBranches {
  /** 仓库根绝对路径；不是 git 仓库时为 null */
  root: string | null;
  /** 当前分支名；detached HEAD 时是短哈希 */
  current: string | null;
  detached: boolean;
  /** 本地分支名，按名字排序 */
  locals: string[];
}

/** 单文件在 HEAD 与工作区两侧的内容。 */
export interface GitFileContent {
  /** 仓库根绝对路径；不是 git 仓库时为 null */
  root: string | null;
  /** 文件相对仓库根，统一用 / 分隔 */
  rel: string;
  /** HEAD 里的内容；未跟踪或命令失败为 null，二进制时为空串 */
  original: string | null;
  /** 目录内容；读不到、二进制时为空串 */
  current: string;
  binary: boolean;
  /** 任一侧超过上限被截断 */
  truncated: boolean;
}

/** 工作区有改动时怎么处理。 */
export type GitDirtyMode = "stash" | "carry" | "abort";

export type GitErrorKind =
  | "not_repo"
  | "dirty"
  | "checkout_failed"
  /** 命令跑不起来：超时、连接断开 */
  | "env_unreachable";

/** 带状态码的失败原因，API 层原样折算成 `{ kind, message }`。 */
export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * 分支名白名单。命令是拼字符串交给 shell 执行的，所以挡掉参数注入的可能：
 * 只允许 `[A-Za-z0-9._/-]`，且不接受 `..`（路径穿越）与 `-` 开头（会被当成选项）。
 */
export function isValidBranch(name: string): boolean {
  if (name === "" || name.startsWith("-") || name.includes("..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

const DEFAULT_TTL_MS = 1500;
const DEFAULT_MAX_ENTRIES = 5000;
/** 单条命令超时（秒）。 */
const TIMEOUT_S = 5;
/** 输出累计上限：大仓库 untracked 很多时防止把 Server 内存撑爆。 */
const OUTPUT_CAP = 4 * 1024 * 1024;
/** 单文件内容上限：diff 面板只用来看着改，整份大文件传回前端只会把它拖死。 */
const MAX_FILE_BYTES = 1024 * 1024;
/** stash 时留的说明，方便用户之后认领这次自动暂存。 */
const STASH_MESSAGE = "yuanshu: 切换分支前暂存";

/** 双字母状态里表示冲突的组合（双方都改了/都删了/未合并等）。 */
const CONFLICTS = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const empty = (root: string | null): GitStatus => ({
  root,
  branch: null,
  detached: false,
  entries: [],
  truncated: false,
});

const classify = (xy: string): GitFileStatus => {
  if (xy === "??") return "untracked";
  if (CONFLICTS.has(xy)) return "conflict";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
};

/**
 * 解析 `git status --porcelain=v1 -z` 的输出。
 *
 * - 记录以 NUL 分隔，每条记录形如 `XY<空格>PATH`（X 是暂存区状态，Y 是工作区状态）。
 * - rename/copy 记录（含 R 或 C）后面**紧跟一条原路径记录**（只有路径、没有 XY 前缀），
 *   必须跳过它，否则原路径会被当成一条独立条目。`-z` 下是先新路径、后原路径。
 * - `!!` 是被忽略的文件，不产生条目。
 * - 文件名去掉可能的前导/尾随空白（`-z` 本身不做引号转义，这里只处理空白）。
 */
export function parsePorcelain(out: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // 末尾的 NUL 会切出空串；太短的记录也和格式不符
    if (rec === undefined || rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3).trim();
    // rename/copy：下一条记录是被改名的原路径，跳过
    if (xy.includes("R") || xy.includes("C")) i++;
    if (xy === "!!") continue;
    if (p === "") continue;
    entries.push({ path: p, status: classify(xy) });
  }
  return entries;
}

export interface GitStatusDeps {
  /** 缓存有效期，默认 1500ms */
  ttlMs?: number;
  /** 条目上限，默认 5000，超了就 truncated */
  maxEntries?: number;
}

interface RunResult {
  code: number;
  out: string;
  /** 原始字节：文件接口要按 NUL 判二进制、按上限截断，转成字符串就晚了。 */
  bytes: Buffer;
  /** 输出超过 OUTPUT_CAP 被截掉了一部分 */
  capped: boolean;
}

/** 命令输出转成字符串时会丢掉「截断」这个信息，所以两侧都带上。 */
const text = (bytes: Buffer): string => bytes.toString("utf8");

export class GitStatusService {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  /** 键是 (env.id, 仓库根, 用途)：同一环境的同一仓库共用一个缓存。 */
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  /** 同键的在途请求：并发调用只跑一次命令。 */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(deps: GitStatusDeps = {}) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** 读某个目录（或文件）所在仓库的状态；非 git 仓库返回 root 为 null 的空状态 */
  async status(env: ExecEnv, dirOrFile: string): Promise<GitStatus> {
    // 缓存键要用仓库根，所以每次都先 ask 一次根（rev-parse 很便宜）
    const root = await this.topLevel(env, dirOrFile);
    if (root === null) return empty(null);
    return this.memo(`${env.id}\0${root}\0status`, () => this.load(env, root));
  }

  /** 本地分支列表与当前分支；非 git 仓库返回 root 为 null 的空结果 */
  async branches(env: ExecEnv, dirOrFile: string): Promise<GitBranches> {
    const root = await this.topLevel(env, dirOrFile);
    if (root === null)
      return { root: null, current: null, detached: false, locals: [] };
    return this.memo(`${env.id}\0${root}\0branches`, () =>
      this.loadBranches(env, root),
    );
  }

  /**
   * 单文件在 HEAD 与工作区两侧的内容。
   * base 只用来找仓库根（面板传的是当前目录），文件本身由 file 给出。
   */
  async fileContent(
    env: ExecEnv,
    base: string,
    file: string,
  ): Promise<GitFileContent> {
    const emptyFile = (root: string | null): GitFileContent => ({
      root,
      rel: "",
      original: null,
      current: "",
      binary: false,
      truncated: false,
    });
    const root = await this.topLevel(env, base);
    if (root === null) return emptyFile(null);

    const p = this.pathOf(env);
    // git 只认 /，windows 环境要换掉分隔符
    const rel = p.relative(root, p.normalize(file)).split(p.sep).join("/");
    if (rel === "" || rel.startsWith("../")) return emptyFile(root);

    // 未跟踪的文件 `git show HEAD:<rel>` 会失败，original 就是 null。
    // OUTPUT_CAP 已经挡住了超大输出，这里只会拿到前几 MB。
    const shown = await this.runStrict(
      env,
      root,
      `git -C ${quote(root)} show ${quote(`HEAD:${rel}`)}`,
    );
    const originalBytes = shown.code === 0 ? shown.bytes : null;
    const work = await this.readWorkFile(env, file);

    const binary = hasNul(originalBytes) || hasNul(work.bytes);
    const truncated =
      work.truncated ||
      (originalBytes !== null &&
        (shown.capped || originalBytes.length > MAX_FILE_BYTES));
    return {
      root,
      rel,
      original: binary
        ? ""
        : originalBytes === null
          ? null
          : text(originalBytes.subarray(0, MAX_FILE_BYTES)),
      current: binary
        ? ""
        : text((work.bytes ?? Buffer.alloc(0)).subarray(0, MAX_FILE_BYTES)),
      binary,
      truncated,
    };
  }

  /**
   * 切换分支。dirty 表示工作区有改动时怎么办：abort 直接拒绝、stash 先暂存、carry 带着改动切。
   * branch 必须已通过 isValidBranch：命令是拼字符串执行的，不能在这里兜注入。
   */
  async checkout(
    env: ExecEnv,
    dirOrFile: string,
    branch: string,
    dirty: GitDirtyMode,
  ): Promise<{ root: string; branch: string }> {
    const root = await this.topLevel(env, dirOrFile);
    if (root === null) throw new GitError("not_repo", 409, "不是 git 仓库");
    const q = quote(root);

    const st = await this.runStrict(
      env,
      root,
      `git -C ${q} status --porcelain`,
    );
    if (st.code !== 0) throw fail("git status 失败", st);
    const isDirty = st.out.trim() !== "";
    if (isDirty && dirty === "abort")
      throw new GitError("dirty", 409, "工作区有未提交的改动");

    if (isDirty && dirty === "stash") {
      const stashed = await this.runStrict(
        env,
        root,
        `git -C ${q} stash push -u -m ${quote(STASH_MESSAGE)}`,
      );
      if (stashed.code !== 0) throw fail("暂存改动失败", stashed);
    }

    // carry 档到这里就是直接切：git 自己会因为冲突改动而拒绝，把它的报错交给前端
    const co = await this.runStrict(
      env,
      root,
      `git -C ${q} checkout ${quote(branch)}`,
    );
    if (co.code !== 0) throw fail("切换分支失败", co);

    // 分支名和状态都变了，缓存必须作废，否则面板会继续显示旧分支
    this.invalidate(env.id, root);
    return { root, branch };
  }

  /** 清空缓存（测试用） */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /** 丢掉某个仓库的全部缓存：checkout 之后状态与分支都变了。 */
  invalidate(envId: string, root: string): void {
    const prefix = `${envId}\0${root}\0`;
    for (const key of [...this.cache.keys()])
      if (key.startsWith(prefix)) this.cache.delete(key);
    for (const key of [...this.inflight.keys()])
      if (key.startsWith(prefix)) this.inflight.delete(key);
  }

  /**
   * 带 ttl 的缓存 + 在途合并：文件浏览器和 Git 面板会高频轮询，同一仓库不必反复跑命令。
   * 只缓存容器类结果（状态、分支列表），单个文件的内容每次现读——面板要看的就是实时内容。
   */
  private async memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs)
      return hit.value as T;
    const running = this.inflight.get(key);
    if (running !== undefined) return (await running) as T;

    const task = load()
      .then((value) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  /** 路径分隔符规则按目标环境的 os 走，ssh 环境不会误用 Server 本机的规则。 */
  private pathOf(env: ExecEnv): typeof path.posix {
    return env.os === "windows" ? path.win32 : path.posix;
  }

  /** 仓库根绝对路径；不是 git 仓库（或命令失败）返回 null。 */
  private async topLevel(
    env: ExecEnv,
    dirOrFile: string,
  ): Promise<string | null> {
    const dir = await this.resolveDir(env, dirOrFile);
    const top = await this.run(
      env,
      dir,
      `git -C ${quote(dir)} rev-parse --show-toplevel`,
    );
    const root = top?.code === 0 ? top.out.trim() : "";
    return root === "" ? null : root;
  }

  /**
   * dirOrFile 可能是文件：按 stat 取其父目录；stat 拿不到（不存在/无权）就按目录试。
   * 路径语义按目标环境的 os 走，ssh 环境不会误用 Server 本机的分隔符规则。
   */
  private async resolveDir(env: ExecEnv, dirOrFile: string): Promise<string> {
    const p = this.pathOf(env);
    const abs = p.isAbsolute(dirOrFile)
      ? p.normalize(dirOrFile)
      : p.resolve(dirOrFile);
    const st = await env.stat(abs).catch(() => null);
    return st?.isFile === true ? p.dirname(abs) : abs;
  }

  private async load(env: ExecEnv, root: string): Promise<GitStatus> {
    const q = quote(root);
    const { branch, detached } = await this.loadBranch(env, root, q);
    const st = await this.run(
      env,
      root,
      `git -C ${q} status --porcelain=v1 -z --untracked-files=all`,
    );
    const all = st?.code === 0 ? parsePorcelain(st.out) : [];
    const truncated = all.length > this.maxEntries;
    return {
      root,
      branch,
      detached,
      entries: truncated ? all.slice(0, this.maxEntries) : all,
      truncated,
    };
  }

  private async loadBranch(
    env: ExecEnv,
    root: string,
    q: string,
  ): Promise<{ branch: string | null; detached: boolean }> {
    const r = await this.run(
      env,
      root,
      `git -C ${q} rev-parse --abbrev-ref HEAD`,
    );
    const name = r?.code === 0 ? r.out.trim() : "";
    // detached HEAD 时 rev-parse 输出 "HEAD"
    if (name !== "") return { branch: name, detached: name === "HEAD" };
    // 还没有 commit 的新仓库里 rev-parse 会失败，退回读 HEAD 指向的分支名
    const sym = await this.run(
      env,
      root,
      `git -C ${q} symbolic-ref --short HEAD`,
    );
    const fallback = sym?.code === 0 ? sym.out.trim() : "";
    return { branch: fallback === "" ? null : fallback, detached: false };
  }

  /** 本地分支（按名字排序）+ 当前分支；detached 时当前分支退回短哈希。 */
  private async loadBranches(env: ExecEnv, root: string): Promise<GitBranches> {
    const q = quote(root);
    const refs = await this.runStrict(
      env,
      root,
      // format 必须自带引号：执行环境的 shell 会把未加引号的 %(…) 当成自己的语法
      `git -C ${q} for-each-ref --format=${quote("%(refname:short)")} refs/heads`,
    );
    const locals =
      refs.code === 0
        ? refs.out
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s !== "")
            .sort()
        : [];

    const sym = await this.runStrict(
      env,
      root,
      `git -C ${q} symbolic-ref --short HEAD`,
    );
    if (sym.code === 0) {
      const name = sym.out.trim();
      return {
        root,
        current: name === "" ? null : name,
        detached: false,
        locals,
      };
    }
    // detached HEAD 时 symbolic-ref 会失败，退回短哈希（此时没有「当前分支」可言）
    const rev = await this.runStrict(
      env,
      root,
      `git -C ${q} rev-parse --short HEAD`,
    );
    const sha = rev.code === 0 ? rev.out.trim() : "";
    return {
      root,
      current: sha === "" ? null : sha,
      detached: sha !== "",
      locals,
    };
  }

  /** 工作区当前内容；超过上限只读前 1MB，避免超大文件整份进内存。 */
  private async readWorkFile(
    env: ExecEnv,
    file: string,
  ): Promise<{ bytes: Buffer | null; truncated: boolean }> {
    try {
      const st = await env.stat(file);
      if (st === null || !st.isFile) return { bytes: null, truncated: false };
      if (st.size <= MAX_FILE_BYTES)
        return { bytes: await env.readFile(file), truncated: false };

      const stream = await env.readStream(file, {
        start: 0,
        end: MAX_FILE_BYTES - 1,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        chunks.push(buf);
        size += buf.length;
        if (size >= MAX_FILE_BYTES) break;
      }
      return {
        bytes: Buffer.concat(chunks).subarray(0, MAX_FILE_BYTES),
        truncated: true,
      };
    } catch {
      // 文件被删或不可读：当作空内容，前端按「只有 HEAD 侧」展示
      return { bytes: null, truncated: false };
    }
  }

  /** 只读命令用：非零退出与异常都退化成 null（不是仓库、环境不可达都算「没状态」）。 */
  private async run(
    env: ExecEnv,
    cwd: string,
    command: string,
  ): Promise<RunResult | null> {
    try {
      return await this.runStrict(env, cwd, command);
    } catch {
      return null;
    }
  }

  /**
   * stdout 与 stderr 合并送到 onData，所以自己拼出来。
   * 与 run 的区别：命令根本跑不起来（超时 timeout:<秒>、连接断开）时抛 GitError，
   * 新接口要能区分「不是仓库」和「环境不可达」。
   */
  private async runStrict(
    env: ExecEnv,
    cwd: string,
    command: string,
  ): Promise<RunResult> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const r = await env.exec(command, cwd, {
        onData: (d) => {
          if (size >= OUTPUT_CAP) return;
          size += d.length;
          chunks.push(d);
        },
        timeout: TIMEOUT_S,
      });
      const bytes = Buffer.concat(chunks);
      return {
        code: r.exitCode,
        out: text(bytes),
        bytes,
        capped: size >= OUTPUT_CAP,
      };
    } catch (err) {
      throw new GitError(
        "env_unreachable",
        502,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** 内容里出现 NUL 字节就按二进制处理（与 git 自己的判定方式一致）。 */
const hasNul = (bytes: Buffer | null): boolean => bytes?.includes(0) === true;

/** git 自己拒绝执行：把它的报错交给前端。stdout 与 stderr 是合并的，失败时通常只有 stderr。 */
const fail = (prefix: string, r: RunResult): GitError => {
  const detail = r.out.trim();
  return new GitError(
    "checkout_failed",
    409,
    detail === "" ? prefix : `${prefix}：${detail}`,
  );
};
