import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { McpRuntime } from "../mcp/runtime.js";
import { CapabilityStore } from "../store/capabilities.js";
import { type Db, openDatabase } from "../store/db.js";
import { type McpConfig, McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { mcpApi } from "./mcp.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);
const stdio = (): McpConfig => ({
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  env: [],
});

let dir: string;
let db: Db;
let app: FastifyInstance;
let mcp: McpStore;
let secrets: SecretStore;
let wsId: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-api-"));
  db = openDatabase(dir);
  mcp = new McpStore(db);
  secrets = new SecretStore(db, loadMasterKey(dir));
  const capabilities = new CapabilityStore(db);
  const workspaces = new WorkspaceStore(db);
  wsId = workspaces.ensureDefault(dir)?.id as string;
  app = Fastify();
  app.register(mcpApi, {
    mcp,
    secrets,
    capabilities,
    workspaces,
    runtime: new McpRuntime({ mcp, secrets, capabilities }),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: "GET", url });
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });
const put = (url: string, payload: unknown) =>
  app.inject({ method: "PUT", url, payload: payload as object });
const del = (url: string) => app.inject({ method: "DELETE", url });

describe("库 CRUD", () => {
  test("列出全库，新建时返 201 与最新状态", async () => {
    let r = await get("/api/v1/mcp");
    expect(r.json().servers).toEqual([]);
    r = await post("/api/v1/mcp", { name: "m", config: stdio() });
    expect(r.statusCode).toBe(201);
    const data = r.json();
    expect(data.name).toBe("m");
    expect(data.status).toBeNull();
    expect(data.config).toBeTruthy();
    r = await get("/api/v1/mcp");
    expect(r.json().servers).toHaveLength(1);
  });

  test("名字校验：空、超长、非法字符都拒", async () => {
    const bad = ["", "x".repeat(33), "my.srv"];
    for (const name of bad) {
      const r = await post("/api/v1/mcp", { name, config: stdio() });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_name");
    }
  });

  test("名字冲突返 409", async () => {
    await post("/api/v1/mcp", { name: "x", config: stdio() });
    expect(
      (await post("/api/v1/mcp", { name: "x", config: stdio() })).statusCode,
    ).toBe(409);
  });

  test("config 校验：缺字段或类型错都拒", async () => {
    const bad = [
      {},
      { transport: "unknown" },
      { transport: "stdio" },
      { transport: "http", url: 123 },
    ];
    for (const config of bad) {
      const r = await post("/api/v1/mcp", { name: "m", config });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_config");
    }
  });

  test("secretId 不在密码库时拒新建", async () => {
    const r = await post("/api/v1/mcp", {
      name: "m",
      config: { ...stdio(), env: [{ key: "A", secretId: "gone" }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_config");
    expect(r.json().message).toContain("密码库");
  });

  test("更新 server config，返回最新记录", async () => {
    await post("/api/v1/mcp", { name: "m", config: stdio() });
    const r = await put("/api/v1/mcp/m", {
      config: { ...stdio(), env: [{ key: "X", value: "1" }] },
    });
    expect(r.statusCode).toBe(200);
    const cfg = mcp.get("m")?.config;
    expect(cfg?.transport === "stdio" && cfg.env).toHaveLength(1);
  });

  test("更新后 runtime 缓存清空", async () => {
    await post("/api/v1/mcp", { name: "m", config: stdio() });
    await post("/api/v1/mcp/m/refresh", {});
    expect(mcp.get("m")?.tools).toHaveLength(3);
    await put("/api/v1/mcp/m", { config: stdio() });
    expect(mcp.get("m")?.tools).toBeNull();
  });

  test("删除登记，返 204 并清缓存，二次删返 404", async () => {
    await post("/api/v1/mcp", { name: "m", config: stdio() });
    await post("/api/v1/mcp/m/refresh", {});
    expect((await del("/api/v1/mcp/m")).statusCode).toBe(204);
    expect(mcp.get("m")).toBeUndefined();
    expect((await del("/api/v1/mcp/m")).statusCode).toBe(404);
  });
});

describe("refresh 与工具列表缓存", () => {
  test("连上后写入 tools 与 status，再次 GET 能看到", async () => {
    await post("/api/v1/mcp", { name: "m", config: stdio() });
    const r = await post("/api/v1/mcp/m/refresh", {});
    expect(r.statusCode).toBe(200);
    expect(r.json().config.transport).toBe("stdio");
    expect(r.json().status?.state).toBe("ok");
    expect(r.json().tools).toHaveLength(3);
    expect(mcp.get("m")?.tools).toHaveLength(3);
  });

  test("连不上时返 502 并记录错误状态，登记不受影响", async () => {
    await post("/api/v1/mcp", {
      name: "m",
      config: { transport: "stdio", command: "/nope", args: [], env: [] },
    });
    const r = await post("/api/v1/mcp/m/refresh", {});
    expect(r.statusCode).toBe(502);
    expect(mcp.get("m")).toBeTruthy();
    const view = (await get("/api/v1/mcp")).json().servers[0];
    expect(view.status?.state).toBe("error");
  });
});

describe("workspace 级 MCP 分配", () => {
  test("整体替换，只接受存在的 server", async () => {
    await post("/api/v1/mcp", { name: "a", config: stdio() });
    await post("/api/v1/mcp", { name: "b", config: stdio() });
    let r = await put(`/api/v1/workspaces/${wsId}/mcp`, { names: ["a", "b"] });
    expect(r.json().names.sort()).toEqual(["a", "b"]);
    r = await get(`/api/v1/workspaces/${wsId}/mcp`);
    expect(r.json().names).toHaveLength(2);
    r = await put(`/api/v1/workspaces/${wsId}/mcp`, { names: ["a"] });
    expect(r.json().names).toEqual(["a"]);
  });

  test("未知 server 拒绝", async () => {
    const r = await put(`/api/v1/workspaces/${wsId}/mcp`, { names: ["gone"] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("unknown_mcp");
  });
});
