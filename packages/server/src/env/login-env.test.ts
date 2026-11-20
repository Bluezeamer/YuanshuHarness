import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { RemoteStdioTransport } from "../mcp/remote-transport.js";
import type { SshConnection } from "../ssh/connection.js";
import { captureLoginEnv, diffEnv, parseEnv } from "./login-env.js";
import { SshEnv } from "./ssh.js";

const block = (vars: Record<string, string>) =>
  Buffer.from(
    `<<<YS_ENV_BEGIN>>>${Object.entries(vars)
      .map(([k, v]) => `${k}=${v}\0`)
      .join("")}<<<YS_ENV_END>>>`,
  );

describe("parseEnv / diffEnv", () => {
  test("丢掉标记之外的 rc 输出与 stderr 噪声；值里可以有 = 与换行", () => {
    const out = Buffer.concat([
      Buffer.from("bash: no job control in this shell\nwelcome!\n"),
      block({ A: "1", B: "x=y", C: "l1\nl2" }),
      Buffer.from("logout\n"),
    ]);
    expect(parseEnv(out)).toEqual({ A: "1", B: "x=y", C: "l1\nl2" });
  });

  test("标记不全（被 rc 脚本截断）返回 null；不合法的变量名被跳过", () => {
    expect(parseEnv(Buffer.from("<<<YS_ENV_BEGIN>>>A=1\0"))).toBeNull();
    expect(parseEnv(Buffer.from("nothing"))).toBeNull();
    expect(parseEnv(block({ "A-B": "1", "1X": "2", OK: "3" }))).toEqual({
      OK: "3",
    });
  });

  test("只留新增与改值的变量，去掉随进程而变的那些", () => {
    expect(
      diffEnv(
        { PATH: "/usr/bin", HOME: "/h", KEEP: "same" },
        {
          PATH: "/h/.local/bin:/usr/bin",
          HOME: "/h",
          KEEP: "same",
          NVM_DIR: "/h/.nvm",
          PWD: "/h",
          SHLVL: "2",
          _: "/usr/bin/env",
          SSH_CONNECTION: "a b c d",
          BASH_FUNC_x: "() { :; }",
        },
      ),
    ).toEqual({ PATH: "/h/.local/bin:/usr/bin", NVM_DIR: "/h/.nvm" });
  });
});

describe("captureLoginEnv", () => {
  const BASE = { PATH: "/usr/bin" };
  const LOGIN = { PATH: "/h/.local/bin:/usr/bin", NVM_DIR: "/h/.nvm" };
  const run =
    (answers: { lic: Buffer | null; lc: Buffer | null }) =>
    async (command: string) => {
      if (command.startsWith("printf")) return block(BASE);
      const a = command.includes("-lic") ? answers.lic : answers.lc;
      return a ?? Buffer.from("garbage without markers");
    };

  test("交互登录 shell（-lic）给出结果就用它", async () => {
    const r = await captureLoginEnv(run({ lic: block(LOGIN), lc: null }));
    expect(r).toEqual({ vars: LOGIN, complete: true });
  });

  test("-lic 被 rc 脚本截断时退回 -lc", async () => {
    const lc = block({ PATH: "/h/.local/bin:/usr/bin" });
    const r = await captureLoginEnv(run({ lic: null, lc }));
    expect(r).toEqual({
      vars: { PATH: "/h/.local/bin:/usr/bin" },
      complete: true,
    });
  });

  test("两种都拿不到、或 env -0 不支持：不注入，但算完整（可缓存）", async () => {
    expect(await captureLoginEnv(run({ lic: null, lc: null }))).toEqual({
      vars: {},
      complete: true,
    });
    expect(
      await captureLoginEnv(async () => Buffer.from("env: invalid option")),
    ).toEqual({ vars: {}, complete: true });
  });

  test("通道层面出错：不算完整，调用方不该缓存", async () => {
    const r = await captureLoginEnv(async () => {
      throw new Error("Channel open failure");
    });
    expect(r).toEqual({ vars: {}, complete: false });
  });
});

interface Seen {
  command: string;
  stdin?: string;
}

