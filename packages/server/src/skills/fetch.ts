// 技能来源的取回：npm 复用 pi 的 DefaultPackageManager（带 --ignore-scripts）装到专用目录，
// git 只用 git 取文件、不跑任何 install，再用 pi 的 skill 加载器发现其中的技能；
// 候选版本用 npm view / git ls-remote 查。dir 直接读本地目录。取回后文件落到技能库，这里不保留副本。
import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  DefaultPackageManager,
  loadSkillsFromDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { dropTemp, GitError, GitRunner, tempDir } from "./git-fetch.js";
import { isSafeRef, type TrackedSource } from "./source.js";
import { SKILL_FILE, type SkillFile, sizeProblem } from "./spec.js";

export type FetchErrorCode =
  | "network"
  | "not_found"
  | "timeout"
  | "no_skill"
  | "ambiguous"
  | "failed";

// 来源里有多个技能时列给用户挑的一项。
export interface SkillCandidate {
  name: string;
  // 相对仓库根的技能目录，可直接作为下一次请求的 subdir。
  path: string;
  description: string;
}

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly candidates?: SkillCandidate[],
  ) {
    super(message);
  }
}

export interface FoundSkill {
  name: string;
  files: SkillFile[];
  // git 取回时的实际提交号与「取的是不是 tag」；npm 都没有。
  commit?: string;
  tag?: boolean;
}

export interface SkillFetcher {
  // 取回 source 在 version（npm 版本 / git ref）下的技能；包里有多个时按 hint 挑选，挑不出就报歧义。
  fetch(
    source: TrackedSource,
    version: string,
    hint: string,
  ): Promise<FoundSkill>;
  // 候选版本，新到旧，不含预发布；无网络、超时、来源不存在时抛 FetchError。
  versions(source: TrackedSource): Promise<string[]>;
}

// ---- 本地目录读取与发现 ----

const SKIP = new Set(["node_modules", ".git"]);

// 读出技能目录的全部文件（跳过符号链接、点开头与 node_modules）；超限抛错。
export function readSkillDir(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      const full = path.join(abs, e.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) {
        out.push({ path: r, content: readFileSync(full) });
        const big = sizeProblem(out);
        if (big) throw new FetchError("failed", big);
      }
    }
  };
  walk(dir, "");
  return out;
}

interface Candidate {
  name: string;
  dir: string;
  description: string;
  // 相对仓库根的目录，多个技能时给用户当 subdir 用。
  rel: string;
}

const CANDIDATES_MAX = 50;

// 发现范围：有 subdir 时是 root/subdir，否则是 root；subdir 越界直接拒绝。
export function scopeOf(root: string, subdir?: string): string {
  if (!subdir) return root;
  const base = path.resolve(root);
  const target = path.resolve(base, subdir);
  if (target !== base && !target.startsWith(base + path.sep))
    throw new FetchError("failed", `subdir 越出仓库根：${subdir}`);
  return target;
}

// 用 pi 的加载器发现 root 下的技能（root 自己含 SKILL.md 时就是单个技能）。
export function discover(root: string, subdir?: string): Candidate[] {
  return loadSkillsFromDir({ dir: scopeOf(root, subdir), source: "yuanshu" })
    .skills.filter((s) => path.basename(s.filePath) === SKILL_FILE)
    .map((s) => ({
      name: s.name,
      dir: s.baseDir,
      description: s.description,
      rel: path.relative(root, s.baseDir).split(path.sep).join("/"),
    }));
}

// 多个技能时取与来源推断名一致的那个；只有一个就是它；其余情况要用户换一个更具体的来源。
export function pick(found: Candidate[], hint: string): Candidate {
  if (found.length === 0)
    throw new FetchError(
      "no_skill",
      "来源里没有找到技能（需要含 SKILL.md 的目录，或 skills/ 目录）",
    );
  const [only] = found;
  if (found.length === 1 && only) return only;
  // 同名多份也不算：用户得用 subdir 指明哪一份。
  const hits = found.filter((c) => c.name === hint);
  if (hits.length === 1 && hits[0]) return hits[0];
  const listed = [...found]
    .sort((a, b) => (a.rel < b.rel ? -1 : 1))
    .slice(0, CANDIDATES_MAX);
  const rest = found.length - listed.length;
  throw new FetchError(
    "ambiguous",
    `来源里有多个技能（${found.map((c) => c.name).join("、")}），无法确定装哪一个${
      rest > 0 ? `，还有 ${rest} 个未列出` : ""
    }；用 subdir 指定其中一个的目录`,
    listed.map((c) => ({
      name: c.name,
      path: c.rel,
      description: c.description,
    })),
  );
}

