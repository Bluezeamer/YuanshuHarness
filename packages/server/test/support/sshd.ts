import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const SSHD_BIN = "/usr/sbin/sshd";
export const hasSshd = existsSync(SSHD_BIN);

export interface TestSshd {
  port: number;
  user: string;
  privateKey: string;
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => ok(port));
    });
  });
}

// 在临时目录起一个只监听回环、只认一把临时密钥的用户态 sshd。
export async function startSshd(): Promise<TestSshd> {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-sshd-"));
  const gen = (name: string) =>
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, name)]);
  gen("host");
  gen("client");
  const auth = path.join(dir, "authorized_keys");
  writeFileSync(auth, readFileSync(path.join(dir, "client.pub")), { mode: 0o600 });
  const port = await freePort();
  const config = path.join(dir, "sshd_config");
  writeFileSync(
    config,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${path.join(dir, "host")}`,
      `AuthorizedKeysFile ${auth}`,
      `PidFile ${path.join(dir, "sshd.pid")}`,
      "PasswordAuthentication no",
      "UsePAM no",
      "StrictModes no",
      "Subsystem sftp internal-sftp",
    ].join("\n"),
  );
  // -D 前台运行，由测试进程持有并负责结束。
  const child = spawn(SSHD_BIN, ["-D", "-e", "-f", config], { stdio: "ignore" });
  await new Promise<void>((ok, fail) => {
    const deadline = Date.now() + 5000;
    const probe = () => {
      const c = net.connect(port, "127.0.0.1");
      c.once("connect", () => {
        c.destroy();
        ok();
      });
      c.once("error", () =>
        Date.now() > deadline ? fail(new Error("sshd 未能启动")) : setTimeout(probe, 50),
      );
    };
    probe();
  });
  return {
    port,
    user: execFileSync("id", ["-un"]).toString().trim(),
    privateKey: readFileSync(path.join(dir, "client"), "utf8"),
    async close() {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
