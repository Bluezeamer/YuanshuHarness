import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpClient } from "@earendil-works/pi-mcp";
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
import { SshEnv } from "../env/ssh.js";
import type { ExecOptions, WriteOptions } from "../env/types.js";
import { SshConnection } from "../ssh/connection.js";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { type RemoteHost, RemoteStdioTransport } from "./remote-transport.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 记录经 SSH 起过的临时脚本路径，以及发过的整组 kill（用来断言「不该杀的时候没杀」）。
const spy = (env: RemoteHost) => {
  const scripts: string[] = [];
  const kills: string[] = [];
  const wrapped = new Proxy(env, {
    get(target, prop, recv) {
      if (prop === "writeStream")
        return (p: string, o?: WriteOptions) => {
          scripts.push(p);
          return target.writeStream(p, o);
        };
      if (prop === "exec")
        return (command: string, cwd: string, opts: ExecOptions) => {
          if (command.startsWith("kill")) kills.push(command);
          return target.exec(command, cwd, opts);
        };
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { env: wrapped as RemoteHost, scripts, kills };
};

test("开不出通道时错误里点明可能是会话数上限，原错误还在", async () => {
  const fake = {
    os: "posix",
    writeStream: async () => new Writable({ write: (_c, _e, done) => done() }),
    remove: async () => {},
    openStdio: async () => {
      throw new Error("(SSH) Channel open failure: open failed");
    },
  } as unknown as RemoteHost;
  const t = new RemoteStdioTransport({
    env: fake,
    command: "x",
    args: [],
    cwd: "/",
    vars: {},
  });
  await expect(t.start()).rejects.toThrow(
    /Channel open failure: open failed.*MaxSessions/,
  );
});

describe.skipIf(!hasSshd)("RemoteStdioTransport（真实 sshd 回环）", () => {
  let sshd: TestSshd;
  let dir: string;
  let work: string;
  let db: Db;
  let env: SshEnv;
  let conn: SshConnection;
  let host: RemoteHost;
  const opened: RemoteStdioTransport[] = [];

  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(async () => {
    await sshd.close();
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-remote-"));
    work = path.join(dir, "work");
    mkdirSync(work);
    db = openDatabase(dir);
    const secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    conn = new SshConnection(
      {
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        secretId: key?.id ?? null,
      },
      secrets,
    );
    env = new SshEnv("env-test", "posix", conn);
    host = env as RemoteHost;
  });

  afterEach(async () => {
    for (const t of opened.splice(0)) await t.close();
    env.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const transport = (o: Partial<Parameters<typeof remote>["0"]> = {}) =>
    remote({ ...o });

  const remote = (
    o: Partial<{
      command: string;
      args: string[];
      cwd: string;
      vars: Record<string, string>;
    }> & { env?: RemoteHost } = {},
  ) => {
    const t = new RemoteStdioTransport({
      env: o.env ?? host,
      command: o.command ?? process.execPath,
      args: o.args ?? [FIXTURE],
      cwd: o.cwd ?? work,
      vars: o.vars ?? {},
    });
    opened.push(t);
    return t;
  };

  test("listTools 与 callTool 往返", async () => {
    const t = remote();
    const client = new McpClient({ name: "t", version: "0.0.0" });
    await client.connect(t);
    expect((await client.listTools()).map((x) => x.name).sort()).toEqual([
      "echo",
      "env",
      "fail",
    ]);
    const res = await client.callTool("echo", { text: "hi" });
    expect(res.content).toEqual([{ type: "text", text: "echo:hi" }]);
    await client.close();
  }, 20000);

  test("变量原样传给远端进程，不被二次展开", async () => {
    const t = remote({
      vars: { A_DOLLAR: "$HOME", B_BANG: "!echo hacked", C_QUOTE: "it's" },
    });
    const client = new McpClient({ name: "t", version: "0.0.0" });
    await client.connect(t);
    const read = async (name: string) => {
      const res = await client.callTool("env", { name });
      const block = res.content[0];
      return block && block.type === "text" ? block.text : "";
    };
    expect(await read("A_DOLLAR")).toBe("$HOME");
    expect(await read("B_BANG")).toBe("!echo hacked");
    expect(await read("C_QUOTE")).toBe("it's");
    await client.close();
  }, 20000);

  test("临时脚本写完后已被自删", async () => {
    const s = spy(host);
    const t = remote({ env: s.env });
    const client = new McpClient({ name: "t", version: "0.0.0" });
    await client.connect(t);
    expect(s.scripts).toHaveLength(1);
    expect(s.scripts[0]).toMatch(/^\/tmp\/yuanshu-mcp-[0-9a-f]+\.sh$/);
    expect(existsSync(s.scripts[0] as string)).toBe(false);
    await client.close();
  }, 20000);

  test("读 stdin 的进程在 close() 后自行退出，不发整组 kill", async () => {
    const s = spy(host);
    const t = remote({
      env: s.env,
      args: [
        "-e",
        "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0))",
      ],
    });
    await t.start();
    await new Promise((ok) => setTimeout(ok, 300));
    const started = Date.now();
    await t.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s.kills).toEqual([]);
  }, 20000);

  test("不读 stdin 且起了孙进程：close() 之后整组都死", async () => {
    const pids = path.join(dir, "pids.json");
    const s = spy(host);
    const t = remote({
      env: s.env,
      args: [
        "-e",
        `const fs=require("node:fs");const cp=require("node:child_process");const c=cp.spawn("sleep",["60"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify({self:process.pid,child:c.pid}));setInterval(()=>{},1000)`,
      ],
    });
    await t.start();
    const deadline = Date.now() + 5000;
    while (!existsSync(pids) && Date.now() < deadline)
      await new Promise((ok) => setTimeout(ok, 50));
    const { self, child } = JSON.parse(readFileSync(pids, "utf8")) as {
      self: number;
      child: number;
    };
    expect(isAlive(self)).toBe(true);
    expect(isAlive(child)).toBe(true);
    await t.close();
    // 整组 kill 之后给一点时间让信号生效
    const gone = Date.now() + 3000;
    while ((isAlive(self) || isAlive(child)) && Date.now() < gone)
      await new Promise((ok) => setTimeout(ok, 100));
    expect(isAlive(self)).toBe(false);
    expect(isAlive(child)).toBe(false);
    expect(s.kills.length).toBeGreaterThan(0);
  }, 20000);

  test("进程自己先退出后再 close()，不发整组 kill", async () => {
    const s = spy(host);
    const t = remote({ env: s.env, args: ["-e", "process.exit(0)"] });
    const closed = new Promise<void>((ok) => t.onClose(ok));
    await t.start();
    await closed;
    await t.close();
    expect(s.kills).toEqual([]);
  }, 20000);

  test("cwd 不存在时 stderr 里有该路径，且不带内部的进程组标记", async () => {
    const gone = path.join(dir, "no-such-dir");
    const t = transport({ cwd: gone });
    await t.start();
    await new Promise<void>((ok) => t.onClose(ok));
    expect(t.stderr).toContain(gone);
    expect(t.stderr).not.toContain("YUANSHU_PGID");
  }, 20000);

  test("命令不存在时 stderr 里有 not found", async () => {
    const t = transport({ command: "no-such-mcp-binary" });
    await t.start();
    await new Promise<void>((ok) => t.onClose(ok));
    expect(t.stderr.toLowerCase()).toContain("not found");
  }, 20000);
});
