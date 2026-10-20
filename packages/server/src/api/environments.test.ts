import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EnvHub } from "../env/hub.js";
import { AuditLog } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { KEY_FILE, loadMasterKey, SecretStore } from "../store/secrets.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { environmentsApi } from "./environments.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let secrets: SecretStore;
let hub: EnvHub;
let audit: AuditLog;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-env-"));
  db = openDatabase(dir);
  secrets = new SecretStore(db, loadMasterKey(dir));
  const environments = new EnvironmentStore(db);
  hub = new EnvHub(environments, secrets);
  audit = new AuditLog(db);
  app = Fastify();
  app.register(environmentsApi, { environments, secrets, hub, audit });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  hub.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

describe("密码库", () => {
  test("创建后列表只有元数据，没有值；reveal 能取回原文", async () => {
    const r = await post("/api/v1/secrets", {
      name: "gitlab",
      kind: "password",
      value: "hunter2-very-secret",
    });
    expect(r.statusCode).toBe(201);
    expect(JSON.stringify(r.json())).not.toContain("hunter2");
    const list = await app.inject({ method: "GET", url: "/api/v1/secrets" });
    expect(JSON.stringify(list.json())).not.toContain("hunter2");
    expect(secrets.reveal(r.json().id)).toBe("hunter2-very-secret");
  });

  test("库文件里不含明文；换了主密钥就解不开", async () => {
    const r = await post("/api/v1/secrets", {
      name: "k",
      kind: "ssh_key",
      value: "PLAINTEXT-MARKER-123",
    });
    const blob = (
      db.prepare("SELECT ciphertext FROM secrets").get() as {
        ciphertext: Buffer;
      }
    ).ciphertext;
    expect(blob.includes("PLAINTEXT-MARKER-123")).toBe(false);
    const other = new SecretStore(db, Buffer.alloc(32, 7));
    expect(() => other.reveal(r.json().id)).toThrow();
  });

  test("主密钥文件权限 0600，重复加载得到同一把", () => {
    const file = path.join(dir, KEY_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadMasterKey(dir).toString("hex")).toBe(
      readFileSync(file, "utf8").trim(),
    );
  });

  test.each([
    [{ name: "", kind: "password", value: "x" }, "invalid_name"],
    [{ name: "a", kind: "nope", value: "x" }, "invalid_kind"],
    [{ name: "a", kind: "password", value: "" }, "invalid_value"],
    [{ name: "a", kind: "password" }, "invalid_value"],
  ])("非法输入 %j → 400", async (body, error) => {
    const r = await post("/api/v1/secrets", body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe(error);
  });

  test("重名 409；被环境引用时删除 409，解除后可删", async () => {
    const body = { name: "k", kind: "ssh_key", value: "v" };
    const a = await post("/api/v1/secrets", body);
    expect((await post("/api/v1/secrets", body)).statusCode).toBe(409);
    const env = await post("/api/v1/environments", {
      name: "box",
      host: "h",
      username: "u",
      secretId: a.json().id,
    });
    const del = () =>
      app.inject({ method: "DELETE", url: `/api/v1/secrets/${a.json().id}` });
    expect((await del()).statusCode).toBe(409);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/environments/${env.json().id}`,
      payload: { secretId: null },
    });
    expect((await del()).statusCode).toBe(204);
    expect((await del()).statusCode).toBe(404);
  });
});

describe("环境", () => {
  test("列表首项是隐含的本机环境", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/environments" });
    expect(r.json().environments[0]).toMatchObject({
      id: "local",
      kind: "local",
    });
  });

  test("创建带默认端口与 os，PATCH 可改，重名 409", async () => {
    const r = await post("/api/v1/environments", {
      name: "dev",
      host: "10.0.0.5",
      username: "root",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ port: 22, os: "posix", kind: "ssh" });
    const p = await app.inject({
      method: "PATCH",
      url: `/api/v1/environments/${r.json().id}`,
      payload: { os: "windows", port: 2222 },
    });
    expect(p.json()).toMatchObject({
      os: "windows",
      port: 2222,
      host: "10.0.0.5",
    });
    expect(
      (
        await post("/api/v1/environments", {
          name: "dev",
          host: "x",
          username: "u",
        })
      ).statusCode,
    ).toBe(409);
  });

  test.each([
    [{ name: "a", username: "u" }, "invalid_host"],
    [{ name: "a", host: "h" }, "invalid_username"],
    [{ name: "a", host: "h", username: "u", port: 0 }, "invalid_port"],
    [{ name: "a", host: "h", username: "u", port: 22.5 }, "invalid_port"],
    [{ name: "a", host: "h", username: "u", os: "mac" }, "invalid_os"],
    [
      { name: "a", host: "h", username: "u", secretId: "nope" },
      "invalid_secret",
    ],
  ])("非法输入 %j → 400", async (body, error) => {
    const r = await post("/api/v1/environments", body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe(error);
  });

  test("本机环境不可改不可删；有 workspace 引用时不可删", async () => {
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/environments/local",
          payload: { name: "x" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/environments/local",
        })
      ).statusCode,
    ).toBe(409);

    const env = await post("/api/v1/environments", {
      name: "dev",
      host: "h",
      username: "u",
    });
    const id = env.json().id;
    db.prepare(
      "INSERT INTO workspaces (id, name, path, environment_id, created_at) VALUES ('w','w','/x',?,'t')",
    ).run(id);
    const del = () =>
      app.inject({ method: "DELETE", url: `/api/v1/environments/${id}` });
    expect((await del()).statusCode).toBe(409);
    new WorkspaceStore(db).remove("w");
    expect((await del()).statusCode).toBe(204);
  });
});

describe("环境状态与连接", () => {
  test("状态列表含本机；连不上的环境报 error 并带原因，本机不可 connect", async () => {
    const env = await post("/api/v1/environments", {
      name: "dead",
      host: "127.0.0.1",
      port: 1,
      username: "u",
    });
    const id = env.json().id;
    const before = (
      await app.inject({ method: "GET", url: "/api/v1/environments/status" })
    ).json().statuses;
    expect(before).toContainEqual({ id: "local", state: "local" });
    expect(before).toContainEqual({ id, state: "disconnected" });

    const conn = await post(`/api/v1/environments/${id}/connect`, {});
    expect(conn.statusCode).toBe(200);
    expect(conn.json().state).toBe("error");
    expect(conn.json().error).toBeTruthy();

    expect(
      (await post("/api/v1/environments/local/connect", {})).statusCode,
    ).toBe(404);
    expect(
      (await post("/api/v1/environments/nope/connect", {})).statusCode,
    ).toBe(404);
  });
});

describe("跨环境传输", () => {
  const tr = (from: string, to: string, overwrite?: boolean) =>
    post("/api/v1/transfers", {
      from: { env: "local", path: from },
      to: { env: "local", path: to },
      ...(overwrite === undefined ? {} : { overwrite }),
    });

  test("复制文件；目标已存在 409，overwrite 后成功；源不存在 404", async () => {
    const src = path.join(dir, "a.txt");
    const dst = path.join(dir, "b.txt");
    writeFileSync(src, "one");
    const ok = await tr(src, dst);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ files: 1, bytes: 3, skippedLinks: 0 });
    expect(readFileSync(dst, "utf8")).toBe("one");

    writeFileSync(src, "two!");
    expect((await tr(src, dst)).statusCode).toBe(409);
    expect(readFileSync(dst, "utf8")).toBe("one");
    expect((await tr(src, dst, true)).statusCode).toBe(200);
    expect(readFileSync(dst, "utf8")).toBe("two!");

    expect((await tr(path.join(dir, "nope"), dst)).statusCode).toBe(404);
  });

  test("传输与连接尝试写审计（actor=user），只记路径与统计", async () => {
    const src = path.join(dir, "a.txt");
    const dst = path.join(dir, "b.txt");
    writeFileSync(src, "one");
    await tr(src, dst);
    await tr(src, dst); // 冲突
    const secret = await post("/api/v1/secrets", {
      name: "pw",
      kind: "password",
      value: "AUDIT-LEAK-MARKER",
    });
    const env = await post("/api/v1/environments", {
      name: "dead",
      host: "127.0.0.1",
      port: 1,
      username: "u",
      secretId: secret.json().id,
    });
    await post(`/api/v1/environments/${env.json().id}/connect`, {});
    const rows = audit.list().entries;
    expect(JSON.stringify(rows)).not.toContain("AUDIT-LEAK-MARKER");
    expect(
      rows.map((r) => [r.kind, r.actor, r.detail?.outcome ?? null]),
    ).toEqual([
      ["env", "user", null],
      ["transfer", "user", "conflict"],
      ["transfer", "user", "ok"],
    ]);
    expect(rows[2]?.summary).toBe(`transfer ok: local:${src} -> local:${dst}`);
    expect(rows[2]?.detail).toMatchObject({
      op: "transfer",
      result: "ok",
      outcome: "ok",
      files: 1,
      bytes: 3,
      target: `local:${src} -> local:${dst}`,
    });
    expect(rows[2]?.detail?.durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[1]?.detail).toMatchObject({ result: "error" });
    expect(rows[0]).toMatchObject({
      environmentId: env.json().id,
      detail: { op: "connect", result: "error", state: "error" },
    });
    expect(rows[0]?.detail?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("端点必须是已登记环境上的绝对路径", async () => {
    const bad = (body: unknown) => post("/api/v1/transfers", body);
    const abs = path.join(dir, "x");
    expect((await tr("rel/a", abs)).statusCode).toBe(400);
    expect((await tr(abs, `${abs}\0y`)).statusCode).toBe(400);
    expect(
      (
        await bad({
          from: { env: "ghost", path: abs },
          to: { env: "local", path: abs },
        })
      ).statusCode,
    ).toBe(400);
    expect((await bad({})).statusCode).toBe(400);
  });
});

describe("后台传输任务", () => {
  const job = (body: unknown) => post("/api/v1/transfer-jobs", body);
  const poll = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await app.inject({
        method: "GET",
        url: `/api/v1/transfer-jobs/${id}`,
      });
      if (r.json().state !== "running") return r.json();
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error("任务没有结束");
  };
  const ends = (from: string, to: string) => ({
    from: { env: "local", path: from },
    to: { env: "local", path: to },
  });

  test("复制整个目录：202 返回任务，轮询得到进度与结果，完成后写审计并归属会话", async () => {
    const src = path.join(dir, "tree");
    mkdirSync(path.join(src, "sub"), { recursive: true });
    writeFileSync(path.join(src, "a.txt"), "aaa");
    writeFileSync(path.join(src, "sub", "b.txt"), "bb");
    const dst = path.join(dir, "copy");
    const r = await job({ ...ends(src, dst), sessionId: "s-1" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ state: "running", sessionId: "s-1" });
    const done = await poll(r.json().id);
    expect(done).toMatchObject({
      state: "done",
      totalFiles: 2,
      files: 2,
      bytes: 5,
      skippedLinks: 0,
    });
    expect(done.finishedAt).toBeTruthy();
    expect(readFileSync(path.join(dst, "sub", "b.txt"), "utf8")).toBe("bb");
    const [row] = audit.list({ kind: "transfer" }).entries;
    expect(row).toMatchObject({
      sessionId: "s-1",
      actor: "user",
      detail: { op: "transfer", result: "ok", files: 2, bytes: 5 },
    });
  });

  test("单文件任务带 totalBytes；冲突时任务失败，错误码在 error 里，审计记 error", async () => {
    const src = path.join(dir, "a.txt");
    const dst = path.join(dir, "b.txt");
    writeFileSync(src, "one");
    writeFileSync(dst, "old");
    const failed = await poll((await job(ends(src, dst))).json().id);
    expect(failed.state).toBe("failed");
    expect(failed.error.code).toBe("conflict");
    expect(readFileSync(dst, "utf8")).toBe("old");
    const ok = await poll(
      (await job({ ...ends(src, dst), overwrite: true })).json().id,
    );
    expect(ok).toMatchObject({ state: "done", totalBytes: 3, bytes: 3 });
    expect(
      audit.list({ kind: "transfer" }).entries.map((e) => e.detail?.result),
    ).toEqual(["ok", "error"]);
  });

  test("端点非法 400；未知任务 404", async () => {
    expect((await job({})).statusCode).toBe(400);
    expect((await job(ends("rel", dir))).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/transfer-jobs/nope" }))
        .statusCode,
    ).toBe(404);
  });
});
