import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuditLog } from "../store/audit.js";
import { type Db, openDatabase } from "../store/db.js";
import { ReferenceStore } from "../store/references.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { WorkspaceVariableStore } from "../store/workspace-variables.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { variablesApi } from "./variables.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let secrets: SecretStore;
let audit: AuditLog;
let references: ReferenceStore;
let workspaces: WorkspaceStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-var2-"));
  db = openDatabase(dir);
  secrets = new SecretStore(db, loadMasterKey(dir));
  audit = new AuditLog(db);
  references = new ReferenceStore(db);
  workspaces = new WorkspaceStore(db);
  app = Fastify();
  app.register(variablesApi, {
    secrets,
    audit,
    references,
    workspaces,
    workspaceVariables: new WorkspaceVariableStore(db),
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (payload: unknown, url = "/api/v1/variables") =>
  app.inject({ method: "POST", url, payload: payload as object });
const get = (url: string) => app.inject({ method: "GET", url });
const SECRET = "glpat-abcdef123456";
const mk = (over: Record<string, unknown> = {}) => ({
  name: "gitlab.token",
  desc: "GitLab 访问令牌",
  value: SECRET,
  ...over,
});

describe("新契约：名称文法与 desc", () => {
  test("带 desc 的新建只收新文法；返回 desc、遮罩值、owner、expired", async () => {
    const r = await post(mk());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "gitlab.token",
      desc: "GitLab 访问令牌",
      purpose: "GitLab 访问令牌",
      kind: "text",
      group: null,
      workspaces: [],
      scopeKind: "any",
      scopeTarget: null,
      policy: "allow",
      expiry: { kind: "never" },
      expired: false,
      owner: "user",
      valueMasked: "••••••••3456",
    });
    expect(r.body).not.toContain(SECRET);
    expect(r.json()).not.toHaveProperty("value");
    expect(r.json()).not.toHaveProperty("expiresAt");
  });

  test.each([
    ["大写开头", "Gitlab"],
    ["数字开头", "1token"],
    ["太短", "ab"],
    ["太长", `a${"b".repeat(48)}`],
    ["非法字符", "a b c"],
  ])("新契约拒绝名称：%s", async (_n, name) => {
    const r = await post(mk({ name }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_name");
  });

  test("desc 必填且不能全空白", async () => {
    for (const desc of ["", "   ", 5]) {
      const r = await post(mk({ desc }));
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_desc");
    }
  });

  test("旧契约（只带 purpose）仍收旧文法，旧变量原样可读", async () => {
    const r = await post({
      name: "Gitlab_Token",
      purpose: "旧客户端",
      value: SECRET,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "Gitlab_Token",
      desc: "旧客户端",
      purpose: "旧客户端",
    });
    const list = await get("/api/v1/variables");
    expect(list.json().variables.map((v: { name: string }) => v.name)).toEqual([
      "Gitlab_Token",
    ]);
  });

  test("policy / expiry 校验", async () => {
    expect((await post(mk({ policy: "block" }))).json().error).toBe(
      "invalid_policy",
    );
    for (const expiry of [
      { kind: "days", days: 0 },
      { kind: "days", days: 1.5 },
      { kind: "at", at: "not-a-date" },
      { kind: "later" },
    ])
      expect((await post(mk({ expiry }))).json().error).toBe("invalid_expiry");
  });
});

describe("文件型", () => {
  test("元数据由 Server 按内容计算，响应不含内容", async () => {
    const content = "line1\nline2\n";
    const r = await post(
      mk({
        name: "deploy.key",
        kind: "file",
        fileName: "id_ed25519",
        value: content,
      }),
    );
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.kind).toBe("file");
    expect(body.file).toMatchObject({
      name: "id_ed25519",
      bytes: 12,
      lines: 2,
    });
    expect(body.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body).not.toHaveProperty("valueMasked");
    expect(r.body).not.toContain("line1");
  });

  test("file 型必须有合法文件名", async () => {
    for (const fileName of [undefined, "", "a/b"]) {
      const r = await post(
        mk({ name: "deploy.key", kind: "file", value: "abcd", fileName }),
      );
      expect(r.json().error).toBe("invalid_file");
    }
  });
});

describe("reveal", () => {
  test("一次返回明文，no-store，并记一条审计（不含值）", async () => {
    const id = (await post(mk())).json().id;
    const r = await post({}, `/api/v1/variables/${id}/reveal`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json()).toEqual({
      id,
      name: "gitlab.token",
      kind: "text",
      value: SECRET,
    });
    const rows = audit
      .list({ kind: "secret" })
      .entries.filter((e) => e.kind === "secret");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "user",
      summary: "reveal variable gitlab.token",
    });
    expect(JSON.stringify(rows[0])).not.toContain(SECRET);
  });

  test("列表与详情始终不回明文；不存在 → 404 且不记审计", async () => {
    const id = (await post(mk())).json().id;
    for (const url of ["/api/v1/variables", `/api/v1/variables/${id}`])
      expect((await get(url)).body).not.toContain(SECRET);
    const r = await post({}, "/api/v1/variables/nope/reveal");
    expect(r.statusCode).toBe(404);
    expect(
      audit.list({ kind: "secret" }).entries.filter((e) => e.kind === "secret"),
    ).toEqual([]);
  });
});

