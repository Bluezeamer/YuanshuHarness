import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Server as SshServer, utils } from "ssh2";
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
import { ACTIVATION_STEPS } from "../env/activation.js";
import { EnvHub } from "../env/hub.js";
import { displayFingerprint } from "../ssh/fingerprint.js";
import { AuditLog } from "../store/audit.js";
import { ConnectionStore } from "../store/connections.js";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { connectionsApi } from "./connections.js";
import { environmentsApi } from "./environments.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let secrets: SecretStore;
let hub: EnvHub;
let audit: AuditLog;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-conn-"));
  db = openDatabase(dir);
  secrets = new SecretStore(db, loadMasterKey(dir));
  const environments = new EnvironmentStore(db);
  const connections = new ConnectionStore(db);
  audit = new AuditLog(db);
  hub = new EnvHub(environments, secrets, connections, audit);
  app = Fastify();
  app.register(environmentsApi, { environments, secrets, hub, audit });
  app.register(connectionsApi, { connections, secrets, hub, audit });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  hub.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) => app.inject({ method, url, ...(payload ? { payload } : {}) });

// 不需要真连接的密钥：随手生成一把格式合法的私钥
const freshKey = () => utils.generateKeyPairSync("ed25519").private;

const newSecret = (name: string, value = freshKey()) => {
  const s = secrets.create(name, "ssh_key", value);
  if (!s) throw new Error("密钥创建失败");
  return s.id;
};

const create = async (
  label: string,
  extra: Record<string, unknown> = {},
  secretId = newSecret(`k-${label}`),
) => {
  const r = await call("POST", "/api/v1/connections", {
    label,
    host: "127.0.0.1",
    port: 22,
    user: "u",
    auth: { kind: "key", secretId },
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string };
};

const get = async (id: string) =>
  (await call("GET", `/api/v1/connections/${id}`)).json();

const activate = (id: string) =>
  call("POST", `/api/v1/connections/${id}/activate`);

// 轮询到激活不再是 running
const settle = async (id: string) => {
  const deadline = Date.now() + 15000;
  for (;;) {
    const v = await get(id);
    if (v.activation && v.activation.state !== "running") return v;
    if (Date.now() > deadline) throw new Error("激活超时");
    await new Promise((ok) => setTimeout(ok, 25));
  }
};

const stepStates = (v: { activation: { steps: { state: string }[] } }) =>
  v.activation.steps.map((s) => s.state);

// 轮询到条件成立（服务端状态变化是异步的）
const until = async (cond: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((ok) => setTimeout(ok, 25));
  }
};

const logOf = async (id: string) =>
  (await call("GET", `/api/v1/connections/${id}/log`)).json().log as {
    type: string;
    text: string;
    detail: string;
  }[];

// 能连上 TCP、但不按 SSH 说话的假对端；onSocket 决定怎么表现（沉默、立刻关闭、回一行 HTTP…）。
function fakePeer(onSocket: (s: net.Socket) => void) {
  const socks = new Set<net.Socket>();
  const server = net.createServer((s) => {
    socks.add(s);
    s.on("close", () => socks.delete(s));
    s.on("error", () => {});
    onSocket(s);
  });
  return new Promise<{ port: number; close(): void }>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          for (const s of socks) s.destroy();
          server.close();
        },
      }),
    ),
  );
}

// 真实的 ssh2 服务端：认证全放行，让激活停在指定的一步。
// probe：接受 exec 后不应答，停在「远端探测」；channel：探测正常返回，sftp 请求不应答，停在「控制通道」。
function stallingSshServer(stallAt: "probe" | "channel") {
  const clients = new Set<{ end(): void }>();
  let realpathAsked = false;
  const server = new SshServer(
    { hostKeys: [utils.generateKeyPairSync("ed25519").private] },
    (client) => {
      clients.add(client);
      client.on("error", () => {});
      client.on("close", () => clients.delete(client));
      client.on("authentication", (ctx) => ctx.accept());
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec) => {
            const ch = acceptExec();
            if (stallAt === "probe") return;
            ch.write("Linux 6.1.0\nx86_64\n");
            ch.exit(0);
            ch.end();
          });
          session.on("sftp", (acceptSftp) => {
            acceptSftp().on("REALPATH", () => {
              realpathAsked = true; // 收到了，但不应答
            });
          });
        }),
      );
    },
  );
  return new Promise<{
    port: number;
    /** 控制通道的 realpath 请求已到达（并被晾着）。 */
    realpathAsked(): boolean;
    close(): void;
  }>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({
        port: (server.address() as net.AddressInfo).port,
        realpathAsked: () => realpathAsked,
        close: () => {
          for (const c of clients) c.end();
          server.close();
        },
      }),
    ),
  );
}

