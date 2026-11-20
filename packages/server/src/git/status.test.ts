import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExecEnv, ExecOptions, FileStat } from "../env/types.js";
import { GitStatusService, parsePorcelain } from "./status.js";

describe("parsePorcelain", () => {
  test("普通条目：modified / added / deleted / untracked", () => {
    const out = " M a.txt\0A  b.txt\0 D c.txt\0?? d.txt\0";
    expect(parsePorcelain(out)).toEqual([
      { path: "a.txt", status: "modified" },
      { path: "b.txt", status: "added" },
      { path: "c.txt", status: "deleted" },
      { path: "d.txt", status: "untracked" },
    ]);
  });

  test("rename：跳过紧随其后的原路径记录", () => {
    // -z 下先新路径、后原路径
    const out = "R  new.txt\0old.txt\0 M other.txt\0";
    expect(parsePorcelain(out)).toEqual([
      { path: "new.txt", status: "renamed" },
      { path: "other.txt", status: "modified" },
    ]);
  });

  test("rename 的原路径记录很短也不会被当成独立条目", () => {
    expect(parsePorcelain("R  dir/new\0a\0")).toEqual([
      { path: "dir/new", status: "renamed" },
    ]);
  });

  test("冲突：UU 与其他未合并组合都是 conflict", () => {
    const out = "UU a.txt\0AA b.txt\0DU c.txt\0UD d.txt\0AU e.txt\0";
    expect(parsePorcelain(out)).toEqual([
      { path: "a.txt", status: "conflict" },
      { path: "b.txt", status: "conflict" },
      { path: "c.txt", status: "conflict" },
      { path: "d.txt", status: "conflict" },
      { path: "e.txt", status: "conflict" },
    ]);
  });

  test("!! 被忽略，不产生条目", () => {
    expect(parsePorcelain("!! build/out.bin\0?? x.txt\0")).toEqual([
      { path: "x.txt", status: "untracked" },
    ]);
  });

  test("空输入与只有末尾 NUL 都返回空数组", () => {
    expect(parsePorcelain("")).toEqual([]);
    expect(parsePorcelain("\0")).toEqual([]);
  });
});

interface ExecCall {
  command: string;
  cwd: string;
}

interface Reply {
  /** 默认 0 */
  exitCode?: number;
  out?: string;
  /** 为 true 时模拟超时/连接断开 */
  throws?: boolean;
}

const isStatus = (c: string) => c.includes("status --porcelain");
const isToplevel = (c: string) => c.includes("--show-toplevel");
const isBranch = (c: string) => c.includes("--abbrev-ref");

/** 造一个假环境：按命令前缀回不同 stdout，并记录每次调用。 */
function makeEnv(respond: (command: string) => Reply, file = false) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(
    async (command: string, cwd: string, opts: ExecOptions) => {
      calls.push({ command, cwd });
      // 让出几个微任务：并发调用在这里交错，正好能验证 in-flight 合并
      for (let i = 0; i < 3; i++) await Promise.resolve();
      const reply = respond(command);
      if (reply.throws === true) throw new Error("timeout:5");
      if (reply.out !== undefined) opts.onData(Buffer.from(reply.out));
      return { exitCode: reply.exitCode ?? 0 };
    },
  );
  const stat = vi.fn(
    async (): Promise<FileStat> => ({
      isDirectory: !file,
      isFile: file,
      isSymlink: false,
      size: 0,
      mtimeMs: 0,
      mode: 0o644,
    }),
  );
  const env = {
    id: "e1",
    kind: "local",
    os: "posix",
    exec,
    stat,
  } as unknown as ExecEnv;
  return { env, exec, stat, calls };
}

const REPO = "/repo";

const normalReply = (command: string): Reply => {
  if (isToplevel(command)) return { out: `${REPO}\n` };
  if (isBranch(command)) return { out: "feature/x\n" };
  if (isStatus(command)) return { out: " M a.txt\0?? b.txt\0" };
  return { exitCode: 1 };
};