describe("rotate", () => {
  test("换新值：遮罩变化、rotatedAt 出现、记审计；days 到期从此刻重新起算", async () => {
    // 只伪造 Date，不碰定时器，Fastify inject 照常工作
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await rotateFlow();
    } finally {
      vi.useRealTimers();
    }
  });

  async function rotateFlow() {
    const id = (await post(mk({ expiry: { kind: "days", days: 30 } }))).json()
      .id;
    // 创建 40 天后：已过期
    vi.setSystemTime(Date.now() + 40 * 86_400_000);
    const before = (await get(`/api/v1/variables/${id}`)).json();
    expect(before.expired).toBe(true);

    const r = await post(
      { value: "glpat-zzzzzzzz9999" },
      `/api/v1/variables/${id}/rotate`,
    );
    expect(r.statusCode).toBe(200);
    const after = r.json();
    expect(after.valueMasked).toBe("••••••••9999");
    expect(after.rotatedAt).toBeTruthy();
    expect(after.expired).toBe(false);
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.now());
    expect(
      (await post({}, `/api/v1/variables/${id}/reveal`)).json().value,
    ).toBe("glpat-zzzzzzzz9999");
    expect(
      audit
        .list({ kind: "secret" })
        .entries.some((e) => e.summary === "rotate variable gitlab.token"),
    ).toBe(true);
  }

  test("缺值 / 值过短 → 400；不存在 → 404；文本型不接受 fileName", async () => {
    const id = (await post(mk())).json().id;
    expect((await post({}, `/api/v1/variables/${id}/rotate`)).statusCode).toBe(
      400,
    );
    expect(
      (await post({ value: "ab" }, `/api/v1/variables/${id}/rotate`))
        .statusCode,
    ).toBe(400);
    expect(
      (await post({ value: "abcdef" }, "/api/v1/variables/nope/rotate"))
        .statusCode,
    ).toBe(404);
    const r = await post(
      { value: "abcdef", fileName: "x" },
      `/api/v1/variables/${id}/rotate`,
    );
    expect(r.json().error).toBe("invalid_file");
  });
});

describe("过期派生", () => {
  test("at 已过 → expired；at 未到 / never → 未过期；expiresAt 为 ISO 串", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await post(mk({ name: "old.token", expiry: { kind: "at", at: past } }));
    await post(mk({ name: "new.token", expiry: { kind: "at", at: future } }));
    await post(mk({ name: "forever.token" }));
    const byName = Object.fromEntries(
      (await get("/api/v1/variables"))
        .json()
        .variables.map((v: { name: string }) => [v.name, v]),
    );
    expect(byName["old.token"].expired).toBe(true);
    expect(byName["new.token"].expired).toBe(false);
    expect(byName["forever.token"].expired).toBe(false);
    expect(byName["old.token"].expiresAt).toBe(past);
    expect(byName["forever.token"]).not.toHaveProperty("expiresAt");
  });
});

describe("lastUsedAt", () => {
  test("引用成功后由运行时 touch；列表与详情随即可见，未用过的没有该字段", async () => {
    const id = (await post(mk())).json().id;
    await post(mk({ name: "other.token" }));
    const at = "2026-10-25T08:00:00.000Z";
    secrets.touchVariable("gitlab.token", at);
    expect((await get(`/api/v1/variables/${id}`)).json().lastUsedAt).toBe(at);
    const list = (await get("/api/v1/variables")).json().variables as Array<{
      name: string;
      lastUsedAt?: string;
    }>;
    expect(list.find((v) => v.name === "gitlab.token")?.lastUsedAt).toBe(at);
    expect(list.find((v) => v.name === "other.token")).not.toHaveProperty(
      "lastUsedAt",
    );
  });
});

describe("引用记录接口", () => {
  const rec = (name: string, result: string, ws = "ws1") =>
    references.record({
      name,
      directoryId: ws,
      hostId: "local",
      runId: "r1",
      toolCallId: `tc-${name}-${result}`,
      result: result as never,
    });

  test("按 directory / name / result 过滤，新的在前；返回形状", async () => {
    rec("a.token", "ok");
    rec("a.token", "denied");
    rec("b.token", "ok", "ws2");
    const all = (await get("/api/v1/references")).json();
    expect(all.references.map((x: { name: string }) => x.name)).toEqual([
      "b.token",
      "a.token",
      "a.token",
    ]);
    expect(all.nextBefore).toBeNull();
    expect(all.references[0]).toEqual({
      id: expect.any(String),
      name: "b.token",
      directoryId: "ws2",
      hostId: "local",
      runId: "r1",
      toolCallId: "tc-b.token-ok",
      at: expect.any(String),
      result: "ok",
    });
    const ws1 = (await get("/api/v1/references?directory=ws1")).json();
    expect(ws1.references).toHaveLength(2);
    const denied = (
      await get("/api/v1/references?name=a.token&result=denied")
    ).json();
    expect(denied.references).toHaveLength(1);
  });

  test("result 取值校验；分页游标", async () => {
    expect((await get("/api/v1/references?result=boom")).statusCode).toBe(400);
    expect((await get("/api/v1/references?limit=0")).statusCode).toBe(400);
    for (const r of ["ok", "denied", "expired", "unknown", "dropped"])
      rec("p.token", r);
    const page1 = (await get("/api/v1/references?limit=2")).json();
    expect(page1.references.map((x: { result: string }) => x.result)).toEqual([
      "dropped",
      "unknown",
    ]);
    expect(page1.nextBefore).not.toBeNull();
    const page2 = (
      await get(`/api/v1/references?limit=2&before=${page1.nextBefore}`)
    ).json();
    expect(page2.references.map((x: { result: string }) => x.result)).toEqual([
      "expired",
      "denied",
    ]);
  });
});
