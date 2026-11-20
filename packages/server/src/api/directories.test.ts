import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { hasSshd, startSshd, type TestSshd } from "../../test/support/sshd.js";
import { startStub, stubSessionFactory } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import type { SessionFactory } from "../session/pool.js";
import { DB_FILE } from "../store/db.js";

const stub = await startStub((n) => `reply-${n}`);
afterAll(() => stub.close());

const TOKEN = "t".repeat(40);
let base: string;
const servers: YuanshuServer[] = [];
const cwds: string[] = [];

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-ws-"));
  cwds.length = 0;
  mkdirSync(path.join(base, "web"));
  writeFileSync(path.join(base, "web", "index.html"), "<!doctype html>");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  rmSync(base, { recursive: true, force: true });
});

// 包一层工厂，记录池传给它的 cwd。
const recording: () => SessionFactory = () => {
  const inner = stubSessionFactory(stub);
  return (o) => {
    cwds.push(o.cwd);
    return inner(o);
  };
};

async function launch(opts: { dataDir?: string; startDir?: string } = {}) {
  const dataDir = opts.dataDir ?? path.join(base, "data");
  const startDir = opts.startDir ?? mkdirp("start");
  const server = createServer(
    { host: "127.0.0.1", port: 0, dataDir, token: TOKEN, allowCidrs: [] },
    {
      startDir,
      sessionFactory: recording(),
      webRoot: path.join(base, "web"),
    },
  );
  const addr = await server.start();
  servers.push(server);
  const call = (method: string, p: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${addr.port}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const stop = async () => {
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
  };
  return { call, dataDir, startDir, stop, port: addr.port };
}
type Call = Awaited<ReturnType<typeof launch>>["call"];

function mkdirp(name: string): string {
  const p = path.join(base, name);
  mkdirSync(p, { recursive: true });
  return p;
}
const list = async (call: Call) =>
  (
    (await (await call("GET", "/api/v1/directories")).json()) as {
      directories: Array<{
        id: string;
        name: string;
        path: string;
      }>;
    }
  ).directories;
const add = (call: Call, body: unknown) =>
  call("POST", "/api/v1/directories", body);

describe("R2 默认 directory", () => {
  test("空库启动登记一次；重启不重复；删除默认后不补登记", async () => {
    const a = await launch();
    const first = await list(a.call);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      name: "start",
      environmentId: "local",
    });
    expect(Object.keys(first[0] as object).sort()).toEqual([
      "createdAt",
      "environmentId",
      "id",
      "name",
      "path",
    ]);
    await a.stop();

    const b = await launch({ dataDir: a.dataDir });
    expect(await list(b.call)).toHaveLength(1);
    // 再登记一个，删除默认，重启后仍只剩后者
    const other = (await (
      await add(b.call, { path: mkdirp("other") })
    ).json()) as {
      id: string;
    };
    const del = await b.call("DELETE", `/api/v1/directories/${first[0]?.id}`);
    expect(del.status).toBe(204);
    await b.stop();

    const c = await launch({ dataDir: a.dataDir });
    expect((await list(c.call)).map((w) => w.id)).toEqual([other.id]);
  });
});

describe("R2 删除最后一个后重启不补登记", () => {
  test("持久化首次登记标记：空表重启仍为空", async () => {
    const a = await launch();
    const [only] = await list(a.call);
    expect(
      (await a.call("DELETE", `/api/v1/directories/${only?.id}`)).status,
    ).toBe(204);
    await a.stop();
    const b = await launch({ dataDir: a.dataDir });
    expect(await list(b.call)).toEqual([]);
  });
});

