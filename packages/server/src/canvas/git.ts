// 画布仓库的 git 封装（canvas.md §6 CV5）：只经 env.exec，本机与 ssh 环境共用。
// 命令是拼字符串执行的，所以 sha 与路径都先过校验；git 不可用或根目录不是仓库时一律退化成「没有历史」，不抛错。
import type { ExecEnv } from "../env/types.js";
import { quote } from "../git/status.js";
import { pathOf } from "../permission/paths.js";
import { insideCanvas, LARGE_DIR } from "./layout.js";

/** 提交来源：agent 的某次调用、用户在界面里的改动、外部改动、恢复与撤销。 */
export type Source =
  | { kind: "agent"; session: string }
  | { kind: "user" }
  | { kind: "external" }
  | { kind: "restore" }
  | { kind: "undo" };

export interface CanvasCommit {
  sha: string;
  /** 毫秒 */
  ts: number;
  subject: string;
}

const PREFIX = {
  agent: "agent:",
  user: "user",
  external: "external",
  restore: "restore",
  undo: "undo",
} as const;

/** 提交信息的前缀约定；summary 为空时只留前缀。 */
export function formatSubject(src: Source, summary: string): string {
  const text = summary.trim();
  switch (src.kind) {
    case "agent":
      return `${PREFIX.agent}${src.session}${text === "" ? "" : ` ${text}`}`;
    case "external":
      return PREFIX.external;
    default:
      return text === "" ? PREFIX[src.kind] : `${PREFIX[src.kind]} ${text}`;
  }
}

/** 读回提交来源；认不出的按外部改动处理。 */
export function parseSubject(subject: string): {
  source: Source;
  session?: string;
  summary: string;
} {
  if (subject.startsWith(PREFIX.agent)) {
    const rest = subject.slice(PREFIX.agent.length);
    const at = rest.indexOf(" ");
    if (at < 0)
      return { source: { kind: "agent", session: rest }, summary: "" };
    return {
      source: { kind: "agent", session: rest.slice(0, at) },
      summary: rest.slice(at + 1),
    };
  }
  for (const kind of ["user", "restore", "undo"] as const) {
    if (subject === PREFIX[kind]) return { source: { kind }, summary: "" };
    if (subject.startsWith(`${PREFIX[kind]} `))
      return { source: { kind }, summary: subject.slice(kind.length + 1) };
  }
  if (subject === PREFIX.external || subject.startsWith("external "))
    return {
      source: { kind: "external" },
      summary: subject.slice(PREFIX.external.length).trim(),
    };
  return { source: { kind: "external" }, summary: subject };
}

const TIMEOUT_S = 15;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** 不依赖机器上的 git 配置：提交者身份、路径引号、签名都固定。 */
const CONFIG =
  '-c user.name="Yuanshu Canvas" -c user.email=canvas@yuanshu.local -c core.quotepath=off -c commit.gpgsign=false';

export class CanvasGit {
  private availableCache: boolean | null = null;

  constructor(
    private readonly env: ExecEnv,
    /** `<目录>/.canvas` 的绝对路径 */
    private readonly root: string,
  ) {}

  /** git 是否可用；成功与失败都缓存，但命令根本跑不起来（工作目录不存在、连不上）时不缓存。 */
  async available(): Promise<boolean> {
    if (this.availableCache !== null) return this.availableCache;
    const r = await this.run("git --version");
    if (r.code === -1) return false;
    this.availableCache = r.code === 0;
    return this.availableCache;
  }

  /** `.canvas/` 不是仓库就 init；再把它从项目主仓库里排除（projectDir 为 null 时不排除）。git 不可用时什么都不做。 */
  async ensure(projectDir: string | null): Promise<void> {
    if (!(await this.available())) return;
    if (!(await this.isRepo())) {
      const r = await this.run(`git -C ${quote(this.root)} init`);
      if (r.code !== 0) return;
    }
    await this.excludeLarge();
    if (projectDir !== null) await this.excludeFromProject(projectDir);
  }

  async dirty(): Promise<boolean> {
    const r = await this.run(
      `git -C ${quote(this.root)} status --porcelain=v1 -z --untracked-files=all`,
    );
    return r.code === 0 && r.out !== "";
  }

  /**
   * add -A 后提交；没有改动返回 null，成功返回短 sha。
   * 一条命令做完：远端上每条命令都是一次往返，没有改动时 `git commit` 本来就以非 0 退出，不用先 status 一次。
   */
  async commitAll(message: string): Promise<string | null> {
    const q = quote(this.root);
    const done = await this.run(
      `git -C ${q} add -A && git -C ${q} ${CONFIG} commit -q -m ${quote(message)} && git -C ${q} rev-parse --short HEAD`,
    );
    if (done.code !== 0) return null;
    const sha = done.out.trim().split("\n").pop()?.trim() ?? "";
    return sha === "" ? null : sha;
  }

  async log(relPath?: string, limit = 50): Promise<CanvasCommit[]> {
    const q = quote(this.root);
    const range = limit > 0 ? `-n ${Math.floor(limit)} ` : "";
    const path =
      relPath === undefined || relPath === ""
        ? ""
        : ` -- ${quote(this.inside(relPath))}`;
    const r = await this.run(
      `git -C ${q} log ${range}--format=${quote("%H%x00%ct%x00%s")}${path}`,
    );
    if (r.code !== 0) return [];
    const out: CanvasCommit[] = [];
    for (const line of r.out.split("\n")) {
      if (line === "") continue;
      const [sha, secs, subject] = line.split("\0");
      if (sha === undefined || secs === undefined) continue;
      out.push({
        sha,
        ts: Number(secs) * 1000,
        subject: subject ?? "",
      });
    }
    return out;
  }

