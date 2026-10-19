import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { hasSshd, startSshd, type TestSshd } from "../../test/support/sshd.js";
import { SshConnection } from "../ssh/connection.js";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { LocalEnv } from "./local.js";
import { SshEnv } from "./ssh.js";
import type { ExecEnv } from "./types.js";

const run = async (
  env: ExecEnv,
  cmd: string,
  cwd: string,
  timeout?: number,
) => {
  const chunks: Buffer[] = [];
  const r = await env.exec(cmd, cwd, {
    onData: (d) => chunks.push(d),
    ...(timeout ? { timeout } : {}),
  });
  return { ...r, out: Buffer.concat(chunks).toString("utf8") };
};

// 本机与 ssh 两个实现必须表现一致：权限判定与工具都只认这组原语。
function contract(make: () => Promise<{ env: ExecEnv; work: string }>) {
  let env: ExecEnv;
  let work: string;
  beforeEach(async () => {
    ({ env, work } = await make());
    writeFileSync(path.join(work, "a.txt"), "hello");
    mkdirSync(path.join(work, "sub"));
    symlinkSync(path.join(work, "sub"), path.join(work, "link"));
    symlinkSync(path.join(work, "nope"), path.join(work, "dangling"));
  });

  test("stat 跟随链接，不存在返回 null；lstat 看到链接本身", async () => {
    expect((await env.stat(path.join(work, "a.txt")))?.isFile).toBe(true);
    expect((await env.stat(path.join(work, "link")))?.isDirectory).toBe(true);
    expect(await env.stat(path.join(work, "dangling"))).toBeNull();
    expect((await env.lstat(path.join(work, "link")))?.isSymlink).toBe(true);
    expect((await env.lstat(path.join(work, "dangling")))?.isSymlink).toBe(
      true,
    );
    expect(await env.lstat(path.join(work, "missing"))).toBeNull();
  });

  test("realpath 解析链接；悬空与不存在返回 null", async () => {
    const real = await env.realpath(path.join(work, "link"));
    expect(real?.endsWith(`${path.sep}sub`)).toBe(true);
    expect(await env.realpath(path.join(work, "dangling"))).toBeNull();
    expect(await env.realpath(path.join(work, "missing"))).toBeNull();
  });

  test("readdir 带类型", async () => {
    const list = await env.readdir(work);
    const by = Object.fromEntries(list.map((e) => [e.name, e]));
    expect(by["a.txt"]?.isDirectory).toBe(false);
    expect(by.sub?.isDirectory).toBe(true);
    expect(by.link?.isSymlink).toBe(true);
  });

  test("writeFile/readFile 保持二进制，mkdirp 逐级创建", async () => {
    const dir = path.join(work, "x", "y");
    await env.mkdirp(dir);
    const bin = Buffer.from([0, 255, 10, 13, 200]);
    await env.writeFile(path.join(dir, "b.bin"), bin);
    expect((await env.readFile(path.join(dir, "b.bin"))).equals(bin)).toBe(
      true,
    );
  });

  test("exec 在 cwd 执行，stderr 合并，退出码原样返回", async () => {
    const r = await run(env, "pwd; echo err >&2; exit 3", work);
    expect(r.exitCode).toBe(3);
    expect(r.out).toContain(work);
    expect(r.out).toContain("err");
  });

  test("命令末尾带注释或 heredoc 不会破坏包装", async () => {
    expect((await run(env, "echo hi # trailing", work)).out).toContain("hi");
    const r = await run(env, "cat <<'EOF'\nline\nEOF", work);
    expect(r.out).toContain("line");
  });

  test("cwd 含单引号也能正确进入", async () => {
    const odd = path.join(work, "it's");
    await env.mkdirp(odd);
    expect((await run(env, "pwd", odd)).out).toContain("it's");
  });

  test("超时与中止都以异常结束", async () => {
    await expect(run(env, "sleep 5", work, 1)).rejects.toThrow(/timeout/);
    const ac = new AbortController();
    const p = env.exec("sleep 5", work, {
      onData: () => {},
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
  });
}

describe("LocalEnv", () => {
  let dir: string;
  contract(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-env-"));
    return { env: new LocalEnv(), work: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});

describe.skipIf(!hasSshd)("SshEnv（真实 sshd）", () => {
  let sshd: TestSshd;
  let dir: string;
  let db: Db;
  let env: SshEnv | null = null;
  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(() => sshd.close());

  contract(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-env-"));
    db = openDatabase(dir);
    const secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    env = new SshEnv(
      "env-test",
      "posix",
      new SshConnection(
        {
          host: "127.0.0.1",
          port: sshd.port,
          username: sshd.user,
          secretId: key?.id ?? null,
        },
        secrets,
      ),
    );
    const work = path.join(dir, "work");
    mkdirSync(work);
    return { env, work };
  });

  afterEach(() => {
    env?.close();
    env = null;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("状态随连接变化，失败原因如实记录", async () => {
    const e = env as SshEnv;
    expect(e.status().state).toBe("disconnected");
    await e.connect();
    expect(e.status().state).toBe("connected");
    e.close();
    expect(e.status().state).toBe("disconnected");
  });
});
