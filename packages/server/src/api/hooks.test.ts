import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Db, openDatabase } from "../store/db.js";
import { DirectoryStore } from "../store/directories.js";
import { type Hook, HookStore } from "../store/hooks.js";
import { hooksApi } from "./hooks.js";

let dir: string;
let db: Db;
let app: FastifyInstance;
let hooks: HookStore;
let directories: DirectoryStore;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-hooks-api-"));
  db = openDatabase(dir);
  hooks = new HookStore(db);
  directories = new DirectoryStore(db);
  directories.create("默认", dir);
  app = Fastify();
  app.register(hooksApi, {
    hooks,
    directories,
    runtime: {
      test: async (h: Hook, _ctx: unknown, payload?: unknown) => ({
        hookId: h.id,
        hookName: h.name,
        result: "ok",
        exitCode: 0,
        durationMs: 10,
        stdout: JSON.stringify(payload ?? null),
        stderr: "",
      }),
    } as never,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  name: "示例",
  point: "PreToolUse",
  matcher: "bash",
  command: "echo ok",
  timeoutSec: 30,
  enabled: true,
  directoryId: null,
};

describe("hooks API", () => {
  test("GET /api/v1/hooks 返回列表与点位表", async () => {
    const h = hooks.create(base);
    const r = await app.inject({ method: "GET", url: "/api/v1/hooks" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.hooks).toHaveLength(1);
    expect(body.hooks[0].id).toBe(h.id);
    expect(body.points).toBeDefined();
    expect(body.points.length).toBeGreaterThan(0);
  });

  test("POST 创建 hook", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/hooks",
      payload: base,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe(base.name);
  });

  test("POST 校验失败返回 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/hooks",
      payload: { ...base, name: "" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toContain("name");
  });

  test("POST 引用不存在的 directory 返回 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/hooks",
      payload: { ...base, directoryId: "no-such-ws" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("unknown_directory");
  });

  test("PUT 更新 hook", async () => {
    const h = hooks.create(base);
    const r = await app.inject({
      method: "PUT",
      url: `/api/v1/hooks/${h.id}`,
      payload: { name: "改名" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().name).toBe("改名");
    expect(r.json().command).toBe(base.command);
  });

  test("PUT 不存在的 id 返回 404", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/api/v1/hooks/no-such-hook",
      payload: { name: "x" },
    });
    expect(r.statusCode).toBe(404);
  });

  test("DELETE 删除 hook", async () => {
    const h = hooks.create(base);
    const r = await app.inject({
      method: "DELETE",
      url: `/api/v1/hooks/${h.id}`,
    });
    expect(r.statusCode).toBe(204);
    expect(hooks.get(h.id)).toBeUndefined();
  });

  test("DELETE 不存在的 id 返回 404", async () => {
    const r = await app.inject({
      method: "DELETE",
      url: "/api/v1/hooks/no-such-hook",
    });
    expect(r.statusCode).toBe(404);
  });

  test("POST /test 执行试跑", async () => {
    const h = hooks.create(base);
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/hooks/${h.id}/test`,
      payload: { payload: { tool_name: "write" } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.result).toBe("ok");
    expect(body.hookId).toBe(h.id);
    expect(body.stdout).toContain("write");
  });

  test("POST /test 不存在的 id 返回 404", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/no-such-hook/test",
      payload: {},
    });
    expect(r.statusCode).toBe(404);
  });
});
