import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../server.js";
import { DB_FILE, MIGRATIONS } from "../store/db.js";

const TOKEN = "k".repeat(40);
let base: string;
let seq = 0;
const servers: YuanshuServer[] = [];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "yuanshu-wb-"));
  await mkdir(path.join(base, "web"), { recursive: true });
  await writeFile(path.join(base, "web", "index.html"), "<title>x</title>");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop().catch(() => {});
  await rm(base, { recursive: true, force: true });
});

async function launch(dataDir = path.join(base, `data${seq++}`)) {
  const server = createServer(
    { host: "127.0.0.1", port: 0, dataDir, token: TOKEN, allowCidrs: [] },
    { webRoot: path.join(base, "web") },
  );
  const addr = await server.start();
  servers.push(server);
  const url = `http://127.0.0.1:${addr.port}`;
  const call = (method: string, p: string, body?: unknown, auth = true) =>
    fetch(url + p, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { server, dataDir, call };
}

const doc = (extra: object = {}) => ({ version: 1, windows: [], ...extra });

describe("workbench（R18）", () => {
  test.each([
    ["GET", "/api/v1/workbench"],
    ["PUT", "/api/v1/workbench"],
    ["GET", "/api/v1/saved-layouts"],
    ["POST", "/api/v1/saved-layouts"],
    ["PUT", "/api/v1/saved-layouts/x"],
    ["DELETE", "/api/v1/saved-layouts/x"],
  ])("%s %s 无令牌得 401", async (method, p) => {
    const s = await launch();
    expect((await s.call(method, p, undefined, false)).status).toBe(401);
  });

  test("还没有文档：revision 0 与 null", async () => {
    const s = await launch();
    const r = await s.call("GET", "/api/v1/workbench");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ revision: 0, document: null });
  });

  test("基线相符则写入并递增，读回同一份文档", async () => {
    const s = await launch();
    const put = await s.call("PUT", "/api/v1/workbench", {
      baseRevision: 0,
      document: doc({ x: 1 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ revision: 1 });
    const got = await (await s.call("GET", "/api/v1/workbench")).json();
    expect(got).toEqual({ revision: 1, document: doc({ x: 1 }) });
  });

  test("基线不符得 409 与当前文档，且不覆盖", async () => {
    const s = await launch();
    await s.call("PUT", "/api/v1/workbench", {
      baseRevision: 0,
      document: doc({ who: "a" }),
    });
    const lose = await s.call("PUT", "/api/v1/workbench", {
      baseRevision: 0,
      document: doc({ who: "b" }),
    });
    expect(lose.status).toBe(409);
    expect(await lose.json()).toEqual({
      revision: 1,
      document: doc({ who: "a" }),
    });
    const got = await (await s.call("GET", "/api/v1/workbench")).json();
    expect(got).toEqual({ revision: 1, document: doc({ who: "a" }) });
  });

  test("并发写同一基线：恰好一个成功", async () => {
    const s = await launch();
    const rs = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        s.call("PUT", "/api/v1/workbench", {
          baseRevision: 0,
          document: doc({ n }),
        }),
      ),
    );
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409]);
  });

  test.each([
    ["不是 JSON", "{oops"],
    ["缺 baseRevision", { document: doc() }],
    ["baseRevision 不是整数", { baseRevision: 1.5, document: doc() }],
    ["version 不是整数", { baseRevision: 0, document: { version: "1" } }],
    ["文档缺 version", { baseRevision: 0, document: {} }],
    ["文档是数组", { baseRevision: 0, document: [] }],
  ])("非法请求体（%s）得 400", async (_n, body) => {
    const s = await launch();
    const r = await s.call("PUT", "/api/v1/workbench", body);
    expect(r.status).toBe(400);
  });

  test("超过 256 KiB 得 413，且不写入", async () => {
    const s = await launch();
    const r = await s.call("PUT", "/api/v1/workbench", {
      baseRevision: 0,
      document: doc({ pad: "x".repeat(256 * 1024) }),
    });
    expect(r.status).toBe(413);
    const got = await (await s.call("GET", "/api/v1/workbench")).json();
    expect(got).toEqual({ revision: 0, document: null });
  });

  test("接近上限的文档可以写入", async () => {
    const s = await launch();
    const r = await s.call("PUT", "/api/v1/workbench", {
      baseRevision: 0,
      document: doc({ pad: "x".repeat(200 * 1024) }),
    });
    expect(r.status).toBe(200);
  });

  test("高于当前代码版本的文档原样存取，Server 不解析", async () => {
    const s = await launch();
    const future = { version: 99, shape: { 未知: [1, 2] } };
    await s.call("PUT", "/api/v1/workbench", {
      baseRevision: 0,
      document: future,
    });
    const got = (await (await s.call("GET", "/api/v1/workbench")).json()) as {
      document: unknown;
    };
    expect(got.document).toEqual(future);
  });
});

