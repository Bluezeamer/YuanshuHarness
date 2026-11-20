import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EnvHub } from "../env/hub.js";
import { AuditLog } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { EnvironmentStore } from "../store/environments.js";
import {
  loadMasterKey,
  SecretStore,
  VAR_COUNT_MAX,
  VAR_TOTAL_MAX,
} from "../store/secrets.js";
import { WorkspaceVariableStore } from "../store/workspace-variables.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { environmentsApi } from "./environments.js";
import { variablesApi } from "./variables.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let secrets: SecretStore;
let hub: EnvHub;
let workspaces: WorkspaceStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-var-"));
  db = openDatabase(dir);
  secrets = new SecretStore(db, loadMasterKey(dir));
  const environments = new EnvironmentStore(db);
  hub = new EnvHub(environments, secrets);
  workspaces = new WorkspaceStore(db);
  app = Fastify();
  app.register(variablesApi, {
    secrets,
    audit: new AuditLog(db),
    workspaces,
    workspaceVariables: new WorkspaceVariableStore(db),
  });
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
    [{ ...base, group: "   " }, "invalid_group"],
    [{ ...base, group: "x".repeat(33) }, "invalid_group"],
    [{ ...base, group: "a\u0000b" }, "invalid_group"],
    [{ ...base, group: 5 }, "invalid_group"],
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

