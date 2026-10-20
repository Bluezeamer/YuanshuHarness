import { describe, expect, test } from "vitest";
import {
  isRootShell,
  parseSudo,
  probeCommandLine,
  SudoProbe,
  type SudoState,
} from "./sudo.js";

describe("parseSudo", () => {
  test("不是 sudo 返回 null；带路径的 sudo 也认", () => {
    expect(parseSudo(["ls"])).toBeNull();
    expect(parseSudo(["/usr/bin/sudo", "ls"])?.cmd).toEqual(["ls"]);
  });

  test("-S / -n / -s / -i 与长选项", () => {
    expect(parseSudo(["sudo", "-S", "ls"])).toMatchObject({ stdin: true });
    expect(parseSudo(["sudo", "--stdin", "ls"])).toMatchObject({ stdin: true });
    expect(parseSudo(["sudo", "-n", "ls"])).toMatchObject({ noPrompt: true });
    expect(parseSudo(["sudo", "--non-interactive", "ls"])).toMatchObject({
      noPrompt: true,
    });
    expect(parseSudo(["sudo", "-s"])).toMatchObject({ shell: true });
    expect(parseSudo(["sudo", "-i"])).toMatchObject({ shell: true });
    expect(parseSudo(["sudo", "--login"])).toMatchObject({ shell: true });
  });

  test("短选项簇与带值选项：值不当成命令", () => {
    const p = parseSudo([
      "sudo",
      "-Sp",
      "",
      "-u",
      "root",
      "systemctl",
      "restart",
      "x",
    ]);
    expect(p).toMatchObject({
      stdin: true,
      cmd: ["systemctl", "restart", "x"],
    });
    expect(parseSudo(["sudo", "-u", "root", "ls"])?.cmd).toEqual(["ls"]);
  });

  test("VAR=value 与 -- 之后才是命令", () => {
    expect(parseSudo(["sudo", "A=1", "B=2", "make"])?.cmd).toEqual(["make"]);
    expect(parseSudo(["sudo", "--", "-weird"])?.cmd).toEqual(["-weird"]);
  });
});

describe("isRootShell", () => {
  test.each([
    "su",
    "su - root",
    "sudo -s",
    "sudo -i",
    "sudo --login",
    "sudo bash",
    "sudo -u root zsh",
    "ls && sudo sh",
  ])("%s：是", async (line) => {
    expect(await isRootShell(line)).toBe(true);
  });

  test.each([
    "ls",
    "sudo ls",
    "sudo -S apt-get update",
    "sudo bash -c 'id'",
    "sudo sh -c id",
    "echo su",
    "cat /etc/sudoers",
  ])("%s：不是", async (line) => {
    expect(await isRootShell(line)).toBe(false);
  });

  test("解析不了的命令行退回粗匹配，宁可多问", async () => {
    expect(await isRootShell("sudo -i > /tmp/out")).toBe(true);
    expect(await isRootShell("sudo ls > /tmp/out")).toBe(false);
  });
});

describe("SudoProbe", () => {
  function fakeEnv(
    id: string,
    reply: { exitCode: number; out?: string } | Error,
  ) {
    const scripts: string[] = [];
    const env = {
      id,
      exec: async (
        script: string,
        _cwd: string,
        o: { onData: (b: Buffer) => void },
      ) => {
        scripts.push(script);
        if (reply instanceof Error) throw reply;
        if (reply.out) o.onData(Buffer.from(reply.out));
        return { exitCode: reply.exitCode };
      },
    };
    return { env: env as never, scripts };
  }

  test("退出 0 为免密；输出 a password is required 为需要密码；其余认不出", async () => {
    const probe = new SudoProbe();
    expect(
      await probe.probe(fakeEnv("a", { exitCode: 0 }).env, "/w", ["ls"]),
    ).toBe("nopasswd");
    expect(
      await probe.probe(
        fakeEnv("b", { exitCode: 1, out: "sudo: a password is required\n" })
          .env,
        "/w",
        ["ls"],
      ),
    ).toBe("password");
    expect(
      await probe.probe(
        fakeEnv("c", { exitCode: 1, out: "Sorry, user x is not allowed\n" })
          .env,
        "/w",
        ["ls"],
      ),
    ).toBe("unknown");
    expect(
      await probe.probe(fakeEnv("d", new Error("连接断开")).env, "/w", ["ls"]),
    ).toBe("unknown");
  });

  test("探测脚本固定语言、参数逐个转义", async () => {
    const f = fakeEnv("a", { exitCode: 0 });
    await new SudoProbe().probe(f.env, "/w", ["-u", "root", "echo hi; id"]);
    expect(f.scripts[0]).toBe("LC_ALL=C sudo -n -l '-u' 'root' 'echo hi; id'");
  });

  test("同环境同命令在 TTL 内走缓存，到期重探；认不出的不缓存", async () => {
    let now = 0;
    const probe = new SudoProbe(() => now);
    const f = fakeEnv("a", { exitCode: 0 });
    await probe.probe(f.env, "/w", ["ls"]);
    await probe.probe(f.env, "/w", ["ls"]);
    expect(f.scripts).toHaveLength(1);
    await probe.probe(f.env, "/other", ["ls"]);
    expect(f.scripts).toHaveLength(2);
    now = 61_000;
    await probe.probe(f.env, "/w", ["ls"]);
    expect(f.scripts).toHaveLength(3);

    const bad = fakeEnv("b", { exitCode: 1, out: "usage: sudo\n" });
    await probe.probe(bad.env, "/w", ["ls"]);
    await probe.probe(bad.env, "/w", ["ls"]);
    expect(bad.scripts).toHaveLength(2);
  });

  test("invalidate 按环境丢缓存，缺省全清", async () => {
    const probe = new SudoProbe();
    const a = fakeEnv("a", { exitCode: 0 });
    const b = fakeEnv("b", { exitCode: 0 });
    await probe.probe(a.env, "/w", ["ls"]);
    await probe.probe(b.env, "/w", ["ls"]);
    probe.invalidate("a");
    await probe.probe(a.env, "/w", ["ls"]);
    await probe.probe(b.env, "/w", ["ls"]);
    expect([a.scripts.length, b.scripts.length]).toEqual([2, 1]);
    probe.invalidate();
    await probe.probe(b.env, "/w", ["ls"]);
    expect(b.scripts).toHaveLength(2);
  });
});

describe("probeCommandLine", () => {
  const by =
    (m: Record<string, SudoState>) => async (_cwd: string, args: string[]) =>
      m[args[0] as string] ?? "unknown";

  test("任一需要密码即需要密码；全部免密才免密", async () => {
    const probe = by({ a: "nopasswd", b: "password", c: "nopasswd" });
    expect(await probeCommandLine(probe, "sudo a && sudo b", "/w")).toBe(
      "password",
    );
    expect(await probeCommandLine(probe, "sudo a && sudo c", "/w")).toBe(
      "nopasswd",
    );
    expect(await probeCommandLine(probe, "sudo a && sudo z", "/w")).toBe(
      "unknown",
    );
  });

  test("没有 sudo 段、无法解析：认不出", async () => {
    const probe = by({ a: "nopasswd" });
    expect(await probeCommandLine(probe, "ls", "/w")).toBe("unknown");
    expect(await probeCommandLine(probe, "sudo a > /tmp/x", "/w")).toBe(
      "unknown",
    );
  });
});