export function loadLocalSkill(
  root: string,
  hint: string,
  subdir?: string,
): FoundSkill {
  const c = pick(discover(root, subdir), hint);
  return { name: c.name, files: readSkillDir(c.dir) };
}

// ---- 版本比较 ----

const parts = (v: string) =>
  v
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));

// 新的排前面；数字段按数值比，其余按字符串比。
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

const newestFirst = (vs: string[]) =>
  [...new Set(vs)].sort((a, b) => compareVersions(b, a));

// ---- npm 子进程 ----

const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network|Could not resolve host|unable to access|Failed to connect|Connection (refused|timed out)/i;

function classify(
  err: Error & { killed?: boolean },
  stderr: string,
): FetchError {
  if (err.killed) return new FetchError("timeout", "请求超时");
  const text = `${stderr}\n${err.message}`.trim();
  if (NETWORK.test(text))
    return new FetchError("network", "无法连接来源（检查网络或来源地址）");
  if (
    /E404|404 Not Found|not found|does not exist|couldn't find remote ref/i.test(
      text,
    )
  )
    return new FetchError("not_found", "来源或版本不存在");
  return new FetchError(
    "failed",
    text.split("\n").slice(-3).join(" ").slice(0, 300),
  );
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        // 无终端的守护进程里不许 git 等凭据输入。
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) =>
        err ? reject(classify(err, String(stderr))) : resolve(String(stdout)),
    );
  });
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new FetchError("timeout", "安装超时")),
      ms,
    );
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });

// git 的失败形态翻成 FetchError（代码与 npm 侧一致）。
const fromGit = async <T>(job: () => Promise<T>): Promise<T> => {
  try {
    return await job();
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    throw new FetchError(e.code, e.message);
  }
};

export interface PiFetcherOptions {
  // 专用目录：npm 包装在这里，git 取回的临时仓库也建在这里，每次取回后清空。
  dir: string;
  npmCommand?: string[];
  git?: string;
  // 来源地址 → git 远端地址；默认拼 https://，测试里指向本地仓库。
  gitRemote?: (url: string) => string;
  // 查询类（view / ls-remote）超时，默认 15 秒。
  queryTimeoutMs?: number;
  // 整个安装超时，默认 3 分钟。
  installTimeoutMs?: number;
}

export class PiSkillFetcher implements SkillFetcher {
  private pm: DefaultPackageManager | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly npm: string[];
  private readonly git: GitRunner;
  private readonly queryMs: number;
  private readonly installMs: number;

  constructor(private readonly opts: PiFetcherOptions) {
    // --ignore-scripts：技能包只取文件，不在 Server 上跑包里的生命周期脚本。
    this.npm = opts.npmCommand ?? [
      "npm",
      "--ignore-scripts",
      "--fetch-retries=0",
      "--fetch-timeout=15000",
    ];
    this.queryMs = opts.queryTimeoutMs ?? 15_000;
    this.installMs = opts.installTimeoutMs ?? 180_000;
    this.git = new GitRunner({
      ...(opts.git ? { git: opts.git } : {}),
      ...(opts.gitRemote ? { remote: opts.gitRemote } : {}),
      queryTimeoutMs: this.queryMs,
      fetchTimeoutMs: this.installMs,
    });
  }

  private manager(): DefaultPackageManager {
    if (!this.pm) {
      mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      this.pm = new DefaultPackageManager({
        cwd: this.opts.dir,
        agentDir: this.opts.dir,
        settingsManager: SettingsManager.inMemory({ npmCommand: this.npm }),
      });
    }
    return this.pm;
  }

  private clean() {
    rmSync(path.join(this.opts.dir, "npm"), { recursive: true, force: true });
  }