describe("GitStatusService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("正常仓库：root / branch / entries 正确", async () => {
    const { env, calls } = makeEnv(normalReply);
    const svc = new GitStatusService();
    const st = await svc.status(env, REPO);
    expect(st).toEqual({
      root: REPO,
      branch: "feature/x",
      detached: false,
      entries: [
        { path: "a.txt", status: "modified" },
        { path: "b.txt", status: "untracked" },
      ],
      truncated: false,
    });
    expect(calls.map((c) => c.command)).toEqual([
      `git -C '${REPO}' rev-parse --show-toplevel`,
      `git -C '${REPO}' rev-parse --abbrev-ref HEAD`,
      `git -C '${REPO}' status --porcelain=v1 -z --untracked-files=all`,
    ]);
    expect(calls.every((c) => c.cwd === REPO)).toBe(true);
  });

  test("dirOrFile 是文件时取父目录", async () => {
    const { env, calls } = makeEnv(normalReply, true);
    const svc = new GitStatusService();
    await svc.status(env, `${REPO}/dir/a.txt`);
    expect(calls[0]?.command).toBe(
      "git -C '/repo/dir' rev-parse --show-toplevel",
    );
  });

  test("detached HEAD：branch 为 HEAD，detached 为 true", async () => {
    const { env } = makeEnv((c) =>
      isBranch(c) ? { out: "HEAD\n" } : normalReply(c),
    );
    const svc = new GitStatusService();
    const st = await svc.status(env, REPO);
    expect(st.branch).toBe("HEAD");
    expect(st.detached).toBe(true);
  });

  test("rev-parse 非零：root 为 null、entries 为空、不抛错", async () => {
    const { env, calls } = makeEnv(() => ({ exitCode: 128 }));
    const svc = new GitStatusService();
    const st = await svc.status(env, "/not/a/repo");
    expect(st).toEqual({
      root: null,
      branch: null,
      detached: false,
      entries: [],
      truncated: false,
    });
    // 第一条命令失败就收手，不再去查分支和状态
    expect(calls).toHaveLength(1);
  });

  test("rev-parse 抛错（超时）也不抛出来", async () => {
    const { env } = makeEnv(() => ({ throws: true }));
    const svc = new GitStatusService();
    await expect(svc.status(env, REPO)).resolves.toMatchObject({
      root: null,
      entries: [],
    });
  });

  test("缓存：ttl 内只执行一次 git status，过期后再执行一次", async () => {
    vi.useFakeTimers();
    const { env, calls } = makeEnv(normalReply);
    const svc = new GitStatusService({ ttlMs: 1000 });
    const statusCalls = () => calls.filter((c) => isStatus(c.command)).length;

    await svc.status(env, REPO);
    await svc.status(env, REPO);
    expect(statusCalls()).toBe(1);

    vi.setSystemTime(Date.now() + 1001);
    await svc.status(env, REPO);
    expect(statusCalls()).toBe(2);

    svc.clear();
    await svc.status(env, REPO);
    expect(statusCalls()).toBe(3);
  });

  test("并发两次调用只执行一次（in-flight 合并）", async () => {
    const { env, calls } = makeEnv(normalReply);
    const svc = new GitStatusService();
    const [a, b] = await Promise.all([
      svc.status(env, REPO),
      svc.status(env, REPO),
    ]);
    expect(a).toBe(b);
    expect(calls.filter((c) => isStatus(c.command))).toHaveLength(1);
  });

  test("status 命令非零：仓库仍在，entries 为空", async () => {
    const { env } = makeEnv((c) =>
      isStatus(c) ? { exitCode: 1 } : normalReply(c),
    );
    const svc = new GitStatusService();
    const st = await svc.status(env, REPO);
    expect(st).toEqual({
      root: REPO,
      branch: "feature/x",
      detached: false,
      entries: [],
      truncated: false,
    });
  });

  test("条目超过上限时截断并标记 truncated", async () => {
    const { env } = makeEnv((c) =>
      isStatus(c) ? { out: "?? a\0?? b\0?? c\0" } : normalReply(c),
    );
    const svc = new GitStatusService({ maxEntries: 2 });
    const st = await svc.status(env, REPO);
    expect(st.entries.map((e) => e.path)).toEqual(["a", "b"]);
    expect(st.truncated).toBe(true);
  });
});
