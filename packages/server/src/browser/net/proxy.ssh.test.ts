import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
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
import {
  hasSshd,
  startSshd,
  type TestSshd,
} from "../../../test/support/sshd.js";
import { SshEnv } from "../../env/ssh.js";
import type { ExecEnv } from "../../env/types.js";
import { SshConnection } from "../../ssh/connection.js";
import { type Db, openDatabase } from "../../store/db.js";
import { loadMasterKey, SecretStore } from "../../store/secrets.js";
import { serviceHost } from "./hostnames.js";
import { startProxy } from "./proxy.js";

// 真实 sshd（回环、用户态）+ 真实 SshEnv：代理经 direct-tcpip 通道到「远端」的服务。
// proxy.test.ts 里的 sshlike 只是包了一层 Duplex 的本机连接，这里补上真通道。
describe.skipIf(!hasSshd)("代理经真实 ssh 通道转发", () => {
  let dir: string;
  let db: Db;
  let backend: http.Server;
  let backendPort: number;
  let echo: net.Server;
  let echoPort: number;
  const closers: Array<() => Promise<void> | void> = [];

  beforeAll(async () => {
    backend = http.createServer((req, res) =>
      res.end(`backend ${req.method} ${req.url} host=${req.headers.host}`),
    );
    await new Promise<void>((ok) => backend.listen(0, "127.0.0.1", ok));
    backendPort = (backend.address() as net.AddressInfo).port;
    echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((ok) => echo.listen(0, "127.0.0.1", ok));
    echoPort = (echo.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    backend.closeAllConnections();
    backend.close();
    echo.close();
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yuanshu-proxy-ssh-"));
    db = openDatabase(dir);
  });
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 起一个 sshd、连上，把它当环境 `ssh1` 挂到一个新代理上。 */
  async function setup(extra: string[] = []) {
    const sshd: TestSshd = await startSshd(extra);
    closers.push(() => sshd.close());
    const secrets = new SecretStore(db, loadMasterKey(dir));
    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    const env = new SshEnv(
      "ssh1",
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
    await env.connect();
    closers.push(() => env.close?.());
    const proxy = await startProxy({
      env: (id) => (id === "ssh1" ? (env as ExecEnv) : null),
    });
    closers.push(() => proxy.close());
    const reg = proxy.register({
      loopbackEnvId: null,
      allowService: () => true,
      allowFile: () => true,
    });
    const basic = `Basic ${Buffer.from(`${reg.token}:x`).toString("base64")}`;
    return { proxy, basic };
  }

  const get = (proxyPort: number, basic: string, url: string) =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: url,
          headers: { host: new URL(url).host, "Proxy-Authorization": basic },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", fail);
      req.end();
    });

  test("普通 HTTP：经 ssh 通道到远端回环上的服务，Host 保持虚拟主机名", async () => {
    const { proxy, basic } = await setup();
    const r = await get(
      proxy.port,
      basic,
      `http://${serviceHost("ssh1", backendPort)}/hello`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe(
      `backend GET /hello host=${serviceHost("ssh1", backendPort)}`,
    );
  });

  test("CONNECT：原始字节经 ssh 通道双向往返（WebSocket、https 走这条）", async () => {
    const { proxy, basic } = await setup();
    const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
    await once(socket, "connect");
    const authority = serviceHost("ssh1", echoPort);
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${basic}\r\n\r\n`,
    );
    let head = "";
    while (!head.includes("\r\n\r\n")) {
      const [c] = (await once(socket, "data")) as [Buffer];
      head += c.toString("latin1");
    }
    expect(head).toContain(" 200 ");
    socket.write("ping-through-ssh");
    const [back] = (await once(socket, "data")) as [Buffer];
    expect(back.toString()).toBe("ping-through-ssh");
    socket.destroy();
  });

  test("远端端口没有服务：502，页面上写明是哪个端口连不上", async () => {
    const { proxy, basic } = await setup();
    const closed = await new Promise<number>((ok) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => ok(p));
      });
    });
    const r = await get(
      proxy.port,
      basic,
      `http://${serviceHost("ssh1", closed)}/`,
    );
    expect(r.status).toBe(502);
    expect(r.body).toContain(`远端 localhost:${closed} 连不上`);
  });

  test("远端 sshd 禁止了端口转发：502，页面上点明是 sshd 的 AllowTcpForwarding", async () => {
    const { proxy, basic } = await setup(["AllowTcpForwarding no"]);
    const r = await get(
      proxy.port,
      basic,
      `http://${serviceHost("ssh1", backendPort)}/`,
    );
    expect(r.status).toBe(502);
    expect(r.body).toContain("AllowTcpForwarding");
  });
});
