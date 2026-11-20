import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { ExecEnv, ExecOptions, FileStat } from "../env/types.js";
import { GitError, GitStatusService, isValidBranch } from "./status.js";

const REPO = "/repo";

describe("isValidBranch", () => {
  test("常见分支名通过", () => {
    for (const name of ["main", "feat/git-panel", "release-1.2", "v1.0.0_hot"])
      expect(isValidBranch(name)).toBe(true);
  });

  test("空、选项形态、路径穿越与注入字符一律拒绝", () => {
    for (const name of [
      "",
      "-D",
      "--force",
      "a..b",
      "../etc",
      "a b",
      "a;rm -rf /",
      "a$(id)",
      "a`id`",
      "a|b",
      "a\nb",
    ])
      expect(isValidBranch(name)).toBe(false);
  });
});

interface Reply {
  /** 默认 0 */
  exitCode?: number;
  out?: string;
  /** 原始字节，优先于 out */
  bytes?: Buffer;
  /** 为 true 时模拟超时/连接断开 */
  throws?: boolean;
}

/** 文件内容；给了 size 就当它是「磁盘上这么大」，content 只用于模拟读到的前若干字节。 */
type FileSpec = Buffer | { size: number; content?: Buffer };

interface ExecCall {
  command: string;
  cwd: string;
}

/** 造一个假环境：按命令回不同输出、按路径给假文件，并记录每次调用。 */
function makeEnv(
  respond: (command: string) => Reply,
  files: Record<string, FileSpec> = {},
) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(
    async (command: string, cwd: string, opts: ExecOptions) => {
      calls.push({ command, cwd });
      const reply = respond(command);
      if (reply.throws === true) throw new Error("timeout:5");
      if (reply.bytes !== undefined) opts.onData(reply.bytes);
      else if (reply.out !== undefined) opts.onData(Buffer.from(reply.out));
      return { exitCode: reply.exitCode ?? 0 };
    },
  );
  const contentOf = (p: string): Buffer => {
    const spec = files[p];
    if (spec === undefined) return Buffer.alloc(0);
    return Buffer.isBuffer(spec) ? spec : (spec.content ?? Buffer.alloc(0));
  };
  // 没登记的一律当目录：仓库根、子目录都不必逐个列出
  const stat = vi.fn(async (p: string): Promise<FileStat> => {
    const spec = files[p];
    if (spec === undefined)
      return {
        isDirectory: true,
        isFile: false,
        isSymlink: false,
        size: 0,
        mtimeMs: 0,
        mode: 0o755,
      };
    return {
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      size: Buffer.isBuffer(spec) ? spec.length : spec.size,
      mtimeMs: 0,
      mode: 0o644,
    };
  });
  const readFile = vi.fn(async (p: string) => contentOf(p));
  const readStream = vi.fn(async (p: string) => Readable.from([contentOf(p)]));
  const env = {
    id: "e1",
    kind: "local",
    os: "posix",
    exec,
    stat,
    readFile,
    readStream,
  } as unknown as ExecEnv;
  return { env, calls, readFile, readStream };
}

const isToplevel = (c: string) => c.includes("--show-toplevel");
const isForEachRef = (c: string) => c.includes("for-each-ref");
const isSymbolicRef = (c: string) => c.includes("symbolic-ref");
const isShortRev = (c: string) => c.includes("rev-parse --short HEAD");
const isShow = (c: string) => c.includes(" show ");
const isStash = (c: string) => c.includes("stash push");
const isCheckout = (c: string) => c.includes(" checkout ");
const isStatusV1 = (c: string) => c.includes("status --porcelain=v1");
const isStatusPlain = (c: string) =>
  c.endsWith("git -C '/repo' status --porcelain");

const repoReply = (command: string): Reply => {
  if (isToplevel(command)) return { out: `${REPO}\n` };
  if (isForEachRef(command)) return { out: "main\nfeat/a\nfix/b\n" };
  if (isSymbolicRef(command)) return { out: "feat/a\n" };
  if (isStatusPlain(command)) return { exitCode: 0 };
  if (isCheckout(command) || isStash(command)) return { exitCode: 0 };
  return { exitCode: 1 };
};

