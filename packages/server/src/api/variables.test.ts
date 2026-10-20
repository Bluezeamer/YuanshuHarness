import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EnvHub } from "../env/hub.js";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { environmentsApi } from "./environments.js";
import { variablesApi } from "./variables.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let secrets: SecretStore;
let hub: EnvHub;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-var-"));
  db = openDatabase(dir);
  secrets = new SecretStore(db, loadMasterKey(dir));
  const environments = new EnvironmentStore(db);
  hub = new EnvHub(environments, secrets);
  app = Fastify();
  app.register(variablesApi, { secrets });
  app.register(environmentsApi, { environments, secrets, hub });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  hub.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/api/v1/variables",
    payload: payload as object,
  });
const base = { name: "gitlab_token", value: "glpat-abcdef123456" };

describe("隐私变量 API", () => {
  test("创建后各接口都不返回值，库里是密文，内部可取回", async () => {
    const r = await post({
      ...base,
      purpose: "GitLab",
      scopeKind: "domain",
      scopeTarget: "gitlab.example.com",
      tier: "auto",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "gitlab_token",
      purpose: "GitLab",
      scopeKind: "domain",
      scopeTarget: "gitlab.example.com",
      tier: "auto",
      maskable: true,
    });
    const list = await app.inject({ method: "GET", url: "/api/v1/variables" });
    expect(list.json().variables).toHaveLength(1);
    for (const body of [r.body, list.body])
      expect(body).not.toContain("glpat-abcdef123456");
    const blob = (
      db.prepare("SELECT ciphertext FROM secrets").get() as {
        ciphertext: Buffer;
      }
    ).ciphertext;
    expect(blob.includes("glpat-abcdef123456")).toBe(false);
    expect(secrets.variableValues()[0]?.value).toBe(base.value);
  });

  test("缺省范围 any、档位 rules；短值可登记但标记不可遮罩", async () => {
    const r = await post({ name: "sudo_pw", value: "abcd", scopeKind: "sudo" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      scopeKind: "sudo",
      tier: "rules",
      maskable: false,
    });
  });

  test.each([
    [{ ...base, name: "1abc" }, "invalid_name"],
    [{ ...base, name: "a-b" }, "invalid_name"],
    [{ ...base, value: "abc" }, "invalid_value"],
    [{ name: "x" }, "invalid_value"],
    [{ ...base, tier: "yolo" }, "invalid_tier"],
    [{ ...base, scopeKind: "zone" }, "invalid_scope"],
    [{ ...base, scopeKind: "domain" }, "invalid_scope"],
    [{ ...base, scopeKind: "domain", scopeTarget: "a b" }, "invalid_scope"],
    [{ ...base, scopeKind: "any", scopeTarget: "x.com" }, "invalid_scope"],
  ])("非法输入 %j → 400", async (body, error) => {
    const r = await post(body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe(error);
  });

  test("重名 409；PATCH 不带值则保留原值；DELETE 后 404", async () => {
    const id = (await post(base)).json().id;
    expect((await post({ ...base, value: "another-value" })).statusCode).toBe(
      409,
    );
    const p = await app.inject({
      method: "PATCH",
      url: `/api/v1/variables/${id}`,
      payload: { purpose: "改了用途", tier: "full" },
    });
    expect(p.json()).toMatchObject({ purpose: "改了用途", tier: "full" });
    expect(secrets.variableValues()[0]?.value).toBe(base.value);
    const v = await app.inject({
      method: "PATCH",
      url: `/api/v1/variables/${id}`,
      payload: { value: "new-secret-value" },
    });
    expect(v.body).not.toContain("new-secret-value");
    expect(secrets.variableValues()[0]?.value).toBe("new-secret-value");
    const del = () =>
      app.inject({ method: "DELETE", url: `/api/v1/variables/${id}` });
    expect((await del()).statusCode).toBe(204);
    expect((await del()).statusCode).toBe(404);
  });

  test("变量不出现在凭据接口，也不能经凭据接口删除或被环境引用", async () => {
    const id = (await post(base)).json().id;
    const list = await app.inject({ method: "GET", url: "/api/v1/secrets" });
    expect(list.json().secrets).toEqual([]);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/secrets/${id}`,
    });
    expect(del.statusCode).toBe(404);
    const env = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      payload: { name: "e", host: "h", username: "u", secretId: id },
    });
    expect(env.statusCode).toBe(400);
    expect(secrets.reveal(id)).toBeNull();
  });
});
