import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import { routedToolsExtension, type Where } from "./tools.js";
import type { ExecEnv } from "./types.js";

interface Tool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: object,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
}

async function load(where: () => Where) {
  const tools = new Map<string, Tool>();
  await routedToolsExtension(where)({
    registerTool: (t: Tool) => tools.set(t.name, t),
  } as never);
  return async (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    // bash 工具会向 ctx.sessionManager 取会话信息注入环境变量。
    const ctx = {
      sessionManager: {
        getSessionId: () => "test-session",
        getSessionFile: () => undefined,
      },
    };
    const r = await tool.execute("t", params, undefined, undefined, ctx);
    return r.content.map((c) => c.text ?? "").join("");
  };
}

// 记录经过环境原语的调用：本机应为空（走 SDK 原样），ssh 必须有。
function spy(env: ExecEnv) {
  const calls: string[] = [];
  const proxy = new Proxy(env, {
    get(target, key) {
      const v = Reflect.get(target, key);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        calls.push(String(key));
        return v.apply(target, a);
      };
    },
  });
  return { env: proxy, calls };
}

describe("本机环境的工具", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("不经过环境原语，行为与 SDK 一致", async () => {
    const s = spy(new LocalEnv());
    const call = await load(() => ({ env: s.env, cwd: dir }));
    await call("write", { path: "a.txt", content: "hi" });
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("hi");
    expect(await call("read", { path: "a.txt" })).toContain("hi");
    expect(await call("bash", { command: "pwd" })).toContain(dir);
    expect(s.calls).toEqual([]);
  });
});

describe.skipIf(!hasSshd)("ssh 环境的工具（真实 sshd）", () => {
  let sshd: TestSshd;
  let dir: string;
  let work: string;
  let db: Db;
  let ssh: SshEnv;
  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(() => sshd.close());

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-tools-"));
    db = openDatabase(dir);
    const secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    ssh = new SshEnv(
      "tools-test",
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
    work = path.join(dir, "work");
    mkdirSync(path.join(work, "sub"), { recursive: true });
    writeFileSync(path.join(work, "x.txt"), "alpha\nneedle\nomega\n");
    writeFileSync(path.join(work, "y.md"), "needle in markdown\n");
    writeFileSync(path.join(work, "sub", "z.txt"), "nothing here\n");
  });
  afterEach(() => {
    ssh.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("bash 经 ssh 执行并在 cwd 内", async () => {
    const s = spy(ssh);
    const call = await load(() => ({ env: s.env, cwd: work }));
    const out = await call("bash", {
      command: 'pwd; echo "conn=$SSH_CONNECTION"',
    });
    expect(out).toContain(work);
    expect(out).toContain("conn=127.0.0.1");
    expect(s.calls).toContain("exec");
  });

  test("write → read → edit 往返，且都走环境原语", async () => {
    const s = spy(ssh);
    const call = await load(() => ({ env: s.env, cwd: work }));
    await call("write", { path: "sub/new.txt", content: "one two" });
    expect(readFileSync(path.join(work, "sub", "new.txt"), "utf8")).toBe(
      "one two",
    );
    expect(await call("read", { path: "sub/new.txt" })).toContain("one two");
    await call("edit", {
      path: "sub/new.txt",
      edits: [{ oldText: "two", newText: "2" }],
    });
    expect(readFileSync(path.join(work, "sub", "new.txt"), "utf8")).toBe(
      "one 2",
    );
    expect(s.calls).toEqual(expect.arrayContaining(["writeFile", "readFile"]));
  });

  test("ls 与 find 列出远程内容", async () => {
    const call = await load(() => ({ env: ssh, cwd: work }));
    const listing = await call("ls", {});
    expect(listing).toContain("x.txt");
    expect(listing).toContain("sub");
    const found = await call("find", { pattern: "*.txt" });
    expect(found).toContain("x.txt");
    expect(found).toContain("z.txt");
    expect(found).not.toContain("y.md");
  });

  test("grep 返回 文件:行号: 内容，glob 过滤生效，无匹配如实说明", async () => {
    const call = await load(() => ({ env: ssh, cwd: work }));
    const hit = await call("grep", { pattern: "needle" });
    expect(hit).toContain("x.txt:2: needle");
    expect(hit).toContain("y.md:1:");
    const onlyTxt = await call("grep", { pattern: "needle", glob: "*.txt" });
    expect(onlyTxt).toContain("x.txt:2:");
    expect(onlyTxt).not.toContain("y.md");
    expect(await call("grep", { pattern: "absent-token-xyz" })).toContain(
      "No matches found",
    );
  });

  test("按调用时的 workspace 路由：同一组工具先 ssh 后本机", async () => {
    const remote = spy(ssh);
    const localSpy = spy(new LocalEnv());
    let current: Where = { env: remote.env, cwd: work };
    const call = await load(() => current);
    await call("read", { path: "x.txt" });
    expect(remote.calls).toContain("readFile");

    const before = remote.calls.length;
    current = { env: localSpy.env, cwd: work };
    expect(await call("read", { path: "x.txt" })).toContain("needle");
    expect(remote.calls.length).toBe(before);
    expect(localSpy.calls).toEqual([]);
  });
});