// 夹在客户端与真实 sshd 之间的 TCP 转发，dropAll 模拟网络中断（连接被对端 RST）。
function tcpProxy(target: number) {
  const socks = new Set<net.Socket>();
  const server = net.createServer((down) => {
    const up = net.connect(target, "127.0.0.1");
    for (const s of [down, up]) {
      socks.add(s);
      s.on("close", () => socks.delete(s));
      s.on("error", () => {});
    }
    down.pipe(up);
    up.pipe(down);
  });
  return new Promise<{ port: number; dropAll(): void; close(): void }>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({
        port: (server.address() as net.AddressInfo).port,
        dropAll: () => {
          for (const s of socks) s.resetAndDestroy?.();
        },
        close: () => {
          for (const s of socks) s.destroy();
          server.close();
        },
      }),
    ),
  );
}

describe("连接实体与引用约束", () => {
  test("创建后返回完整形状，密钥只以引用出现", async () => {
    const c = await create("a");
    const v = await get(c.id);
    expect(v).toMatchObject({
      label: "a",
      host: "127.0.0.1",
      port: 22,
      user: "u",
      os: "posix",
      auth: { kind: "key" },
      jump: [],
      chain: [],
      dependants: [],
      status: "inactive",
      hostKey: null,
      hostKeyChange: null,
      activation: null,
      policy: {
        keepAlive: true,
        reuseSession: true,
        hostKey: "ask",
        proxyJumpFallback: false,
      },
    });
    expect(JSON.stringify(v)).not.toContain("PRIVATE KEY");
    const list = (await call("GET", "/api/v1/connections")).json();
    expect(list.server).toEqual({
      host: "server",
      environmentId: "local",
      label: "本机",
    });
    expect(list.connections).toHaveLength(1);
  });

  test("字段校验：认证引用、密钥类型、重名", async () => {
    const bad = (extra: Record<string, unknown>) =>
      call("POST", "/api/v1/connections", {
        label: "x",
        host: "h",
        user: "u",
        auth: { secretId: "nope" },
        ...extra,
      });
    expect((await bad({})).json()).toEqual({ error: "invalid_auth" });
    const pw = secrets.create("pw", "password", "hunter2-secret");
    const r = await bad({ auth: { kind: "key", secretId: pw?.id } });
    expect(r.json()).toEqual({ error: "auth_kind_mismatch" });
    expect((await bad({ policy: { hostKey: "x" } })).statusCode).toBe(400);
    await create("dup");
    const again = await call("POST", "/api/v1/connections", {
      label: "dup",
      host: "h",
      user: "u",
      auth: { secretId: newSecret("k2") },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "name_exists" });
  });

  test("跳板环路与自引用被拒绝，链深上限 4", async () => {
    const a = await create("a");
    const b = await create("b", { jump: [a.id] });
    const self = await call("PATCH", `/api/v1/connections/${a.id}`, {
      jump: [a.id],
    });
    expect([self.statusCode, self.json().error]).toEqual([409, "jump_cycle"]);
    const loop = await call("PATCH", `/api/v1/connections/${a.id}`, {
      jump: [b.id],
    });
    expect([loop.statusCode, loop.json().error]).toEqual([409, "jump_cycle"]);
    // a ← b ← c ← d 已是 3 跳；再挂一层 e 是第 4 跳，f 就超限
    const c = await create("c", { jump: [b.id] });
    const d = await create("d", { jump: [c.id] });
    const e = await create("e", { jump: [d.id] });
    const f = await call("POST", "/api/v1/connections", {
      label: "f",
      host: "h",
      user: "u",
      auth: { secretId: newSecret("kf") },
      jump: [e.id],
    });
    expect([f.statusCode, f.json().error]).toEqual([409, "jump_too_deep"]);
    expect(
      (await get(e.id)).chain.map((x: { label: string }) => x.label),
    ).toEqual(["a", "b", "c", "d"]);
    const many = await call("POST", "/api/v1/connections", {
      label: "g",
      host: "h",
      user: "u",
      auth: { secretId: newSecret("kg") },
      jump: [a.id, b.id],
    });
    expect(many.json()).toEqual({ error: "invalid_jump" });
  });

  test("删除连接写审计：登记没了日志接口 404，审计里仍查得到是谁；被拒绝的不记", async () => {
    const a = await create("gone", {
      host: "10.0.0.9",
      port: 2200,
      user: "ops",
    });
    const b = await create("down", { jump: [a.id] });
    expect(
      (await call("DELETE", `/api/v1/connections/${a.id}`)).statusCode,
    ).toBe(409);
    expect(
      audit.list({ environment: a.id }).entries.map((e) => e.summary),
    ).toEqual(["新建连接"]);
    await call("DELETE", `/api/v1/connections/${b.id}`);
    expect(
      (await call("DELETE", `/api/v1/connections/${a.id}`)).statusCode,
    ).toBe(204);
    const [row] = audit.list({ environment: a.id }).entries;
    expect(row).toMatchObject({
      actor: "user",
      kind: "env",
      summary: "删除连接",
      detail: { op: "config", result: "ok", info: "gone · ops@10.0.0.9:2200" },
    });
    expect(JSON.stringify(row)).not.toContain("PRIVATE KEY");
    expect(
      (await call("GET", `/api/v1/connections/${a.id}/log`)).statusCode,
    ).toBe(404);
  });

  test("被当跳板的连接删除返回 409 带引用者；下游删掉后可删", async () => {
    const a = await create("a");
    const b = await create("b", { jump: [a.id] });
    const r = await call("DELETE", `/api/v1/connections/${a.id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({
      error: "referenced",
      referencedBy: [{ id: b.id, label: "b" }],
    });
    // 旧接口也不能绕过
    const old = await call("DELETE", `/api/v1/environments/${a.id}`);
    expect(old.statusCode).toBe(409);
    expect(
      (await call("DELETE", `/api/v1/connections/${b.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await call("DELETE", `/api/v1/connections/${a.id}`)).statusCode,
    ).toBe(204);
    expect((await get(a.id)).error).toBe("not_found");
  });

  test("改名不影响引用；清除跳板用 jump:[]", async () => {
    const a = await create("a");
    const b = await create("b", { jump: [a.id] });
    await call("PATCH", `/api/v1/connections/${a.id}`, { label: "a2" });
    expect((await get(b.id)).chain).toEqual([{ id: a.id, label: "a2" }]);
    await call("PATCH", `/api/v1/connections/${b.id}`, { jump: [] });
    expect((await get(b.id)).jump).toEqual([]);
  });

  test("下游依赖的跳板未激活：activate 被拒绝并指出是哪个跳板", async () => {
    const a = await create("a");
    const b = await create("b", { jump: [a.id] });
    const r = await call("POST", `/api/v1/connections/${b.id}/activate`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({
      error: "jump_inactive",
      jump: { id: a.id, label: "a" },
    });
    expect((await get(b.id)).activation).toBeNull();
  });

  test("密钥库：ssh_key 带指纹/类型/引用者，不含私钥", async () => {
    const key = freshKey();
    const id = newSecret("k", key);
    const c = await create("a", {}, id);
    secrets.create("pw", "password", "hunter2-secret");
    const list = (await call("GET", "/api/v1/secrets")).json().secrets;
    const k = list.find((s: { id: string }) => s.id === id);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(k.keyType).toBe("ssh-ed25519");
    expect(k.referencedBy).toEqual([{ id: c.id, label: "a" }]);
    const pw = list.find((s: { kind: string }) => s.kind === "password");
    expect(pw.fingerprint).toBeUndefined();
    expect(pw.referencedBy).toEqual([]);
    expect(JSON.stringify(list)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(list)).not.toContain("hunter2");
  });

  // 以下补自 remote-connections.smoke 核对：深层环路、整条下游连带断开、改地址作废主机密钥。
  test("深层环路：a ← b ← c 时把 a 的跳板设为 c 同样被拒，a 的跳板保持不变", async () => {
    const a = await create("a");
    const b = await create("b", { jump: [a.id] });
    const c = await create("c", { jump: [b.id] });
    const r = await call("PATCH", `/api/v1/connections/${a.id}`, {
      jump: [c.id],
    });
    expect([r.statusCode, r.json().error]).toEqual([409, "jump_cycle"]);
    expect((await get(a.id)).jump).toEqual([]);
    // 改接到链外的连接则放行，原跳板的下游随之更新
    const x = await create("x");
    const ok = await call("PATCH", `/api/v1/connections/${c.id}`, {
      jump: [x.id],
    });
    expect(ok.statusCode).toBe(200);
    expect((await get(b.id)).dependants).toEqual([]);
    expect((await get(x.id)).dependants).toEqual([{ id: c.id, label: "c" }]);
  });

  test("断开跳板连带整条下游链（含孙辈），自己在最前；断开中间一环不动上游", async () => {
    const a = await create("a");
    const b = await create("b", { jump: [a.id] });
    const c = await create("c", { jump: [b.id] });
    const labels = (r: { json(): { deactivated: { label: string }[] } }) =>
      r.json().deactivated.map((x) => x.label);
    expect(
      labels(await call("POST", `/api/v1/connections/${a.id}/deactivate`)),
    ).toEqual(["a", "b", "c"]);
    expect(
      labels(await call("POST", `/api/v1/connections/${b.id}/deactivate`)),
    ).toEqual(["b", "c"]);
    expect(
      labels(await call("POST", `/api/v1/connections/${c.id}/deactivate`)),
    ).toEqual(["c"]);
  });

  test("改 host 或 port 作废主机密钥记录（含待核对与历史）；改名、换用户、值没变都不动", async () => {
    const c = await create("a");
    const trusted = `ssh-ed25519:${"ab".repeat(32)}`;
    const seen = `ssh-ed25519:${"cd".repeat(32)}`;
    const seed = () =>
      db
        .prepare(
          `UPDATE environments SET host_key = ?, host_key_pending = ?,
             host_key_changed_from = ?, host_key_accepted_at = ? WHERE id = ?`,
        )
        .run(trusted, seen, trusted, "2026-10-01T00:00:00.000Z", c.id);
    const patch = (body: object) =>
      call("PATCH", `/api/v1/connections/${c.id}`, body);

    seed();
    for (const keep of [
      { label: "a2" },
      { user: "root" },
      { host: "127.0.0.1" },
      { port: 22 },
    ]) {
      const v = (await patch(keep)).json();
      expect(v.hostKey, JSON.stringify(keep)).not.toBeNull();
      expect(v.hostKeyChange, JSON.stringify(keep)).not.toBeNull();
    }
    for (const moved of [{ host: "10.0.0.2" }, { port: 2222 }]) {
      seed();
      const r = await patch(moved);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        hostKey: null,
        hostKeyChange: null,
        status: "inactive",
      });
    }
  });
});

