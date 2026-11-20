import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EnvHub } from "../env/hub.js";
import type { ExecEnv, ExecOptions, FileStat } from "../env/types.js";
import { GitStatusService } from "../git/status.js";
import { gitApi } from "./git.js";

const ENV_ID = "e1";
const REPO = "/repo";

interface Reply {
  exitCode?: number;
  out?: string;
  bytes?: Buffer;
  /** 为 true 时模拟超时/连接断开 */
  throws?: boolean;
}

type FileSpec = Buffer | { size: number; content?: Buffer };

interface ExecCall {
  command: string;
  cwd: string;
}

/** 假环境 + 假 hub：只认 ENV_ID，其余 id 当作不存在。 */
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
  const env = {
    id: ENV_ID,
    kind: "local",
    os: "posix",
    exec,
    stat,
    readFile: vi.fn(async (p: string) => contentOf(p)),
    readStream: vi.fn(async (p: string) => Readable.from([contentOf(p)])),
  } as unknown as ExecEnv;
  const hub = {
    get: (id: string) => (id === ENV_ID ? env : null),
  } as unknown as EnvHub;
  return { env, hub, calls };
}

const isToplevel = (c: string) => c.includes("--show-toplevel");
const isForEachRef = (c: string) => c.includes("for-each-ref");
const isSymbolicRef = (c: string) => c.includes("symbolic-ref");
const isShow = (c: string) => c.includes(" show ");
const isCheckout = (c: string) => c.includes(" checkout ");
const isStash = (c: string) => c.includes("stash push");
const isStatusPlain = (c: string) => c.endsWith("status --porcelain");

const repoReply = (command: string): Reply => {
  if (isToplevel(command)) return { out: `${REPO}\n` };
  if (isForEachRef(command)) return { out: "main\nfeat/a\n" };
  if (isSymbolicRef(command)) return { out: "feat/a\n" };
  if (isStatusPlain(command) || isCheckout(command) || isStash(command))
    return { exitCode: 0 };
  return { exitCode: 1 };
};

let app: FastifyInstance;
let calls: ExecCall[];
let svc: GitStatusService;

async function setup(
  respond: (command: string) => Reply,
  files: Record<string, FileSpec> = {},
) {
  const made = makeEnv(respond, files);
  calls = made.calls;
  svc = new GitStatusService();
  app = Fastify();
  app.register(gitApi, { hub: made.hub, git: svc });
  await app.ready();
}

afterEach(async () => {
  await app.close();
  svc.clear();
});

const getBranches = (query: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/environments/${ENV_ID}/git/branches?${query}`,
  });

const getFile = (query: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/environments/${ENV_ID}/git/file?${query}`,
  });

const postCheckout = (payload: unknown) =>
  app.inject({
    method: "POST",
    url: `/api/v1/environments/${ENV_ID}/git/checkout`,
    payload: payload as object,
  });

describe("GET /git/branches", () => {
  beforeEach(async () => setup(repoReply));

  test("正常仓库：root / current / locals 三项齐全", async () => {
    const r = await getBranches(`path=${encodeURIComponent(REPO)}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      root: REPO,
      current: "feat/a",
      detached: false,
      locals: ["feat/a", "main"],
    });
  });

  test("path 缺失或非绝对路径：400 invalid_path", async () => {
    for (const q of ["", "path=repo", "path="]) {
      const r = await getBranches(q);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: "invalid_path" });
    }
  });
});

describe("环境不存在", () => {
  beforeEach(async () => setup(repoReply));

  test("未知 envId：404 no_env", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/v1/environments/nope/git/branches?path=${encodeURIComponent(REPO)}`,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "no_env" });
  });
});