describe("R3 登记", () => {
  test("相对路径、文件、不存在均 400；符号链接解析后重复 409", async () => {
    const { call } = await launch();
    const file = path.join(base, "f.txt");
    writeFileSync(file, "x");
    for (const p of ["rel/dir", file, path.join(base, "nope"), undefined, 5]) {
      expect((await add(call, { path: p })).status).toBe(400);
    }
    const real = mkdirp("real");
    const link = path.join(base, "link");
    symlinkSync(real, link);
    const ok = await add(call, { path: real });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { path: string; name: string };
    expect(body.name).toBe("real");
    expect((await add(call, { path: link })).status).toBe(409);
    expect((await add(call, { path: real })).status).toBe(409);
  });

  test("name 去空白后 1-100 字符", async () => {
    const { call } = await launch();
    const d = (n: string) => mkdirp(n);
    expect((await add(call, { path: d("a"), name: "   " })).status).toBe(400);
    expect(
      (await add(call, { path: d("b"), name: "x".repeat(101) })).status,
    ).toBe(400);
    const r = await add(call, { path: d("c"), name: `  ${"x".repeat(100)}  ` });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { name: string }).name).toBe("x".repeat(100));
    const one = await add(call, { path: d("d"), name: " y " });
    expect(((await one.json()) as { name: string }).name).toBe("y");
  });
});

describe("R4 修改与删除", () => {
  test("改名与重名：同主机的另一个目录占了新名字 409，改成自己现在的名字不算冲突", async () => {
    const { call } = await launch();
    const a = (await (await add(call, { path: mkdirp("a") })).json()) as {
      id: string;
    };
    const b = (await (await add(call, { path: mkdirp("b") })).json()) as {
      id: string;
    };
    const conflict = await call("PATCH", `/api/v1/directories/${b.id}`, {
      name: "a",
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as { error: string }).toEqual({
      error: "name_exists",
    });
    expect(
      (await call("PATCH", `/api/v1/directories/${a.id}`, { name: "a" }))
        .status,
    ).toBe(200);
    expect(
      (await call("PATCH", `/api/v1/directories/${b.id}`, { name: "c" }))
        .status,
    ).toBe(200);
  });

  test("默认名去重与显式重名：POST 时后到的取 -2，显式给重名是 409 name_exists", async () => {
    const { call } = await launch();
    mkdirp("app");
    mkdirp(path.join("sub", "app"));
    const first = await add(call, { path: path.join(base, "app") });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { name: string }).name).toBe("app");
    const second = await add(call, { path: path.join(base, "sub", "app") });
    expect(((await second.json()) as { name: string }).name).toBe("app-2");
    const dup = await add(call, {
      path: path.join(base, "sub", "app"),
      name: "app",
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()) as { error: string }).toEqual({
      error: "name_exists",
    });
  });

  test("改名；非法值 400（档位已不在目录上）；404", async () => {
    const { call } = await launch();
    const [ws] = await list(call);
    const url = `/api/v1/directories/${ws?.id}`;
    const r = await call("PATCH", url, { name: "新名字" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: "新名字" });
    expect((await list(call))[0]).toMatchObject({ name: "新名字" });
    for (const bad of [{ tier: "full" }, { name: "" }, {}]) {
      expect((await call("PATCH", url, bad)).status).toBe(400);
    }
    expect(
      (await call("PATCH", "/api/v1/directories/nope", { name: "x" })).status,
    ).toBe(404);
    expect((await call("DELETE", "/api/v1/directories/nope")).status).toBe(404);
  });

  test("有会话引用时删除 409 且什么都不删；无引用 204", async () => {
    const { call } = await launch();
    const extra = (await (await add(call, { path: mkdirp("x") })).json()) as {
      id: string;
    };
    const s = await call("POST", "/api/v1/sessions", { directoryId: extra.id });
    expect(s.status).toBe(201);
    const del = await call("DELETE", `/api/v1/directories/${extra.id}`);
    expect(del.status).toBe(409);
    expect(await list(call)).toHaveLength(2);
    // 默认 directory 没有显式引用，但旧会话/孤儿读作默认：先建一个默认会话再试
    const [def] = await list(call);
    await call("POST", "/api/v1/sessions", {});
    expect(
      (await call("DELETE", `/api/v1/directories/${def?.id}`)).status,
    ).toBe(409);
  });
});