describe("saved-layouts（R18、R22）", () => {
  test("增、列、改、删", async () => {
    const s = await launch();
    const created = await s.call("POST", "/api/v1/saved-layouts", {
      document: doc({ name: "a" }),
    });
    expect(created.status).toBe(201);
    const { id, revision } = (await created.json()) as {
      id: string;
      revision: number;
    };
    expect(revision).toBe(1);

    const list = (await (
      await s.call("GET", "/api/v1/saved-layouts")
    ).json()) as {
      layouts: { id: string; document: unknown }[];
    };
    expect(list.layouts).toHaveLength(1);
    expect(list.layouts[0]?.document).toEqual(doc({ name: "a" }));

    const upd = await s.call("PUT", `/api/v1/saved-layouts/${id}`, {
      baseRevision: 1,
      document: doc({ name: "b" }),
    });
    expect(await upd.json()).toEqual({ revision: 2 });

    const stale = await s.call("PUT", `/api/v1/saved-layouts/${id}`, {
      baseRevision: 1,
      document: doc({ name: "c" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      revision: 2,
      document: doc({ name: "b" }),
    });

    expect((await s.call("DELETE", `/api/v1/saved-layouts/${id}`)).status).toBe(
      204,
    );
    expect((await s.call("DELETE", `/api/v1/saved-layouts/${id}`)).status).toBe(
      404,
    );
    const after = (await (
      await s.call("GET", "/api/v1/saved-layouts")
    ).json()) as {
      layouts: unknown[];
    };
    expect(after.layouts).toEqual([]);
  });

  test("改不存在的 id 得 404；非法体得 400；超限得 413", async () => {
    const s = await launch();
    expect(
      (
        await s.call("PUT", "/api/v1/saved-layouts/nope", {
          baseRevision: 1,
          document: doc(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await s.call("POST", "/api/v1/saved-layouts", { document: {} })).status,
    ).toBe(400);
    expect(
      (
        await s.call("POST", "/api/v1/saved-layouts", {
          document: doc({ pad: "x".repeat(256 * 1024) }),
        })
      ).status,
    ).toBe(413);
  });
});

describe("数据目录迁移（R19）", () => {
  test("新库的 user_version 等于迁移数，并带 workbench 与 saved_layouts 表", async () => {
    const s = await launch();
    await s.server.stop();
    servers.length = 0;
    const db = new Database(path.join(s.dataDir, DB_FILE), { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["sessions", "workbench", "saved_layouts"]),
    );
    db.close();
  });

  test("旧库（版本 1）升级：先备份，旧数据保留，布局可用", async () => {
    const dataDir = path.join(base, "old");
    const first = await launch(dataDir);
    await first.server.stop();
    servers.length = 0;

    const db = new Database(path.join(dataDir, DB_FILE));
    db.exec("DROP TABLE workbench; DROP TABLE saved_layouts");
    db.exec(
      "CREATE TABLE legacy_marker (v TEXT); INSERT INTO legacy_marker VALUES ('keep')",
    );
    db.pragma("user_version = 1");
    db.close();

    const again = await launch(dataDir);
    const r = await again.call("GET", "/api/v1/workbench");
    expect(await r.json()).toEqual({ revision: 0, document: null });
    await again.server.stop();
    servers.length = 0;

    const check = new Database(path.join(dataDir, DB_FILE), { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(
      MIGRATIONS.length,
    );
    expect(check.prepare("SELECT v FROM legacy_marker").all()).toEqual([
      { v: "keep" },
    ]);
    check.close();
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dataDir)).some((n) => n.includes(".bak-v1"))).toBe(
      true,
    );
  });
});