describe("GitStatusService.branches", () => {
  test("正常仓库：locals 按名字排序，current 取 symbolic-ref", async () => {
    const { env, calls } = makeEnv(repoReply);
    const svc = new GitStatusService();
    await expect(svc.branches(env, REPO)).resolves.toEqual({
      root: REPO,
      current: "feat/a",
      detached: false,
      locals: ["feat/a", "fix/b", "main"],
    });
    expect(calls.map((c) => c.command)).toEqual([
      `git -C '${REPO}' rev-parse --show-toplevel`,
      `git -C '${REPO}' for-each-ref --format='%(refname:short)' refs/heads`,
      `git -C '${REPO}' symbolic-ref --short HEAD`,
    ]);
    expect(calls.every((c) => c.cwd === REPO)).toBe(true);
  });

  test("detached HEAD：current 退回短哈希并置 detached", async () => {
    const { env, calls } = makeEnv((c) => {
      if (isSymbolicRef(c)) return { exitCode: 1 };
      if (isShortRev(c)) return { out: "abc1234\n" };
      return repoReply(c);
    });
    const svc = new GitStatusService();
    await expect(svc.branches(env, REPO)).resolves.toMatchObject({
      root: REPO,
      current: "abc1234",
      detached: true,
    });
    expect(calls.some((c) => isShortRev(c.command))).toBe(true);
  });

  test("非 git 目录：root 为 null，只跑一条命令", async () => {
    const { env, calls } = makeEnv(() => ({ exitCode: 128 }));
    const svc = new GitStatusService();
    await expect(svc.branches(env, "/not/a/repo")).resolves.toEqual({
      root: null,
      current: null,
      detached: false,
      locals: [],
    });
    expect(calls).toHaveLength(1);
  });

  test("ttl 内复用缓存，不再跑 for-each-ref", async () => {
    const { env, calls } = makeEnv(repoReply);
    const svc = new GitStatusService();
    await svc.branches(env, REPO);
    await svc.branches(env, REPO);
    expect(calls.filter((c) => isForEachRef(c.command))).toHaveLength(1);
  });

  test("命令跑不起来（超时）抛 env_unreachable 502", async () => {
    const { env } = makeEnv((c) =>
      isToplevel(c) ? repoReply(c) : { throws: true },
    );
    const svc = new GitStatusService();
    await expect(svc.branches(env, REPO)).rejects.toMatchObject({
      kind: "env_unreachable",
      status: 502,
    });
  });
});

describe("GitStatusService.fileContent", () => {
  test("已跟踪文件：original 取 HEAD:rel，current 读磁盘", async () => {
    const { env, calls } = makeEnv(
      (c) => {
        if (isShow(c)) return { out: "old\n" };
        return repoReply(c);
      },
      { "/repo/src/a.txt": Buffer.from("new\n") },
    );
    const svc = new GitStatusService();
    await expect(
      svc.fileContent(env, REPO, "/repo/src/a.txt"),
    ).resolves.toEqual({
      root: REPO,
      rel: "src/a.txt",
      original: "old\n",
      current: "new\n",
      binary: false,
      truncated: false,
    });
    expect(calls.map((c) => c.command)).toEqual([
      `git -C '${REPO}' rev-parse --show-toplevel`,
      `git -C '${REPO}' show 'HEAD:src/a.txt'`,
    ]);
  });

  test("未跟踪文件：git show 失败时 original 为 null", async () => {
    const { env } = makeEnv(
      (c) => {
        if (isShow(c)) return { exitCode: 128 };
        return repoReply(c);
      },
      { "/repo/new.txt": Buffer.from("hello") },
    );
    const svc = new GitStatusService();
    await expect(
      svc.fileContent(env, REPO, "/repo/new.txt"),
    ).resolves.toMatchObject({
      rel: "new.txt",
      original: null,
      current: "hello",
      binary: false,
    });
  });

  test("含 NUL 字节按二进制处理，两侧内容都置空串", async () => {
    const { env } = makeEnv(
      (c) => {
        if (isShow(c)) return { bytes: Buffer.from([0x61, 0x00, 0x62]) };
        return repoReply(c);
      },
      { "/repo/a.bin": Buffer.from([0x61, 0x00, 0x62]) },
    );
    const svc = new GitStatusService();
    await expect(
      svc.fileContent(env, REPO, "/repo/a.bin"),
    ).resolves.toMatchObject({
      original: "",
      current: "",
      binary: true,
    });
  });

  test("目录文件超过 1MB：只读前 1MB 并置 truncated", async () => {
    const big = Buffer.alloc(1024 * 1024, 0x61);
    const { env, readFile } = makeEnv(
      (c) => {
        if (isShow(c)) return { exitCode: 128 };
        return repoReply(c);
      },
      { "/repo/big.txt": { size: 5 * 1024 * 1024, content: big } },
    );
    const svc = new GitStatusService();
    const r = await svc.fileContent(env, REPO, "/repo/big.txt");
    expect(r.truncated).toBe(true);
    expect(r.current.length).toBe(1024 * 1024);
    // 走的是区间流，不是整份 readFile
    expect(readFile).not.toHaveBeenCalled();
  });

  test("非 git 目录：root 为 null 的空形状", async () => {
    const { env, calls } = makeEnv(() => ({ exitCode: 128 }));
    const svc = new GitStatusService();
    await expect(
      svc.fileContent(env, "/not/a/repo", "/not/a/repo/a.txt"),
    ).resolves.toEqual({
      root: null,
      rel: "",
      original: null,
      current: "",
      binary: false,
      truncated: false,
    });
    expect(calls).toHaveLength(1);
  });

  test("文件在仓库根之外：不给 rel，也不跑 git show", async () => {
    const { env, calls } = makeEnv(repoReply, {
      "/other/a.txt": Buffer.from("x"),
    });
    const svc = new GitStatusService();
    await expect(
      svc.fileContent(env, REPO, "/other/a.txt"),
    ).resolves.toMatchObject({ root: REPO, rel: "", current: "" });
    expect(calls.some((c) => isShow(c.command))).toBe(false);
  });
});