describe("激活过程（假对端）", () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });
  const tcpPeer = async (onSocket: (s: net.Socket) => void) => {
    const p = await fakePeer(onSocket);
    closers.push(p.close);
    return p;
  };
  const sshPeer = async (stallAt: "probe" | "channel") => {
    const p = await stallingSshServer(stallAt);
    closers.push(p.close);
    return p;
  };
  const toPeer = (label: string, port: number) =>
    create(label, { port, user: "u", policy: { hostKey: "tofu" } });
  const cancel = (id: string) =>
    call("POST", `/api/v1/connections/${id}/deactivate`);
  const cancelled = (id: string) => async () =>
    (await logOf(id)).some((l) => l.text === "已取消激活");

  test("同时只允许一个激活：重复激活与另一条连接的激活都被服务端拒绝（409）", async () => {
    const peer = await tcpPeer(() => {}); // 连上后沉默，激活一直停在握手
    const a = await toPeer("a", peer.port);
    const b = await toPeer("b", peer.port);
    expect((await activate(a.id)).statusCode).toBe(202);

    const again = await activate(a.id);
    expect([again.statusCode, again.json()]).toEqual([
      409,
      { error: "activating" },
    ]);
    const other = await activate(b.id);
    expect([other.statusCode, other.json()]).toEqual([
      409,
      { error: "busy", activating: { id: a.id, label: "a" } },
    ]);
    const vb = await get(b.id);
    expect([vb.status, vb.activation]).toEqual(["inactive", null]);

    // 取消 a 之后立刻可以激活 b
    await cancel(a.id);
    expect((await activate(b.id)).statusCode).toBe(202);
    await cancel(b.id);
  });

  test("取消激活记为「已取消」，不是失败，也不再额外记一条「已断开」", async () => {
    const peer = await tcpPeer(() => {});
    const c = await toPeer("a", peer.port);
    await activate(c.id);
    await until(
      async () => (await get(c.id)).activation?.steps[1]?.state === "done",
      "TCP 已连上",
    );
    const r = await cancel(c.id);
    expect(r.statusCode).toBe(200);
    expect(r.json().connection.status).toBe("inactive");
    await until(cancelled(c.id), "写入已取消");

    const log = await logOf(c.id);
    expect(log.map((l) => l.type)).not.toContain("fail");
    expect(log.some((l) => l.text === "已断开")).toBe(false);
    expect(log[0]).toMatchObject({
      type: "disconnect",
      text: "已取消激活",
      detail: "停在「主机密钥」",
    });
    const v = await get(c.id);
    expect([v.status, v.activation]).toEqual(["inactive", null]);
  });

  test("取消发生在远端探测：同样是已取消，不是探测失败", async () => {
    const peer = await sshPeer("probe");
    const c = await toPeer("a", peer.port);
    await activate(c.id);
    await until(
      async () => (await get(c.id)).activation?.steps[4]?.state === "running",
      "进入远端探测",
    );
    await cancel(c.id);
    await until(cancelled(c.id), "写入已取消");
    const log = await logOf(c.id);
    expect(log.map((l) => l.type)).not.toContain("fail");
    expect(log[0]).toMatchObject({ detail: "停在「远端探测」" });
    expect((await get(c.id)).status).toBe("inactive");
  });

  test("取消发生在最后一步（控制通道）：不能被记成激活成功", async () => {
    const peer = await sshPeer("channel");
    const c = await toPeer("a", peer.port);
    await activate(c.id);
    // 等到 homedir 的 realpath 请求已发出且无人应答：取消正好落在最后一步的飞行中
    await until(async () => peer.realpathAsked(), "控制通道请求在途");
    await cancel(c.id);
    await until(cancelled(c.id), "写入已取消");
    // 给收尾一点时间：若误判为成功，「激活成功」会在这之后出现
    await new Promise((ok) => setTimeout(ok, 200));
    const log = await logOf(c.id);
    expect(log.some((l) => l.text === "激活成功")).toBe(false);
    expect(log[0]).toMatchObject({ detail: "停在「控制通道」" });
    const v = await get(c.id);
    expect([v.status, v.lastActiveAt]).toEqual(["inactive", null]);
  });

  test("取消后立刻重新激活：旧激活的收尾不影响新的一次，仍只允许一个激活", async () => {
    const peer = await sshPeer("probe");
    const a = await toPeer("a", peer.port);
    const b = await toPeer("b", peer.port);
    await activate(a.id);
    await until(
      async () => (await get(a.id)).activation?.steps[4]?.state === "running",
      "进入远端探测",
    );
    await cancel(a.id);
    expect((await activate(a.id)).statusCode).toBe(202); // 不会被旧激活挡成 409
    await until(cancelled(a.id), "旧激活收尾");
    await new Promise((ok) => setTimeout(ok, 200));
    // 新的一次仍在进行：别的连接依然被挡
    expect((await get(a.id)).status).toBe("activating");
    expect((await activate(b.id)).json()).toMatchObject({ error: "busy" });
    await cancel(a.id);
  });

  test.each([
    ["对端接受后干净关闭", (s: net.Socket) => s.end()],
    [
      "对端回非 SSH 内容再关闭",
      (s: net.Socket) => {
        s.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        s.end();
      },
    ],
  ])(
    "%s：TCP 连接完成，失败落在「主机密钥」，后面未执行，没有卡在进行中",
    async (_name, onSocket) => {
      const peer = await tcpPeer(onSocket);
      const c = await toPeer("a", peer.port);
      await activate(c.id);
      const v = await settle(c.id);
      expect(stepStates(v)).toEqual([
        "done",
        "done",
        "failed",
        "pending",
        "pending",
        "pending",
      ]);
      expect(v.activation).toMatchObject({
        state: "failed",
        failedStage: "hostkey",
        code: "handshake_failed",
      });
      expect(v.status).toBe("inactive");
      expect((await logOf(c.id))[0]).toMatchObject({
        type: "fail",
        text: "激活失败：主机密钥（handshake_failed）",
      });
    },
  );
});