  // npm 的安装根与 git 的临时仓库都在专用目录里，串行执行避免互相覆盖。
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async versions(source: TrackedSource): Promise<string[]> {
    if (source.kind === "npm") return this.npmVersions(source.pkg);
    const ref = source.ref;
    // 没写 ref → 默认分支的提交号；写了且是分支 → 该分支的提交号；
    // 40 位提交号 → 就是它；其余（tag）→ 沿用 tag 列表。
    if (ref === undefined)
      return [await fromGit(() => this.git.tip(source.url))];
    if (await fromGit(() => this.git.isBranch(source.url, ref)))
      return [await fromGit(() => this.git.tip(source.url, ref))];
    if (/^[0-9a-f]{40}$/.test(ref)) return [ref];
    const tags = await fromGit(() => this.git.tags(source.url));
    return newestFirst(tags.filter(isSafeRef));
  }

  private async npmVersions(pkg: string): Promise<string[]> {
    const [cmd, ...pre] = this.npm;
    const out = await run(
      cmd ?? "npm",
      [...pre, "view", pkg, "versions", "dist-tags", "--json"],
      this.queryMs,
    );
    let body: { versions?: unknown; "dist-tags"?: { latest?: string } };
    try {
      body = JSON.parse(out) as typeof body;
    } catch {
      throw new FetchError("failed", "npm view 返回了无法解析的内容");
    }
    const all = (Array.isArray(body.versions) ? body.versions : []).filter(
      (v): v is string => typeof v === "string" && !v.includes("-"),
    );
    const sorted = newestFirst(all);
    const latest = body["dist-tags"]?.latest;
    // latest 标签是发布者指定的最新稳定版，优先排第一。
    return latest && sorted.includes(latest)
      ? [latest, ...sorted.filter((v) => v !== latest)]
      : sorted;
  }

  fetch(
    source: TrackedSource,
    version: string,
    hint: string,
  ): Promise<FoundSkill> {
    return this.serial(() =>
      withTimeout(this.fetchNow(source, version, hint), this.installMs),
    );
  }

  private fetchNow(
    source: TrackedSource,
    version: string,
    hint: string,
  ): Promise<FoundSkill> {
    return source.kind === "git"
      ? this.fetchGit(source, version, hint)
      : this.fetchNpm(source, version, hint);
  }

  // 先用带超时的短命令确认版本存在，网络问题在这里就能给出明确原因（pi 的安装命令不带超时）。
  private async fetchNpm(
    source: TrackedSource & { kind: "npm" },
    version: string,
    hint: string,
  ): Promise<FoundSkill> {
    const [cmd, ...pre] = this.npm;
    await run(
      cmd ?? "npm",
      [...pre, "view", `${source.pkg}@${version}`, "version", "--json"],
      this.queryMs,
    );
    const spec = `npm:${source.pkg}@${version}`;
    const pm = this.manager();
    this.clean();
    try {
      try {
        await pm.install(spec);
      } catch (err) {
        throw new FetchError(
          "failed",
          `安装失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const root = pm.getInstalledPath(spec, "user");
      if (!root) throw new FetchError("failed", "安装后找不到包目录");
      return loadLocalSkill(root, hint);
    } finally {
      this.clean();
    }
  }

  // git 只取文件：临时仓库里 --depth 1 取回目标 ref 再 checkout，仓库里的 package.json 一律不执行。
  private async fetchGit(
    source: TrackedSource & { kind: "git" },
    version: string,
    hint: string,
  ): Promise<FoundSkill> {
    // 先校验 subdir，免得取回完才发现越界。
    scopeOf(this.opts.dir, source.subdir);
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const root = tempDir(this.opts.dir);
    try {
      const commit = await fromGit(() =>
        this.git.fetch(source.url, version, root),
      );
      // tag 存 tag 名、分支与提交号存提交号，所以这里要说明取的是不是 tag。
      const tag =
        version === "HEAD" || /^[0-9a-f]{40}$/.test(version)
          ? false
          : await fromGit(() => this.git.isTag(source.url, version));
      const found = loadLocalSkill(root, hint, source.subdir);
      return { ...found, commit, tag };
    } finally {
      dropTemp(root);
    }
  }
}
