import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CapabilityStore } from "../store/capabilities.js";
import { type Db, openDatabase } from "../store/db.js";
import { type McpConfig, type McpEntry, McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { McpRuntime, resolveMcp } from "./runtime.js";
import { buildToolDefs, toBlocks, toolName } from "./tools.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

let dir: string;
let db: Db;
let store: McpStore;
let secrets: SecretStore;
let capabilities: CapabilityStore;
let runtime: McpRuntime;
let wsId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-"));
  db = openDatabase(dir);
  store = new McpStore(db);
  secrets = new SecretStore(db, loadMasterKey(dir));
  capabilities = new CapabilityStore(db);
  runtime = new McpRuntime({ mcp: store, secrets, capabilities });
  wsId = new WorkspaceStore(db).ensureDefault(dir)?.id as string;
});
afterEach(async () => {
  await runtime.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stdio = (env: McpEntry[] = []): McpConfig => ({
  transport: "stdio",
  command: process.execPath,
  args: [FIXTURE],
  env,
});

describe("工具命名与结果转换", () => {
  test("非法字符替换，超长或撞名带哈希", () => {
    const taken = new Set<string>();
    expect(toolName("my-srv", "do.it", taken)).toBe("mcp__my_srv__do_it");
    const long = toolName("s", "x".repeat(80), taken);
    expect(long.length).toBeLessThanOrEqual(64);
    taken.add("mcp__s__a");
    expect(toolName("s", "a", taken)).not.toBe("mcp__s__a");
  });

  test("buildToolDefs 全局唯一", () => {
    const t = { name: "a", description: "", inputSchema: {} };
    const defs = buildToolDefs([
      { name: "s", tools: [t] },
      { name: "s", tools: [t] },
    ]);
    expect(new Set(defs.map((d) => d.name)).size).toBe(2);
  });

  test("非文本块折成说明，超长文本截断", () => {
    const out = toBlocks([
      { type: "text", text: "x".repeat(50_000) },
      { type: "audio", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///a", text: "内容" } },
    ]);
    expect(out[0]?.type === "text" && out[0].text.length).toBeLessThan(41_000);
    expect(out[1]).toMatchObject({ type: "text" });
    expect(out[2]).toMatchObject({ text: "内容" });
  });
});

describe("resolveMcp", () => {
  test("agent 在前、workspace 在后，去重，缺失单列", () => {
    store.create("a", stdio());
    store.create("b", stdio());
    const r = resolveMcp(store.list(), ["b", "gone"], ["a", "b"]);
    expect(r.servers.map((s) => s.name)).toEqual(["b", "a"]);
    expect(r.missing).toEqual(["gone"]);
  });
});

describe("McpRuntime（真实 stdio server）", () => {
  test("refresh 列出并缓存工具，call 转发并返回内容", async () => {
    store.create("fx", stdio());
    const r = await runtime.refresh("fx");
    expect(r.ok && r.tools.map((t) => t.name).sort()).toEqual([
      "echo",
      "env",
      "fail",
    ]);
    expect(store.get("fx")?.tools).toHaveLength(3);
    expect(runtime.status("fx")?.state).toBe("ok");
    const res = await runtime.call("fx", "echo", { text: "hi" });
    expect(toBlocks(res.content)).toEqual([{ type: "text", text: "echo:hi" }]);
    expect((await runtime.call("fx", "fail", {})).isError).toBe(true);
  });

  test("密码库引用在连接时展开，库里不落明文", async () => {
    const s = secrets.create("tok", "password", "s3cret") as { id: string };
    store.create(
      "fx",
      stdio([{ key: "TOKEN", secretId: s.id, prefix: "Bearer " }]),
    );
    const res = await runtime.call("fx", "env", { name: "TOKEN" });
    expect(toBlocks(res.content)).toEqual([
      { type: "text", text: "Bearer s3cret" },
    ]);
    const raw = (
      db.prepare("SELECT config FROM mcp_servers").get() as { config: string }
    ).config;
    expect(raw).not.toContain("s3cret");
  });

  test("连不上时 refresh 返回原因并记录状态，不抛出", async () => {
    store.create("bad", {
      transport: "stdio",
      command: "/nonexistent/mcp-server",
      args: [],
      env: [],
    });
    const r = await runtime.refresh("bad");
    expect(r.ok).toBe(false);
    expect(runtime.status("bad")?.state).toBe("error");
  });

  test("prepare：workspace 分配的 server 无缓存时先连上，返回工具定义", async () => {
    store.create("fx", stdio());
    store.create("other", stdio());
    capabilities.set(wsId, "mcp", ["fx"]);
    const defs = await runtime.prepare("s1", wsId);
    expect(defs.map((d) => d.name).sort()).toEqual([
      "mcp__fx__echo",
      "mcp__fx__env",
      "mcp__fx__fail",
    ]);
    expect(store.get("other")?.tools).toBeNull();
  });

  test("prepare：agent 引用与 workspace 分配合并", async () => {
    store.create("fx", stdio());
    const rt = new McpRuntime({
      mcp: store,
      secrets,
      capabilities,
      agentMcp: () => ["fx"],
    });
    try {
      expect(await rt.prepare("s1", wsId)).toHaveLength(3);
    } finally {
      await rt.close();
    }
  });

  test("streamable-http：请求头带密码库展开的凭证", async () => {
    const seen: (string | undefined)[] = [];
    const http = createServer(async (req, res) => {
      seen.push(req.headers.authorization);
      const server = new McpServer({ name: "h", version: "0.0.0" });
      server.tool("ping", "pong", {}, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => void server.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    try {
      const { port } = http.address() as AddressInfo;
      const s = secrets.create("tok", "password", "abc") as { id: string };
      store.create("web", {
        transport: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: [{ key: "Authorization", secretId: s.id, prefix: "Bearer " }],
      });
      const r = await runtime.refresh("web");
      expect(r.ok && r.tools.map((t) => t.name)).toEqual(["ping"]);
      expect(seen.every((h) => h === "Bearer abc")).toBe(true);
      const res = await runtime.call("web", "ping", {});
      expect(toBlocks(res.content)).toEqual([{ type: "text", text: "pong" }]);
    } finally {
      http.closeAllConnections();
      http.close();
    }
  });

  test("forget 后按新配置重连", async () => {
    store.create("fx", stdio());
    await runtime.refresh("fx");
    store.update("fx", stdio([{ key: "A", value: "1" }]));
    await runtime.forget("fx");
    const res = await runtime.call("fx", "env", { name: "A" });
    expect(toBlocks(res.content)).toEqual([{ type: "text", text: "1" }]);
  });
});
