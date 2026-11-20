import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { type Db, openDatabase } from "../store/db.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { SshConnectError, SshConnection } from "./connection.js";

// 握手中途出问题时，连接只能以 SshConnectError 失败，绝不能让进程崩溃。
// 这里不需要 sshd：用一个假的 TCP 服务端扮演「能连上但握手完不成」的对端。
// 若没有常驻的 error 监听，ssh2 的第二次 error 会成为未捕获异常，vitest 会把它报成 Unhandled Error 并使整次运行失败。

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function setup(onSocket: (s: Socket) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-ssh-hs-"));
  const db: Db = openDatabase(dir);
  const secrets = new SecretStore(db, loadMasterKey(dir));
  const server: Server = createServer(onSocket);
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  cleanups.push(
    () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
    () => db.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  return new Promise<{ conn: SshConnection }>((res) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      res({
        conn: new SshConnection(
          { host: "127.0.0.1", port, username: "u", secretId: null },
          secrets,
        ),
      });
    }),
  );
}

// 让事件循环多转几圈：第二次 error 在 socket 关闭之后才到
const settle = () => new Promise((r) => setTimeout(r, 300));

test("对端接受后立刻断开：连接以 SshConnectError 失败，进程不崩", async () => {
  const { conn } = await setup((s) => s.destroy());
  const err = await conn.connect().catch((e) => e);
  expect(err).toBeInstanceOf(SshConnectError);
  await settle();
  conn.close();
});

test("对端接受后发一行非 SSH 内容再关闭：同样只是失败", async () => {
  const { conn } = await setup((s) => {
    s.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    s.end();
  });
  const err = await conn.connect().catch((e) => e);
  expect(err).toBeInstanceOf(SshConnectError);
  await settle();
  conn.close();
});

// ssh2 的两次 error：socket 先报错（ECONNRESET），随后 close 时因为「连上了但没收到过横幅」再报一次
// "Connection lost before handshake"。必须是连上之后才 RST，才会走到第二次。
test("连上之后、横幅之前被对端 RST：第二次 error 不能变成未捕获异常", async () => {
  const { conn } = await setup((s) => {
    setTimeout(() => s.resetAndDestroy(), 80);
  });
  const err = await conn.connect().catch((e) => e);
  expect(err).toBeInstanceOf(SshConnectError);
  await settle();
  conn.close();
});

test("连上之后、横幅之前对端直接关闭：同样只是失败", async () => {
  const { conn } = await setup((s) => {
    setTimeout(() => s.destroy(), 80);
  });
  const err = await conn.connect().catch((e) => e);
  expect(err).toBeInstanceOf(SshConnectError);
  await settle();
  conn.close();
});

test("握手失败后可以再试：失败的连接不留半截状态", async () => {
  let n = 0;
  const { conn } = await setup((s) => {
    n++;
    s.destroy();
  });
  await expect(conn.connect()).rejects.toBeInstanceOf(SshConnectError);
  await expect(conn.connect()).rejects.toBeInstanceOf(SshConnectError);
  expect(n).toBe(2);
  await settle();
});

// TCP 已经连上，之后在出示主机密钥之前断掉，是握手阶段的失败，不能算「TCP 连接」失败。
test.each([
  ["立刻关闭", (s: Socket) => s.destroy()],
  [
    "回非 SSH 内容再关闭",
    (s: Socket) => {
      s.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      s.end();
    },
  ],
  ["RST", (s: Socket) => setTimeout(() => s.resetAndDestroy(), 80)],
])(
  "对端%s：失败归在握手（hostkey 阶段），不是 tcp",
  async (_name, onSocket) => {
    const { conn } = await setup(onSocket);
    const err = await conn.connect().catch((e) => e);
    expect(err).toBeInstanceOf(SshConnectError);
    expect(err).toMatchObject({ stage: "hostkey", code: "handshake_failed" });
    await settle();
  },
);