describe("R5 会话绑定", () => {
  test("指定 directory：工厂 cwd 与条目 directoryId 正确；缺省取最早登记", async () => {
    const { call, startDir } = await launch();
    const dir = mkdirp("proj");
    const ws = (await (await add(call, { path: dir })).json()) as {
      id: string;
    };
    const r = await call("POST", "/api/v1/sessions", { directoryId: ws.id });
    expect(r.status).toBe(201);
    const created = (await r.json()) as { id: string; directoryId: string };
    expect(created.directoryId).toBe(ws.id);
    expect(cwds.at(-1)).toBe(dir);

    const d = (await (await call("POST", "/api/v1/sessions")).json()) as {
      directoryId: string;
    };
    expect(cwds.at(-1)).toBe(startDir);
    expect(d.directoryId).toBe((await list(call))[0]?.id);

    const got = (await (
      await call("GET", `/api/v1/sessions/${created.id}`)
    ).json()) as { directoryId: string };
    expect(got.directoryId).toBe(ws.id);
    const items = (await (await call("GET", "/api/v1/sessions")).json()) as {
      sessions: Array<{ id: string; directoryId: string }>;
    };
    expect(items.sessions.find((x) => x.id === created.id)?.directoryId).toBe(
      ws.id,
    );
  });

  test("未知 directoryId 400；目录被移走 400；类型错误 400", async () => {
    const { call } = await launch();
    expect(
      (await call("POST", "/api/v1/sessions", { directoryId: "nope" })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/v1/sessions", { directoryId: 5 })).status,
    ).toBe(400);
    const dir = mkdirp("gone");
    const ws = (await (await add(call, { path: dir })).json()) as {
      id: string;
    };
    rmSync(dir, { recursive: true });
    expect(
      (await call("POST", "/api/v1/sessions", { directoryId: ws.id })).status,
    ).toBe(400);
  });
});

// 经 WS 打开会话；send 一条消息使其落盘。
async function openStream(port: number, id: string) {
  const c = await TestClient.connect(
    `ws://127.0.0.1:${port}/api/v1/sessions/${id}/stream`,
    { token: TOKEN },
  );
  await waitFor(() => c.types().includes("snapshot"), "快照");
  return c;
}

describe("R6 旧会话与孤儿会话", () => {
  test("directory_id 为空的会话恢复时 cwd 取默认 directory", async () => {
    const a = await launch();
    const dir = mkdirp("other");
    const ws = (await (await add(a.call, { path: dir })).json()) as {
      id: string;
    };
    const created = await a.call("POST", "/api/v1/sessions", {
      directoryId: ws.id,
    });
    const id = ((await created.json()) as { id: string }).id;
    const c = await openStream(a.port, id);
    expect((await c.command("send_message", { text: "hi" })).ok).toBe(true);
    await waitFor(() => c.types().includes("run.ended"), "run.ended");
    c.close();
    await a.stop();

    // 置空 directory_id，模拟 v2 旧会话
    const db = new Database(path.join(a.dataDir, DB_FILE));
    db.prepare("UPDATE sessions SET directory_id = NULL").run();
    db.close();

    const b = await launch({ dataDir: a.dataDir });
    const got = (await (
      await b.call("GET", `/api/v1/sessions/${id}`)
    ).json()) as { directoryId: string };
    expect(got.directoryId).toBe((await list(b.call))[0]?.id);
    (await openStream(b.port, id)).close();
    expect(cwds.at(-1)).toBe(b.startDir);
  });
});

describe("R11 规则 REST", () => {
  test("列出（含形状）、删除、404", async () => {
    const a = await launch();
    const ws = (await list(a.call))[0];
    if (!ws) throw new Error("no ws");
    await a.stop();
    // 服务持有独占锁，停下后直接预置两条规则。
    const db = new Database(path.join(a.dataDir, DB_FILE));
    const ins = db.prepare(
      "INSERT INTO permission_rules (id, directory_id, kind, access, value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    ins.run("r1", ws.id, "path", "write", "/tmp/x", "2026-01-01T00:00:00.000Z");
    ins.run(
      "r2",
      ws.id,
      "command",
      null,
      "npm test",
      "2026-01-02T00:00:00.000Z",
    );
    db.close();

    const b = await launch({ dataDir: a.dataDir });
    expect((await b.call("GET", "/api/v1/directories/nope/rules")).status).toBe(
      404,
    );
    const got = await b.call("GET", `/api/v1/directories/${ws.id}/rules`);
    expect(await got.json()).toEqual({
      rules: [
        {
          id: "r1",
          kind: "path",
          access: "write",
          value: "/tmp/x",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          kind: "command",
          access: null,
          value: "npm test",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(
      (await b.call("DELETE", `/api/v1/directories/${ws.id}/rules/r1`)).status,
    ).toBe(204);
    expect(
      (await b.call("DELETE", `/api/v1/directories/${ws.id}/rules/r1`)).status,
    ).toBe(404);
    expect(
      (await b.call("DELETE", `/api/v1/directories/nope/rules/r2`)).status,
    ).toBe(404);
    const left = (await (
      await b.call("GET", `/api/v1/directories/${ws.id}/rules`)
    ).json()) as { rules: { id: string }[] };
    expect(left.rules.map((r) => r.id)).toEqual(["r2"]);
    await b.stop();
  });
});

describe("R4 在 ssh 环境登记 directory", () => {
  const post = async (call: Call, url: string, body: unknown) =>
    (await call("POST", url, body)).json() as Promise<{ id: string }>;

  test("未知或非字符串的 environmentId 为 400；连不上的环境为 502", async () => {
    const { call } = await launch();
    const dir = mkdirp("somewhere");
    for (const environmentId of ["nope", 5, null]) {
      const r = await add(call, { path: dir, environmentId });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe(
        "invalid_environment",
      );
    }
    const dead = await post(call, "/api/v1/environments", {
      name: "dead",
      host: "127.0.0.1",
      port: 1,
      username: "u",
    });
    const r = await add(call, { path: dir, environmentId: dead.id });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toBe(
      "env_unreachable",
    );
  });

  describe.skipIf(!hasSshd)("真实 sshd", () => {
    let sshd: TestSshd;
    beforeAll(async () => {
      sshd = await startSshd();
    });
    afterAll(() => sshd.close());

    async function remoteEnv(call: Call): Promise<string> {
      const key = await post(call, "/api/v1/secrets", {
        name: "k",
        kind: "ssh_key",
        value: sshd.privateKey,
      });
      const env = await post(call, "/api/v1/environments", {
        name: "box",
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.user,
        secretId: key.id,
      });
      return env.id;
    }

    test("远程目录按真实路径登记；相对路径、文件、不存在为 400", async () => {
      const { call } = await launch();
      const environmentId = await remoteEnv(call);
      const real = mkdirp("remote-real");
      const link = path.join(base, "remote-link");
      symlinkSync(real, link);
      const file = path.join(base, "remote.txt");
      writeFileSync(file, "x");
      for (const p of ["rel/dir", file, path.join(base, "nope"), undefined]) {
        expect((await add(call, { path: p, environmentId })).status).toBe(400);
      }
      const ok = await add(call, { path: link, environmentId });
      expect(ok.status).toBe(201);
      expect(await ok.json()).toMatchObject({
        environmentId,
        path: real,
        name: "remote-real",
      });
    });

    test("唯一性按 (环境, 路径)：同路径本机与远程可并存，同环境重复为 409", async () => {
      const { call } = await launch();
      const environmentId = await remoteEnv(call);
      const dir = mkdirp("both");
      expect((await add(call, { path: dir })).status).toBe(201);
      expect((await add(call, { path: dir, environmentId })).status).toBe(201);
      expect((await add(call, { path: dir, environmentId })).status).toBe(409);
      expect((await list(call)).filter((w) => w.path === dir)).toHaveLength(2);
    });
  });
});