// 只实现 SshEnv 用到的那几个方法；按命令内容应答抓取，其余当作用户命令记下来。
function fakeConn(login: Buffer | null = block(LOGIN_VARS)) {
  const seen: Seen[] = [];
  let captures = 0;
  let fail = false;
  const conn = {
    isConnected: () => true,
    connect: async () => {},
    execStream: async (
      command: string,
      o: { onData: (d: Buffer) => void; stdin?: string },
    ) => {
      if (command.startsWith("printf") || command.includes("<<<YS_ENV")) {
        captures++;
        if (fail) throw new Error("Channel open failure");
        o.onData(
          command.startsWith("printf")
            ? block({ PATH: "/usr/bin" })
            : (login ?? Buffer.alloc(0)),
        );
      } else {
        seen.push({
          command,
          ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
        });
      }
      return { exitCode: 0, signal: null, aborted: false, timedOut: false };
    },
  };
  return {
    conn: conn as unknown as SshConnection,
    seen,
    captures: () => captures,
    failNext: (v: boolean) => {
      fail = v;
    },
  };
}
const LOGIN_VARS = { PATH: "/h/.local/bin:/usr/bin", NVM_DIR: "/h/.nvm" };

describe("SshEnv：登录环境注入 exec", () => {
  const noop = { onData: () => {} };

  test("exec 带上登录环境；登记的变量覆盖同名登录变量；只抓取一次", async () => {
    const f = fakeConn();
    const env = new SshEnv("h", "posix", f.conn);
    await env.exec("node -v", "/work", noop);
    await env.exec("node -v", "/work", {
      ...noop,
      env: { NVM_DIR: "/override" },
    });
    expect(f.captures()).toBe(2); // 一次抓取 = env -0 加 -lic，第二条命令复用缓存
    const [a, b] = f.seen;
    expect(a?.command).toMatch(/^eval "\$\(head -c \d+\)"$/);
    expect(a?.command).toContain(
      `head -c ${Buffer.byteLength(a?.stdin ?? "")})`,
    );
    expect(a?.stdin).toContain("export PATH='/h/.local/bin:/usr/bin'");
    expect(a?.stdin).toContain("export NVM_DIR='/h/.nvm'");
    expect(a?.stdin).toContain("cd '/work' && {");
    expect(b?.stdin).toContain("export NVM_DIR='/override'");
    expect(b?.stdin).not.toContain("/h/.nvm");
  });

  test("refreshLoginEnv 重抓；通道出错不缓存，下一次重试", async () => {
    const f = fakeConn();
    const env = new SshEnv("h", "posix", f.conn);
    await env.loginEnv();
    await env.refreshLoginEnv();
    expect(f.captures()).toBe(4);

    const g = fakeConn();
    const e2 = new SshEnv("h", "posix", g.conn);
    g.failNext(true);
    expect(await e2.loginEnv()).toEqual({});
    g.failNext(false);
    expect(await e2.loginEnv()).toEqual(LOGIN_VARS);
  });

  test("Windows 主机不抓", async () => {
    const f = fakeConn();
    const env = new SshEnv("h", "windows", f.conn);
    expect(await env.loginEnv()).toEqual({});
    expect(f.captures()).toBe(0);
  });
});

describe("MCP 远端启动脚本", () => {
  test("登录环境在前、登记的变量在后", async () => {
    let script = "";
    const host = {
      os: "posix",
      loginEnv: async () => ({ PATH: "/h/.local/bin:/usr/bin", NVM_DIR: "/n" }),
      writeStream: async () =>
        new Writable({
          write(c, _e, done) {
            script += c.toString();
            done();
          },
        }),
      remove: async () => {},
      openStdio: async () => {
        throw new Error("stop here");
      },
    };
    const t = new RemoteStdioTransport({
      env: host as never,
      command: "npx",
      args: ["-y", "x"],
      cwd: "/w",
      vars: { NVM_DIR: "/mine", TOKEN: "t" },
    });
    await expect(t.start()).rejects.toThrow("stop here");
    const lines = script.split("\n");
    const at = (p: string) => lines.findIndex((l) => l.startsWith(p));
    expect(lines).toContain("export PATH='/h/.local/bin:/usr/bin'");
    expect(lines).toContain("export NVM_DIR='/mine'");
    expect(lines).toContain("export TOKEN='t'");
    expect(at("export PATH")).toBeLessThan(at("cd "));
  });

  test("取登录环境失败不挡启动", async () => {
    let script = "";
    const host = {
      os: "posix",
      loginEnv: async () => {
        throw new Error("boom");
      },
      writeStream: async () =>
        new Writable({
          write(c, _e, done) {
            script += c.toString();
            done();
          },
        }),
      remove: async () => {},
      openStdio: async () => {
        throw new Error("stop here");
      },
    };
    const t = new RemoteStdioTransport({
      env: host as never,
      command: "npx",
      args: [],
      cwd: "/w",
      vars: { A: "1" },
    });
    await expect(t.start()).rejects.toThrow("stop here");
    expect(script).toContain("export A='1'");
  });
});
