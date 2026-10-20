import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CapabilityStore } from "./capabilities.js";
import { type Db, openDatabase } from "./db.js";
import { type McpConfig, McpStore, parseMcpConfig } from "./mcp.js";
import { WorkspaceStore } from "./workspaces.js";

let dir: string;
let db: Db;
let store: McpStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-"));
  db = openDatabase(dir);
  store = new McpStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stdio = {
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", "srv"] as string[],
};

describe("parseMcpConfig", () => {
  test("stdio：args 与 env 规整", () => {
    expect(
      parseMcpConfig({ ...stdio, env: [{ key: "A", value: "1" }] }),
    ).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "srv"],
      env: [{ key: "A", value: "1" }],
    });
    expect(parseMcpConfig({ transport: "stdio", command: "x" })).toEqual({
      transport: "stdio",
      command: "x",
      args: [],
      env: [],
    });
  });

  test("http：密码库引用可带前缀，前缀不能配明文", () => {
    expect(
      parseMcpConfig({
        transport: "http",
        url: "https://example.com/mcp",
        headers: [{ key: "Authorization", secretId: "s1", prefix: "Bearer " }],
      }),
    ).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      headers: [{ key: "Authorization", secretId: "s1", prefix: "Bearer " }],
    });
    expect(
      parseMcpConfig({
        transport: "http",
        url: "https://example.com",
        headers: [{ key: "A", value: "v", prefix: "x" }],
      }),
    ).toMatch(/prefix/);
  });

  test.each([
    [{ command: "x" }, /transport/],
    [{ transport: "stdio" }, /command/],
    [{ transport: "stdio", command: "x", args: [1] }, /args/],
    [{ transport: "http", url: "ftp://x" }, /url/],
    [{ transport: "http", url: "not a url" }, /url/],
    [
      {
        transport: "stdio",
        command: "x",
        env: [{ key: "A", value: "v", secretId: "s" }],
      },
      /二选一/,
    ],
    [
      {
        transport: "stdio",
        command: "x",
        env: [
          { key: "A", value: "1" },
          { key: "A", value: "2" },
        ],
      },
      /重复/,
    ],
  ])("拒绝无效配置 %#", (raw, msg) => {
    expect(parseMcpConfig(raw)).toMatch(msg);
  });
});

describe("McpStore", () => {
  const cfg: McpConfig = {
    transport: "stdio",
    command: "x",
    args: [],
    env: [],
  };

  test("create / get / list，重名返回 null", () => {
    const a = store.create("a", cfg);
    expect(a?.tools).toBeNull();
    expect(store.create("a", cfg)).toBeNull();
    store.create("b", cfg);
    expect(store.list().map((s) => s.name)).toEqual(["a", "b"]);
    expect(store.get("a")?.config).toEqual(cfg);
    expect(store.get("none")).toBeUndefined();
  });

  test("setTools 写缓存，update 改配置并作废缓存", () => {
    store.create("a", cfg);
    store.setTools("a", [
      { name: "t", description: "d", inputSchema: { type: "object" } },
    ]);
    expect(store.get("a")?.tools).toHaveLength(1);
    expect(store.get("a")?.toolsAt).not.toBeNull();
    const u = store.update("a", {
      transport: "http",
      url: "https://x.example/mcp",
      headers: [],
    });
    expect(u?.config.transport).toBe("http");
    expect(u?.tools).toBeNull();
    expect(u?.toolsAt).toBeNull();
    expect(store.update("none", cfg)).toBeUndefined();
  });

  test("remove 同时清除 workspace 级分配", () => {
    const ws = new WorkspaceStore(db).create("w", "/tmp/w");
    if (!ws) throw new Error("workspace");
    const caps = new CapabilityStore(db);
    store.create("a", cfg);
    caps.set(ws.id, "mcp", ["a"]);
    caps.set(ws.id, "skill", ["a"]);
    expect(store.remove("a")).toBe(true);
    expect(caps.list(ws.id, "mcp")).toEqual([]);
    expect(caps.list(ws.id, "skill")).toEqual(["a"]);
    expect(store.remove("a")).toBe(false);
  });
});