describe("GitStatusService.checkout", () => {
  const dirtyReply = (command: string): Reply => {
    if (isStatusPlain(command)) return { out: " M a.txt\n" };
    return repoReply(command);
  };

  test("干净工作区：直接 checkout，成功返回 root 与 branch", async () => {
    const { env, calls } = makeEnv(repoReply);
    const svc = new GitStatusService();
    await expect(svc.checkout(env, REPO, "fix/b", "carry")).resolves.toEqual({
      root: REPO,
      branch: "fix/b",
    });
    expect(calls.map((c) => c.command)).toEqual([
      `git -C '${REPO}' rev-parse --show-toplevel`,
      `git -C '${REPO}' status --porcelain`,
      `git -C '${REPO}' checkout 'fix/b'`,
    ]);
  });

  test("脏工作区 + abort：409 dirty，且不执行 checkout", async () => {
    const { env, calls } = makeEnv(dirtyReply);
    const svc = new GitStatusService();
    await expect(
      svc.checkout(env, REPO, "fix/b", "abort"),
    ).rejects.toMatchObject({ kind: "dirty", status: 409 });
    expect(calls.some((c) => isCheckout(c.command))).toBe(false);
  });

  test("脏工作区 + stash：先 stash -u 再 checkout", async () => {
    const { env, calls } = makeEnv(dirtyReply);
    const svc = new GitStatusService();
    await svc.checkout(env, REPO, "fix/b", "stash");
    expect(calls.map((c) => c.command)).toEqual([
      `git -C '${REPO}' rev-parse --show-toplevel`,
      `git -C '${REPO}' status --porcelain`,
      `git -C '${REPO}' stash push -u -m 'yuanshu: 切换分支前暂存'`,
      `git -C '${REPO}' checkout 'fix/b'`,
    ]);
  });

  test("脏工作区 + carry：git 自己拒绝时 409 并带上它的报错", async () => {
    const { env, calls } = makeEnv((c) => {
      if (isCheckout(c))
        return {
          exitCode: 1,
          out: "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n",
        };
      return dirtyReply(c);
    });
    const svc = new GitStatusService();
    const err = await svc.checkout(env, REPO, "fix/b", "carry").catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toMatchObject({ kind: "checkout_failed", status: 409 });
    expect(err.message).toContain("overwritten by checkout");
    // carry 不该偷偷 stash
    expect(calls.some((c) => isStash(c.command))).toBe(false);
  });

  test("非 git 目录：not_repo 409", async () => {
    const { env } = makeEnv(() => ({ exitCode: 128 }));
    const svc = new GitStatusService();
    await expect(
      svc.checkout(env, "/not/a/repo", "main", "carry"),
    ).rejects.toMatchObject({ kind: "not_repo", status: 409 });
  });

  test("命令跑不起来（超时）：env_unreachable 502", async () => {
    const { env } = makeEnv((c) =>
      isToplevel(c) ? repoReply(c) : { throws: true },
    );
    const svc = new GitStatusService();
    await expect(
      svc.checkout(env, REPO, "main", "carry"),
    ).rejects.toMatchObject({ kind: "env_unreachable", status: 502 });
  });

  test("切换成功后状态缓存作废：下一次 status 重新跑命令", async () => {
    const { env, calls } = makeEnv((c) => {
      if (isStatusV1(c)) return { out: "" };
      if (isToplevel(c)) return { out: `${REPO}\n` };
      return repoReply(c);
    });
    const svc = new GitStatusService({ ttlMs: 60_000 });
    await svc.status(env, REPO);
    await svc.status(env, REPO);
    expect(calls.filter((c) => isStatusV1(c.command))).toHaveLength(1);

    await svc.checkout(env, REPO, "fix/b", "carry");
    await svc.status(env, REPO);
    expect(calls.filter((c) => isStatusV1(c.command))).toHaveLength(2);
  });
});

// 假 ExecEnv 只比对命令字符串，抓不到「字符串对、真 shell 跑不通」的问题：
// for-each-ref 的 --format=%(refname:short) 少了引号时，shell 会先吃掉 %(…)，命令静默失败。
// 这里把真实命令交给 /bin/sh 跑一遍，确保它们在真环境里也可执行。
test("真实 shell 可执行：分支列表与状态命令的引号是对的", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ys-git-"));
  try {
    const run = (cmd: string) =>
      execSync(`/bin/sh -c ${JSON.stringify(cmd)}`, {
        cwd: dir,
        encoding: "utf8",
      });
    run(
      "git init -q -b main . && git config user.email a@b.c && git config user.name a",
    );
    writeFileSync(join(dir, "a.txt"), "1\n");
    run("git add . && git commit -qm init && git branch feat/x");

    // 与服务端实现同构：引号必须包住整个 format
    const q = `'${dir}'`;
    const fmt = `'%(refname:short)'`;
    const refs = run(
      `git -C ${q} for-each-ref --format=${fmt} refs/heads`,
    ).trim();
    expect(refs.split("\n").sort()).toEqual(["feat/x", "main"]);

    const cur = run(`git -C ${q} symbolic-ref --short HEAD`).trim();
    expect(cur).toBe("main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
