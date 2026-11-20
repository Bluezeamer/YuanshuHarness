import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { hasSshd, startSshd, type TestSshd } from "../../test/support/sshd.js";
import { openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { EnvHub } from "./hub.js";
import type { ExecEnv } from "./types.js";
import { VirtualPiEnv } from "./virtual-pi.js";

const REMOTE_HOME = "/remote/home";

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "yuanshu-virtual-pi-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// 只记调用、不碰文件系统的内层环境：用来分辨哪些调用被镜像目录接走了。
function stubEnv(): ExecEnv & { calls: string[] } {
  const calls: string[] = [];
  const deny = (name: string) => async () => {
    calls.push(name);
    throw new Error(`inner ${name}`);
  };
  return {
    calls,
    id: "ssh-1",
    kind: "ssh",
    os: "posix",
    homedir: async () => {
      calls.push("homedir");
      return REMOTE_HOME;
    },
    stat: deny("stat"),
    lstat: deny("lstat"),
    realpath: deny("realpath"),
    readdir: deny("readdir"),
    readlink: deny("readlink"),
    readFile: deny("readFile"),
    writeFile: deny("writeFile"),
    mkdirp: deny("mkdirp"),
    rename: deny("rename"),
    remove: deny("remove"),
    readStream: deny("readStream"),
    writeStream: deny("writeStream"),
    exec: async () => {
      calls.push("exec");
      return { exitCode: 0 };
    },
  } as ExecEnv & { calls: string[] };
}

test("<remoteHome>/.pi 下的文件原语落在本机镜像目录，不回到远端", async () => {
  const root = tempDir();
  const inner = stubEnv();
  const env = new VirtualPiEnv(inner, root, async () => REMOTE_HOME);
  expect(env.id).toBe("ssh-1");
  expect(env.kind).toBe("ssh");
  expect(await env.homedir()).toBe(REMOTE_HOME);

  await env.mkdirp(path.posix.join(REMOTE_HOME, ".pi", "agent"));
  await env.writeFile(path.posix.join(REMOTE_HOME, ".pi", "agent", "x"), "hi");
  expect(
    (
      await env.readFile(path.posix.join(REMOTE_HOME, ".pi", "agent", "x"))
    ).toString(),
  ).toBe("hi");
  expect(
    (await env.readdir(path.posix.join(REMOTE_HOME, ".pi", "agent"))).map(
      (e) => e.name,
    ),
  ).toEqual(["x"]);
  expect(
    (await env.stat(path.posix.join(REMOTE_HOME, ".pi", "agent", "x")))?.size,
  ).toBe(2);
  // 镜像目录本身也算：`~/.pi` 不带结尾斜杠时同样重定向
  expect(
    (await env.lstat(path.posix.join(REMOTE_HOME, ".pi")))?.isDirectory,
  ).toBe(true);

  await env.rename(
    path.posix.join(REMOTE_HOME, ".pi", "agent", "x"),
    path.posix.join(REMOTE_HOME, ".pi", "agent", "y"),
  );
  expect(inner.calls).toEqual(["homedir"]);
});

test("<remoteHome>/.pi 之外的路径照旧走内层环境", async () => {
  const inner = stubEnv();
  const env = new VirtualPiEnv(inner, tempDir(), async () => REMOTE_HOME);

  await expect(
    env.readFile(path.posix.join(REMOTE_HOME, "other", "x")),
  ).rejects.toThrow(/inner readFile/);
  await expect(env.readFile("/etc/hostname")).rejects.toThrow(/inner readFile/);
  expect(inner.calls).toEqual(["readFile", "readFile"]);
});

// openTcp 跟着 inner 走：inner 没实现就不冒充实现（代理据此判断能否转发端口）。
test("openTcp 透传给内层环境；内层没有就不定义", async () => {
  const inner = stubEnv();
  expect(new VirtualPiEnv(inner, tempDir(), async () => null).openTcp).toBe(
    undefined,
  );

  const calls: number[] = [];
  inner.openTcp = async (port: number) => {
    calls.push(port);
    return null as never;
  };
  const env = new VirtualPiEnv(inner, tempDir(), async () => REMOTE_HOME);
  await env.openTcp?.(3000);
  expect(calls).toEqual([3000]);
});

test("exec 不重定向：命令原样交给内层环境", async () => {
  const inner = stubEnv();
  const env = new VirtualPiEnv(inner, tempDir(), async () => REMOTE_HOME);
  const r = await env.exec("cat ~/.pi/agent/settings.json", REMOTE_HOME, {
    onData: () => {},
  });
  expect(r.exitCode).toBe(0);
  expect(inner.calls).toEqual(["exec"]);
});

test("remoteHome 未知（null）时整层直通", async () => {
  const inner = stubEnv();
  const env = new VirtualPiEnv(inner, tempDir(), async () => null);
  await expect(
    env.readFile(path.posix.join(REMOTE_HOME, ".pi", "x")),
  ).rejects.toThrow(/inner readFile/);
});

test("remoteHome 惰性解析：首次用到才取，之后不再问内层", async () => {
  const inner = stubEnv();
  let calls = 0;
  const env = new VirtualPiEnv(inner, tempDir(), async () => {
    calls += 1;
    return REMOTE_HOME;
  });
  expect(calls).toBe(0);
  const file = path.posix.join(REMOTE_HOME, ".pi", "agent", "y");
  await env.mkdirp(path.posix.join(REMOTE_HOME, ".pi", "agent"));
  await env.writeFile(file, "hi");
  expect((await env.readFile(file)).toString()).toBe("hi");
  expect(calls).toBe(1);
  // 取不到家目录时按直通处理，下次再试
  const unreachable = new VirtualPiEnv(inner, tempDir(), async () => {
    throw new Error("not connected");
  });
  await expect(
    unreachable.readFile(path.posix.join(REMOTE_HOME, ".pi", "x")),
  ).rejects.toThrow(/not connected/);
});

test("镜像目录首次写入时自动建出来", async () => {
  const root = tempDir();
  const env = new VirtualPiEnv(stubEnv(), root, async () => REMOTE_HOME);
  const file = path.posix.join(REMOTE_HOME, ".pi", "a", "b", "c.json");
  await env.writeFile(file, "{}");
  expect((await env.readFile(file)).toString()).toBe("{}");
  expect(statSync(path.join(root, "a", "b")).isDirectory()).toBe(true);
});

// EnvHub.get 给 ssh 环境包上虚拟 ~/.pi（真实回环 sshd）。
test.skipIf(!hasSshd)(
  "EnvHub.get：<home>/.pi 下的写入落在数据目录的镜像里，别的路径照旧走主机",
  async () => {
    const sshd: TestSshd = await startSshd();
    const dir = tempDir();
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const db = openDatabase(dataDir);
    let hub: EnvHub | undefined;
    try {
      const environments = new EnvironmentStore(db);
      const secrets = new SecretStore(db, loadMasterKey(dataDir));
      const key = secrets.create("k", "ssh_key", sshd.privateKey);
      const rec = environments.create({
        name: "loop",
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        os: "posix",
        secretId: key?.id ?? null,
      });
      if (!rec) throw new Error("环境没建成");
      hub = new EnvHub(
        environments,
        secrets,
        undefined,
        undefined,
        undefined,
        undefined,
        dataDir,
      );
      const env = hub.get(rec.id) as ExecEnv;
      expect(env).not.toBe(hub.getSsh(rec.id));
      const home = await env.homedir();

      const inside = path.posix.join(home, ".pi", "agent", "x.json");
      await env.writeFile(inside, "{}");
      const mirror = path.join(
        dataDir,
        "virtual-pi",
        rec.id,
        "agent",
        "x.json",
      );
      expect(readFileSync(mirror, "utf8")).toBe("{}");
      // 远端真的有这个文件才算“没重定向”：这里应该没有。
      const ssh = hub.getSsh(rec.id);
      if (!ssh) throw new Error("ssh 环境不存在");
      expect(await ssh.readFile(inside).catch(() => null)).toBeNull();

      const outside = path.posix.join(home, ".yuanshu-test-virtual-pi");
      await env.writeFile(outside, "plain");
      try {
        expect((await ssh.readFile(outside)).toString()).toBe("plain");
        expect(
          await env
            .readFile(path.join(dataDir, "virtual-pi", rec.id, outside))
            .catch(() => null),
        ).toBeNull();
      } finally {
        await ssh.remove(outside);
      }
    } finally {
      hub?.close();
      db.close();
      await sshd.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);
