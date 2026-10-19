import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../server.js";

const TOKEN = "t".repeat(40);
let base: string;
let server: YuanshuServer | null = null;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "yuanshu-models-"));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(base, { recursive: true, force: true });
});

async function launch() {
  const dataDir = path.join(base, "data");
  const start = path.join(base, "start");
  mkdirSync(dataDir);
  mkdirSync(start);
  server = createServer(
    { host: "127.0.0.1", port: 0, dataDir, token: TOKEN, allowCidrs: [] },
    { startDir: start },
  );
  const addr = await server.start();
  const call = (method: string, url: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${addr.port}/api/v1/models${url}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { call, dataDir };
}

const body = (over: Record<string, unknown> = {}) => ({
  name: "本地",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1/v1",
  modelId: "m1",
  apiKey: "sk-super-secret",
  ...over,
});

describe("模型登记", () => {
  test("登记成功：首条自动成为默认，响应与落盘文件都不含密钥", async () => {
    const { call, dataDir } = await launch();
    const res = await call("POST", "", body());
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ name: "本地", isDefault: true, hasKey: true });
    expect(JSON.stringify(created)).not.toContain("sk-super-secret");
    for (const f of readdirSync(path.join(dataDir, "models"))) {
      expect(readFileSync(path.join(dataDir, "models", f), "utf8")).not.toContain(
        "sk-super-secret",
      );
    }
  });

  test("切换默认只留一个；删除默认后另一条顶上", async () => {
    const { call } = await launch();
    const a = await (await call("POST", "", body({ name: "a" }))).json();
    const b = await (await call("POST", "", body({ name: "b" }))).json();
    await call("PATCH", `/${b.id}`, { isDefault: true });
    let list = (await (await call("GET", "")).json()).models;
    expect(list.filter((m: { isDefault: boolean }) => m.isDefault)).toHaveLength(1);
    expect(list.find((m: { id: string }) => m.id === b.id).isDefault).toBe(true);
    expect((await call("DELETE", `/${b.id}`)).status).toBe(204);
    list = (await (await call("GET", "")).json()).models;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.id, isDefault: true });
  });

  test("字段非法返回 400；不存在的 id 返回 404", async () => {
    const { call } = await launch();
    expect((await call("POST", "", body({ baseUrl: "ftp://x" }))).status).toBe(400);
    expect((await call("POST", "", body({ api: "nope" }))).status).toBe(400);
    expect((await call("DELETE", "/missing")).status).toBe(404);
  });

  test("连接测试：不可达的地址返回 ok:false 与原因，且不落盘", async () => {
    const { call, dataDir } = await launch();
    const res = await call("POST", "/test", body());
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe("string");
    expect(readdirSync(path.join(dataDir, "models"))).toEqual([]);
  });
});
