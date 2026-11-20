// git 来源的取回与查询：只取文件，不跑任何 install。
// 用一个临时仓库做一次 --depth 1 的 fetch 再 checkout，因此 tag / 分支 / 提交号 / HEAD 都能取，也不会拖整段历史。
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

export type GitFailure = "network" | "not_found" | "timeout" | "failed";

// git 子进程的失败形态；fetch.ts 把它翻成 FetchError。
export class GitError extends Error {
  constructor(
    readonly code: GitFailure,
    message: string,
  ) {
    super(message);
  }
}

// 只把真实的网络问题当网络错误；认证失败等带上 git 自己的报错。
const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network is unreachable|Could not resolve host|unable to access|Failed to connect|Connection (refused|timed out)/i;

function classify(err: Error & { killed?: boolean }, stderr: string): GitError {
  if (err.killed) return new GitError("timeout", "请求超时");
  const text = `${stderr}\n${err.message}`.trim();
  if (NETWORK.test(text))
    return new GitError("network", "无法连接来源（检查网络或来源地址）");
  if (
    /E404|404 Not Found|not found|does not exist|couldn't find remote ref|repository .* not found/i.test(
      text,
    )
  )
    return new GitError("not_found", "来源或版本不存在");
  return new GitError(
    "failed",
    text.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300),
  );
}

// url 是 host/owner/repo（不带协议）；一律走 https。
export const httpsUrl = (url: string) => `https://${url}`;

export interface GitOptions {
  /** git 可执行文件，默认 git。 */
  git?: string;
  /** 查询类（ls-remote）超时，默认 15 秒。 */
  queryTimeoutMs?: number;
  /** 取回（fetch 与 checkout）超时，默认 3 分钟。 */
  fetchTimeoutMs?: number;
  /** 来源地址 → 远端地址；默认拼 https://，测试里换成 file:// 或本地路径。 */
  remote?: (url: string) => string;
}

export class GitRunner {
  private readonly git: string;
  private readonly queryMs: number;
  private readonly fetchMs: number;
  readonly remote: (url: string) => string;

  constructor(opts: GitOptions = {}) {
    this.git = opts.git ?? "git";
    this.queryMs = opts.queryTimeoutMs ?? 15_000;
    this.fetchMs = opts.fetchTimeoutMs ?? 180_000;
    this.remote = opts.remote ?? httpsUrl;
  }

  private run(args: string[], timeoutMs: number, cwd?: string) {
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.git,
        args,
        {
          ...(cwd ? { cwd } : {}),
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          // 无终端的守护进程里不许 git 等凭据输入：私有仓库直接失败并带上 git 的报错。
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (err, stdout, stderr) =>
          err ? reject(classify(err, String(stderr))) : resolve(String(stdout)),
      );
    });
  }

  // 远端某个 ref 的提交号；解析不到返回 null。
  private async sha(url: string, ref: string): Promise<string | null> {
    const out = await this.run(
      ["ls-remote", this.remote(url), ref],
      this.queryMs,
    );
    const first = out.split("\n")[0]?.split("\t")[0]?.trim();
    return first && /^[0-9a-f]{40}$/.test(first) ? first : null;
  }

  /** 远端默认分支的提交号；给了 ref 就是该分支的提交号。 */
  async tip(url: string, ref?: string): Promise<string> {
    const sha = await this.sha(url, ref ? `refs/heads/${ref}` : "HEAD");
    if (!sha) throw new GitError("not_found", "来源或版本不存在");
    return sha;
  }

  /** ref 是否为远端的分支。 */
  async isBranch(url: string, ref: string): Promise<boolean> {
    return (await this.sha(url, `refs/heads/${ref}`)) !== null;
  }

  /** ref 是否为远端的 tag。 */
  async isTag(url: string, ref: string): Promise<boolean> {
    return (await this.sha(url, `refs/tags/${ref}`)) !== null;
  }

  /** 版本号形态的 tag，新到旧由调用方排序。 */
  async tags(url: string): Promise<string[]> {
    const out = await this.run(
      ["ls-remote", "--tags", "--refs", this.remote(url)],
      this.queryMs,
    );
    return out
      .split("\n")
      .map((l) => l.split("\trefs/tags/")[1]?.trim())
      .filter((t): t is string => !!t && /^v?\d/.test(t));
  }

  /** 把 version（tag / 分支 / 提交号 / HEAD）取回到 root，返回实际提交号。 */
  async fetch(url: string, version: string, root: string): Promise<string> {
    await this.run(["init", "-q"], this.queryMs, root);
    await this.run(
      ["remote", "add", "origin", this.remote(url)],
      this.queryMs,
      root,
    );
    await this.run(
      ["fetch", "--depth", "1", "origin", version],
      this.fetchMs,
      root,
    );
    await this.run(
      ["-c", "advice.detachedHead=false", "checkout", "FETCH_HEAD"],
      this.fetchMs,
      root,
    );
    const sha = (
      await this.run(["rev-parse", "HEAD"], this.queryMs, root)
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new GitError("failed", "取回后拿不到提交号");
    return sha;
  }
}

/** 在 base 下建一个空临时目录；用完由调用方删除。 */
export const tempDir = (base: string) => mkdtempSync(path.join(base, "git-"));
export const dropTemp = (dir: string) =>
  rmSync(dir, { recursive: true, force: true });