  /** 该提交里这个文件的内容；不存在返回 null。 */
  async show(sha: string, relPath: string): Promise<string | null> {
    const spec = `${this.sha(sha)}:${this.inside(relPath)}`;
    const r = await this.run(`git -C ${quote(this.root)} show ${quote(spec)}`);
    return r.code === 0 ? r.out : null;
  }

  /**
   * 撤销一个提交。给了 message 时用 `--no-commit` 再自己提交（提交信息要带来源前缀，revert 的默认
   * 信息认不出 undo），没给就是 `--no-edit`。冲突则中止并返回原因。
   */
  async revert(
    sha: string,
    message?: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
    const q = quote(this.root);
    const target = this.sha(sha);
    const r = await this.run(
      message === undefined
        ? `git -C ${q} ${CONFIG} revert --no-edit ${target}`
        : `git -C ${q} ${CONFIG} revert --no-commit ${target}`,
    );
    if (r.code !== 0) {
      // --no-commit 失败时没有 sequencer 状态，--abort 可能无效；工作区开始时是干净的，直接 reset
      await this.run(`git -C ${q} revert --abort`);
      await this.run(`git -C ${q} reset --hard`);
      return { ok: false, reason: r.out.trim() || "git revert 失败" };
    }
    if (message !== undefined) {
      await this.run(`git -C ${q} add -A`);
      const done = await this.run(
        `git -C ${q} ${CONFIG} commit -m ${quote(message)}`,
      );
      if (done.code !== 0) {
        await this.run(`git -C ${q} reset --hard`);
        return { ok: false, reason: done.out.trim() || "git commit 失败" };
      }
    }
    const head = await this.run(`git -C ${q} rev-parse --short HEAD`);
    return {
      ok: true,
      sha: head.code === 0 ? head.out.trim() : "",
    };
  }

  /** 整批操作失败时回到干净状态；只在上层确认过开始前是干净的时候调用。 */
  async rollback(): Promise<void> {
    const q = quote(this.root);
    await this.run(`git -C ${q} reset --hard`);
    await this.run(`git -C ${q} clean -fd`);
  }

  // 不能问 git：项目本身是仓库时，在 .canvas/ 里 rev-parse 会一路找到项目的 .git 并报「是仓库」。
  private async isRepo(): Promise<boolean> {
    return (
      (await this.env.stat(pathOf(this.env).join(this.root, ".git"))) !== null
    );
  }

  /**
   * 画布自己的仓库不记资源文件夹里的 `_large/`（粘贴进来的大文件）：画布的 `<画布>.assets/_large/` 与
   * 笔记的 `.assets/<笔记名>/_large/`。规则是通配的，改名 / 挪动后仍然有效。
   */
  private async excludeLarge(): Promise<void> {
    const p = pathOf(this.env);
    const file = p.join(this.root, ".git", "info", "exclude");
    const LINES = [`**/*.assets/${LARGE_DIR}/`, `**/.assets/*/${LARGE_DIR}/`];
    let current = "";
    try {
      if (await this.env.stat(file))
        current = (await this.env.readFile(file)).toString("utf8");
    } catch {
      current = "";
    }
    const have = new Set(current.split("\n").map((l) => l.trim()));
    const missing = LINES.filter((l) => !have.has(l));
    if (missing.length === 0) return;
    const head =
      current === "" || current.endsWith("\n") ? current : `${current}\n`;
    await this.env.mkdirp(p.dirname(file));
    await this.env.writeFile(file, `${head}${missing.join("\n")}\n`);
  }

  /** 把 `/.canvas/` 追加到项目主仓库的 info/exclude（本地文件，不提交）。 */
  async excludeFromProject(projectDir: string): Promise<void> {
    const q = quote(projectDir);
    // 命令在项目目录里跑：`.canvas/` 在这台机器上还不一定存在
    const inside = await this.run(
      `git -C ${q} rev-parse --is-inside-work-tree`,
      projectDir,
    );
    if (inside.code !== 0 || inside.out.trim() !== "true") return;
    const found = await this.run(
      `git -C ${q} rev-parse --git-path info/exclude`,
      projectDir,
    );
    if (found.code !== 0) return;
    const shown = found.out.trim().split("\n")[0] ?? "";
    if (shown === "") return;
    const p = pathOf(this.env);
    const file = p.isAbsolute(shown) ? shown : p.join(projectDir, shown);
    const LINE = ".canvas/";
    let current = "";
    try {
      if (await this.env.stat(file))
        current = (await this.env.readFile(file)).toString("utf8");
    } catch {
      current = "";
    }
    if (current.split("\n").some((l) => l.trim() === LINE)) return;
    const head =
      current === "" || current.endsWith("\n") ? current : `${current}\n`;
    await this.env.mkdirp(p.dirname(file));
    await this.env.writeFile(file, `${head}${LINE}\n`);
  }

  private sha(sha: string): string {
    if (!SHA_RE.test(sha)) throw new Error(`非法的提交 sha：${sha}`);
    return sha;
  }

  private inside(relPath: string): string {
    if (!insideCanvas(relPath))
      throw new Error(`路径不在 .canvas/ 内：${relPath}`);
    return relPath;
  }

  private async run(
    command: string,
    cwd: string = this.root,
  ): Promise<{ code: number; out: string }> {
    const chunks: Buffer[] = [];
    try {
      const r = await this.env.exec(command, cwd, {
        onData: (d) => {
          chunks.push(d);
        },
        timeout: TIMEOUT_S,
      });
      return { code: r.exitCode, out: Buffer.concat(chunks).toString("utf8") };
    } catch (err) {
      // 超时、连接断开：上层按「没有历史」处理，原因原样带出去
      return {
        code: -1,
        out: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