describe.skipIf(!hasSshd)("激活（真实 sshd）", () => {
  let sshd: TestSshd;
  beforeAll(async () => {
    sshd = await startSshd();
  });
  afterAll(() => sshd.close());

  const tofu = { policy: { hostKey: "tofu" } };
  const live = (
    label: string,
    extra: Record<string, unknown> = {},
    secretId = newSecret(`k-${label}`, sshd.privateKey),
  ) => create(label, { port: sshd.port, user: sshd.user, ...extra }, secretId);

  test("六步依次成功，状态变 active，记录指纹与最近激活时间", async () => {
    const c = await live("a", tofu);
    const r = await activate(c.id);
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe("activating");
    expect(r.json().activation.state).toBe("running");
    expect(
      r
        .json()
        .activation.steps.map((s: { id: string; name: string }) => [
          s.id,
          s.name,
        ]),
    ).toEqual(ACTIVATION_STEPS.map(({ id, name }) => [id, name]));
    const v = await settle(c.id);
    expect(v.activation.state).toBe("done");
    expect(stepStates(v)).toEqual(Array(6).fill("done"));
    expect(v.activation.steps[0].detail).toBe("直连");
    expect(v.status).toBe("active");
    expect(v.hostKey).toMatchObject({
      keyType: "ssh-ed25519",
      changedFrom: null,
    });
    expect(v.hostKey.fingerprint).toMatch(/^SHA256:/);
    expect(v.lastActiveAt).not.toBeNull();
    expect((await activate(c.id)).json()).toEqual({ error: "already_active" });
  });

  test("自动记录的主机密钥带记录时间；再次激活（指纹一致）不改它", async () => {
    const c = await live("a", tofu);
    const before = Date.now();
    await activate(c.id);
    const first = (await settle(c.id)).hostKey.acceptedAt as string;
    expect(Date.parse(first)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(first)).toBeLessThanOrEqual(Date.now());
    await call("POST", `/api/v1/connections/${c.id}/deactivate`);
    await new Promise((ok) => setTimeout(ok, 20));
    await activate(c.id);
    expect((await settle(c.id)).hostKey.acceptedAt).toBe(first);
  });

  test("首次连接策略为询问：阻断在主机密钥步，trust 后才能激活；日志可查", async () => {
    const c = await live("a");
    await activate(c.id);
    const v = await settle(c.id);
    expect(v.activation).toMatchObject({
      state: "failed",
      failedStage: "hostkey",
      code: "hostkey_unknown",
    });
    expect(stepStates(v)).toEqual([
      "done",
      "done",
      "failed",
      "pending",
      "pending",
      "pending",
    ]);
    expect(v.status).toBe("verify-required");
    expect(v.hostKey).toBeNull();
    expect(v.hostKeyChange).toMatchObject({ old: null, changedFrom: null });
    expect(v.hostKeyChange.new).toMatch(/^SHA256:/);

    const blocked = await activate(c.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: "verify_required",
      hostKeyChange: { new: v.hostKeyChange.new },
    });

    const trusted = await call("POST", `/api/v1/connections/${c.id}/trust`);
    expect(trusted.statusCode).toBe(200);
    expect(trusted.json()).toMatchObject({
      status: "inactive",
      hostKeyChange: null,
      hostKey: { fingerprint: v.hostKeyChange.new, changedFrom: null },
    });
    expect(
      (await call("POST", `/api/v1/connections/${c.id}/trust`)).statusCode,
    ).toBe(409);

    await activate(c.id);
    expect((await settle(c.id)).activation.state).toBe("done");
    await call("POST", `/api/v1/connections/${c.id}/deactivate`);

    const log = (await call("GET", `/api/v1/connections/${c.id}/log`)).json()
      .log;
    const types = log.map((l: { type: string }) => l.type);
    expect(types).toEqual(
      expect.arrayContaining(["config", "hostkey", "activate", "disconnect"]),
    );
    expect(log[0]).toMatchObject({ type: "disconnect", text: "已断开" });
  });

  test("指纹变化：阻断激活、给出新旧对比；trust 后写 changedFrom 并可激活", async () => {
    const c = await live("a", tofu);
    await activate(c.id);
    const first = await settle(c.id);
    await call("POST", `/api/v1/connections/${c.id}/deactivate`);
    const real = first.hostKey.fingerprint;

    // 把记录换成另一把密钥的指纹，模拟服务器换了密钥
    const fake = `ssh-ed25519:${"ab".repeat(32)}`;
    db.prepare("UPDATE environments SET host_key = ? WHERE id = ?").run(
      fake,
      c.id,
    );
    const old = displayFingerprint(fake).fingerprint;

    await activate(c.id);
    const v = await settle(c.id);
    expect(v.activation).toMatchObject({
      state: "failed",
      failedStage: "hostkey",
      code: "hostkey_changed",
    });
    expect(v.status).toBe("verify-required");
    expect(v.hostKey.fingerprint).toBe(old); // 记录没有被覆盖
    expect(v.hostKeyChange).toEqual({
      old,
      new: real,
      oldType: "ssh-ed25519",
      newType: "ssh-ed25519",
      changedFrom: old,
    });
    expect((await activate(c.id)).json()).toMatchObject({
      error: "verify_required",
      hostKeyChange: { old, new: real },
    });

    const t = await call("POST", `/api/v1/connections/${c.id}/trust`);
    expect(t.json()).toMatchObject({
      status: "inactive",
      hostKeyChange: null,
      hostKey: { fingerprint: real, changedFrom: old },
    });
    expect(t.json().hostKey.acceptedAt).not.toBeNull();
    await activate(c.id);
    const ok = await settle(c.id);
    expect(ok.activation.state).toBe("done");
    expect(ok.activation.steps[2].detail).toContain("与记录一致");
  });

  test("某一步失败：停在该步并带错误码（认证 / TCP）", async () => {
    const wrongKey = newSecret("wrong");
    const a = await live("auth", tofu, wrongKey);
    await activate(a.id);
    const va = await settle(a.id);
    expect(va.activation).toMatchObject({
      state: "failed",
      failedStage: "auth",
      code: "auth_failed",
    });
    expect(stepStates(va)).toEqual([
      "done",
      "done",
      "done",
      "failed",
      "pending",
      "pending",
    ]);
    expect(va.status).toBe("inactive");

    const t = await live("tcp", { ...tofu, port: 1 });
    await activate(t.id);
    const vt = await settle(t.id);
    expect(vt.activation).toMatchObject({
      state: "failed",
      failedStage: "tcp",
      code: "tcp_refused",
    });
    expect(stepStates(vt)[1]).toBe("failed");
    // 失败进入日志
    const log = (await call("GET", `/api/v1/connections/${t.id}/log`)).json()
      .log;
    expect(log[0]).toMatchObject({ type: "fail" });
  });

  test("跳板链：经跳板激活；断开跳板连带暂停下游，之后不会自动重连", async () => {
    const a = await live("a", tofu);
    const b = await live("b", { ...tofu, jump: [a.id] });
    expect((await activate(b.id)).json().error).toBe("jump_inactive");

    await activate(a.id);
    await settle(a.id);
    await activate(b.id);
    const vb = await settle(b.id);
    expect(vb.activation.state).toBe("done");
    expect(vb.activation.steps[0].detail).toBe("经 a");
    expect(vb.activation.steps[1].detail).toContain("经跳板通道");
    expect(vb.chain).toEqual([{ id: a.id, label: "a" }]);
    expect((await get(a.id)).dependants).toEqual([{ id: b.id, label: "b" }]);
    // 激活探测到的系统事实留给提示词的「环境信息」段；此时没被断开
    expect(hub.factsOf(b.id)).toMatch(/^\S+/);
    expect(hub.isPaused(b.id)).toBe(false);

    // 已激活的连接不能直接删
    expect(
      (await call("DELETE", `/api/v1/connections/${b.id}`)).json(),
    ).toEqual({
      error: "active",
    });

    const d = await call("POST", `/api/v1/connections/${a.id}/deactivate`);
    expect(d.json().deactivated).toEqual([
      { id: a.id, label: "a" },
      { id: b.id, label: "b" },
    ]);
    expect((await get(a.id)).status).toBe("inactive");
    expect((await get(b.id)).status).toBe("inactive");
    // 断开 = 暂停：「环境信息」段会据此标出已断开；系统事实不丢，重新激活后无需再探测就能写
    expect(hub.isPaused(b.id)).toBe(true);
    expect(hub.factsOf(b.id)).not.toBeNull();
    // 回给模型的报错：点名主机、说明是用户断开的、别重试、让用户去「远程连接」激活
    await expect(hub.getSsh(b.id)?.homedir()).rejects.toThrow(
      /Host "b" is disconnected.*Do not retry.*Settings → Remote connections/,
    );
    // 下游需要重新单独激活；此时跳板也要先激活
    expect((await activate(b.id)).json().error).toBe("jump_inactive");
  });

  test("已激活后改地址类字段不动现有连接，标记 dirty，下次激活生效", async () => {
    const c = await live("a", tofu);
    await activate(c.id);
    await settle(c.id);
    const r = await call("PATCH", `/api/v1/connections/${c.id}`, {
      user: "other",
    });
    expect(r.json()).toMatchObject({
      user: "other",
      status: "active",
      dirty: true,
    });
  });

  describe("已激活的连接掉线", () => {
    const proxies: Array<() => void> = [];
    afterEach(() => {
      for (const close of proxies.splice(0)) close();
    });
    const viaProxy = async (label: string) => {
      const px = await tcpProxy(sshd.port);
      proxies.push(px.close);
      const c = await live(label, { ...tofu, port: px.port });
      await activate(c.id);
      await settle(c.id);
      expect((await get(c.id)).status).toBe("active");
      return { c, px };
    };

    test("网络中断：状态变为未激活，日志里有「连接已断开」，不自动重连", async () => {
      const { c, px } = await viaProxy("drop");
      px.dropAll();
      await until(
        async () => (await get(c.id)).status === "inactive",
        "状态变为 inactive",
      );
      const v = await get(c.id);
      expect(v.activation).toBeNull();
      const log = await logOf(c.id);
      expect(log[0]).toMatchObject({ type: "disconnect", text: "连接已断开" });
      expect(log[0]?.detail).not.toBe("");
      expect(log.filter((l) => l.text === "连接已断开")).toHaveLength(1);
      // 没有人再去连：过一会儿仍是未激活，日志没有新增
      await new Promise((ok) => setTimeout(ok, 300));
      expect((await get(c.id)).status).toBe("inactive");
      expect(await logOf(c.id)).toHaveLength(log.length);
    });

    test("用户主动断开不算掉线，不写「连接已断开」", async () => {
      const { c } = await viaProxy("manual");
      await call("POST", `/api/v1/connections/${c.id}/deactivate`);
      await new Promise((ok) => setTimeout(ok, 300));
      const log = await logOf(c.id);
      expect(log[0]).toMatchObject({ type: "disconnect", text: "已断开" });
      expect(log.some((l) => l.text === "连接已断开")).toBe(false);
    });

    test("跳板掉线：经它连接的下游一并变为未激活，各记一条", async () => {
      const px = await tcpProxy(sshd.port);
      proxies.push(px.close);
      const a = await live("jump", { ...tofu, port: px.port });
      await activate(a.id);
      await settle(a.id);
      const b = await live("down", { ...tofu, jump: [a.id] });
      await activate(b.id);
      await settle(b.id);
      expect((await get(b.id)).status).toBe("active");
      px.dropAll();
      await until(
        async () =>
          (await get(a.id)).status === "inactive" &&
          (await get(b.id)).status === "inactive",
        "跳板与下游都变为 inactive",
      );
      for (const id of [a.id, b.id])
        expect((await logOf(id))[0]).toMatchObject({ text: "连接已断开" });
    });
  });
});