describe("工作区启用与变量组", () => {
  const ws = () => workspaces.create({ name: `w-${Math.random()}` }).id;
  const put = (url: string, payload: unknown) =>
    app.inject({ method: "PUT", url, payload: payload as object });

  test("新建时可选 workspaces：先校验工作区存在，不存在就什么都不建", async () => {
    const r = await post({ ...base, workspaces: ["nope"] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_workspace");
    expect(secrets.listVariables()).toEqual([]);
    const id = ws();
    const ok = await post({ ...base, workspaces: [id] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().workspaces).toEqual([id]);
  });

  test("变量的启用工作区可整份替换；列表不逐个查也带全", async () => {
    const a = ws();
    const b = ws();
    const id = (await post(base)).json().id as string;
    const set = await put(`/api/v1/variables/${id}/workspaces`, {
      workspaces: [a, b],
    });
    expect(set.json().workspaces.sort()).toEqual([a, b].sort());
    const list = await app.inject({ method: "GET", url: "/api/v1/variables" });
    expect(list.json().variables[0].workspaces.sort()).toEqual([a, b].sort());
    expect(
      (
        await put(`/api/v1/variables/${id}/workspaces`, { workspaces: [] })
      ).json().workspaces,
    ).toEqual([]);
    expect(
      (await put("/api/v1/variables/nope/workspaces", { workspaces: [] }))
        .statusCode,
    ).toBe(404);
  });

  test("工作区的启用清单：GET/PUT，校验变量与工作区存在", async () => {
    const w = ws();
    const id = (await post(base)).json().id as string;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/workspaces/${w}/variables`,
        })
      ).json(),
    ).toEqual({ variables: [] });
    const set = await put(`/api/v1/workspaces/${w}/variables`, {
      variables: [id],
    });
    expect(set.json()).toEqual({ variables: [id] });
    expect(
      (
        await put(`/api/v1/workspaces/${w}/variables`, { variables: ["nope"] })
      ).json().error,
    ).toBe("invalid_variable");
    expect(
      (await put("/api/v1/workspaces/nope/variables", { variables: [] }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/workspaces/nope/variables",
        })
      ).statusCode,
    ).toBe(404);
  });

  test("改组名与解散组：没成员 404，新名不合法 400", async () => {
    const id = (await post({ ...base, group: "部署" })).json().id as string;
    expect((await post({ ...base, group: "  " })).statusCode).toBe(400);
    const renamed = await put("/api/v1/variable-groups/部署", {
      name: "运维",
    });
    expect(renamed.json()).toEqual({ renamed: 1 });
    expect(secrets.getVariable(id)?.group).toBe("运维");
    expect(
      (await put("/api/v1/variable-groups/运维", { name: "  " })).json().error,
    ).toBe("invalid_group");
    expect(
      (await put("/api/v1/variable-groups/没有成员", { name: "x" })).statusCode,
    ).toBe(404);
    const del = () =>
      app.inject({ method: "DELETE", url: "/api/v1/variable-groups/运维" });
    expect((await del()).statusCode).toBe(204);
    expect(secrets.getVariable(id)?.group).toBeNull();
    expect((await del()).statusCode).toBe(404);
  });
});

describe("规模上限与缓存", () => {
  test("变量数量到上限后创建返回 400 limit_exceeded，删除一个后又能创建", async () => {
    for (let i = 0; i < VAR_COUNT_MAX; i++)
      expect(
        (await post({ name: `v${i}`, value: `value-${i}-xxxx` })).statusCode,
      ).toBe(201);
    const over = await post({ name: "extra", value: "value-extra-xxxx" });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe("limit_exceeded");
    const first = secrets.listVariables()[0] as { id: string };
    expect(secrets.removeVariable(first.id)).toBe(true);
    expect(
      (await post({ name: "extra", value: "value-extra-xxxx" })).statusCode,
    ).toBe(201);
  });

  test("总明文大小超限：创建与加长值的 PATCH 都被拒，缩短后又能放行", async () => {
    const big = "x".repeat(16 * 1024);
    for (let i = 0; i < 15; i++)
      expect((await post({ name: `b${i}`, value: big })).statusCode).toBe(201);
    const small = (await post({ name: "small", value: "abcd" })).json()
      .id as string;
    // 凑满：15 个大值 + 4 字节 + (16K - 4) 字节 = 上限
    expect(
      (await post({ name: "fill", value: "y".repeat(16 * 1024 - 4) }))
        .statusCode,
    ).toBe(201);
    expect((await post({ name: "more", value: "abcd" })).statusCode).toBe(400);
    const patch = (value: string) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/variables/${small}`,
        payload: { value },
      });
    const grow = await patch("abcdefgh");
    expect(grow.statusCode).toBe(400);
    expect(grow.json().error).toBe("limit_exceeded");
    expect((await patch("abc!")).statusCode).toBe(200);
  });

  test("读缓存随写入失效：改值、改名、删除后内部清单立即反映", async () => {
    const r = await post(base);
    const id = r.json().id as string;
    expect(secrets.variableValues()[0]?.value).toBe(base.value);
    await app.inject({
      method: "PATCH",
      url: `/api/v1/variables/${id}`,
      payload: { value: "glpat-zzzzzzzz9999" },
    });
    expect(secrets.variableValues()[0]?.value).toBe("glpat-zzzzzzzz9999");
    await app.inject({ method: "DELETE", url: `/api/v1/variables/${id}` });
    expect(secrets.variableValues()).toEqual([]);
    expect(secrets.maskVars()).toEqual([]);
  });

  test("遮罩清单含凭据（占位文本不是 @name），同一版本返回同一个数组", async () => {
    await post(base);
    secrets.create("mcp-token", "password", "cred-value-1234");
    const m1 = secrets.maskVars();
    expect(m1.map((x) => x.label ?? `@${x.name}`).sort()).toEqual(
      ["@gitlab_token", "[凭据 mcp-token]"].sort(),
    );
    expect(secrets.maskVars()).toBe(m1);
    secrets.create("other", "password", "cred-value-5678");
    const m2 = secrets.maskVars();
    expect(m2).not.toBe(m1);
    expect(m2).toHaveLength(3);
    expect(
      secrets.remove(secrets.list().find((s) => s.name === "other")?.id ?? ""),
    ).toBe("ok");
    expect(secrets.maskVars()).toHaveLength(2);
  });

  test("凭据被登记的引用方使用时删除返回 409 in_use，引用解除后可删", async () => {
    const s = secrets.create("api-key", "password", "key-value-12345");
    let used = true;
    secrets.addReferrer((id) => id === s?.id && used);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/secrets/${s?.id}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("in_use");
    used = false;
    const ok = await app.inject({
      method: "DELETE",
      url: `/api/v1/secrets/${s?.id}`,
    });
    expect(ok.statusCode).toBe(204);
  });
});
