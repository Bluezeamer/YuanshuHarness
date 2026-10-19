import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { KEY_FILE, loadMasterKey, SecretStore } from "../store/secrets.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { environmentsApi } from "./environments.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let secrets: SecretStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-env-"));
  db = openDatabase(dir);
  secrets = new SecretStore(db, loadMasterKey(dir));
  app = Fastify();
  app.register(environmentsApi, {
    environments: new EnvironmentStore(db),
    secrets,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
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
    expect(p.json()).toMatchObject({ os: "windows", port: 2222, host: "10.0.0.5" });
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
    [{ name: "a", host: "h", username: "u", secretId: "nope" }, "invalid_secret"],
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