describe("GET /git/file", () => {
  test("未跟踪文件：original 为 null，current 是磁盘内容", async () => {
    await setup((c) => (isShow(c) ? { exitCode: 128 } : repoReply(c)), {
      "/repo/new.txt": Buffer.from("hello"),
    });
    const r = await getFile(
      `path=${encodeURIComponent(REPO)}&file=${encodeURIComponent("/repo/new.txt")}`,
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      root: REPO,
      rel: "new.txt",
      original: null,
      current: "hello",
      binary: false,
      truncated: false,
    });
  });

  test("二进制文件：两侧置空串并置 binary", async () => {
    const bytes = Buffer.from([0x61, 0x00, 0x62]);
    await setup((c) => (isShow(c) ? { bytes } : repoReply(c)), {
      "/repo/a.bin": bytes,
    });
    const r = await getFile(
      `path=${encodeURIComponent(REPO)}&file=${encodeURIComponent("/repo/a.bin")}`,
    );
    expect(r.json()).toMatchObject({ binary: true, original: "", current: "" });
  });

  test("非 git 目录：200 + root null", async () => {
    await setup(() => ({ exitCode: 128 }));
    const r = await getFile(
      `path=${encodeURIComponent("/not/a/repo")}&file=${encodeURIComponent("/not/a/repo/a.txt")}`,
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      root: null,
      rel: "",
      original: null,
      current: "",
      binary: false,
      truncated: false,
    });
  });

  test("缺 file 参数：400 invalid_path", async () => {
    await setup(repoReply);
    const r = await getFile(`path=${encodeURIComponent(REPO)}`);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "invalid_path" });
  });

  test("环境不可达（超时）：502 env_unreachable", async () => {
    await setup((c) => (isToplevel(c) ? repoReply(c) : { throws: true }));
    const r = await getFile(
      `path=${encodeURIComponent(REPO)}&file=${encodeURIComponent("/repo/a.txt")}`,
    );
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ kind: "env_unreachable" });
  });
});

describe("POST /git/checkout", () => {
  test("干净工作区 carry：200 返回 root 与 branch", async () => {
    await setup(repoReply);
    const r = await postCheckout({
      path: REPO,
      branch: "feat/a",
      dirty: "carry",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ root: REPO, branch: "feat/a" });
    expect(calls.map((c) => c.command)).toEqual([
      `git -C '${REPO}' rev-parse --show-toplevel`,
      `git -C '${REPO}' status --porcelain`,
      `git -C '${REPO}' checkout 'feat/a'`,
    ]);
  });

  test("脏工作区 abort：409 dirty", async () => {
    await setup((c) =>
      isStatusPlain(c) ? { out: " M a.txt\n" } : repoReply(c),
    );
    const r = await postCheckout({
      path: REPO,
      branch: "feat/a",
      dirty: "abort",
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ kind: "dirty" });
    expect(calls.some((c) => isCheckout(c.command))).toBe(false);
  });

  test("脏工作区 stash：先 stash -u 再切", async () => {
    await setup((c) =>
      isStatusPlain(c) ? { out: " M a.txt\n" } : repoReply(c),
    );
    const r = await postCheckout({
      path: REPO,
      branch: "feat/a",
      dirty: "stash",
    });
    expect(r.statusCode).toBe(200);
    const cmds = calls.map((c) => c.command);
    const stashAt = cmds.findIndex((c) => isStash(c));
    const checkoutAt = cmds.findIndex((c) => isCheckout(c));
    expect(stashAt).toBeGreaterThan(-1);
    expect(cmds[stashAt]).toBe(
      `git -C '${REPO}' stash push -u -m 'yuanshu: 切换分支前暂存'`,
    );
    expect(checkoutAt).toBeGreaterThan(stashAt);
  });

  test("脏工作区 carry 且 git 拒绝：409 带上 git 的报错", async () => {
    await setup((c) => {
      if (isStatusPlain(c)) return { out: " M a.txt\n" };
      if (isCheckout(c))
        return {
          exitCode: 1,
          out: "error: local changes would be overwritten",
        };
      return repoReply(c);
    });
    const r = await postCheckout({
      path: REPO,
      branch: "feat/a",
      dirty: "carry",
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ kind: "checkout_failed" });
    expect(r.json().message).toContain("overwritten");
  });

  test("非法分支名一律 400，且一条命令都不跑", async () => {
    await setup(repoReply);
    for (const branch of ["-D", "a..b", "../etc", "x;rm -rf /", "a b", ""]) {
      const r = await postCheckout({ path: REPO, branch, dirty: "carry" });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: "invalid_branch" });
    }
    expect(calls).toHaveLength(0);
  });

  test("dirty 取值不合法：400 invalid_dirty", async () => {
    await setup(repoReply);
    const r = await postCheckout({
      path: REPO,
      branch: "feat/a",
      dirty: "force",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "invalid_dirty" });
  });

  test("非 git 目录：409 not_repo", async () => {
    await setup(() => ({ exitCode: 128 }));
    const r = await postCheckout({
      path: "/not/a/repo",
      branch: "main",
      dirty: "carry",
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ kind: "not_repo" });
  });

  test("环境不可达（超时）：502 env_unreachable", async () => {
    await setup((c) => (isToplevel(c) ? repoReply(c) : { throws: true }));
    const r = await postCheckout({
      path: REPO,
      branch: "main",
      dirty: "carry",
    });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ kind: "env_unreachable" });
  });
});
