// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 测试里要写 ${VAR} 与 ${secret:id} 这类字面量
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type PackageInfo,
  ResolveError,
  type VersionResolver,
} from "../mcp/pin.js";
import { McpRuntime } from "../mcp/runtime.js";
import { CapabilityStore } from "../store/capabilities.js";
import { type Db, openDatabase } from "../store/db.js";
import { DirectoryStore } from "../store/directories.js";
import { type McpConfig, McpStore } from "../store/mcp.js";
import { PromptPresetStore } from "../store/prompt-presets.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { WorkspaceStore } from "../store/workspaces.js";
import { mcpApi } from "./mcp.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

let dir: string;
let db: Db;
let app: FastifyInstance;
let mcp: McpStore;
let runtime: McpRuntime;
let presets: PromptPresetStore;
let capabilities: CapabilityStore;
let workspaces: WorkspaceStore;
let wsId: string;
let secrets: SecretStore;
let http: Server | null = null;
// 假 npx：把 pkg@版本 里带 9.9.9 的当作装不上，其余都转去跑本地 fixture server。
let fakeNpx: string;
// 版本解析桩：不访问外网。
const registry: Record<string, PackageInfo | ResolveError> = {};
const resolver: VersionResolver = {
  async resolve(_rt, pkg) {
    const r = registry[pkg];
    if (!r) throw new ResolveError("package_not_found", `仓库里没有 ${pkg}`);
    if (r instanceof ResolveError) throw r;
    return r;
  },
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-v2-"));
  db = openDatabase(dir);
  mcp = new McpStore(db);
  secrets = new SecretStore(db, loadMasterKey(dir));
  capabilities = new CapabilityStore(db);
  presets = new PromptPresetStore(db);
  workspaces = new WorkspaceStore(db);
  new DirectoryStore(db).ensureDefault(dir);
  wsId = workspaces.create({ name: "w" }).id;
  runtime = new McpRuntime({ mcp, secrets, capabilities, resolver });
  fakeNpx = path.join(dir, "npx");
  writeFileSync(
    fakeNpx,
    `#!/bin/sh
for a in "$@"; do case "$a" in *9.9.9*) echo "npm error code ETARGET: no matching version" >&2; exit 1;; esac; done
exec "${process.execPath}" "${FIXTURE}"
`,
  );
  chmodSync(fakeNpx, 0o755);
  registry["fx-pkg"] = {
    latest: "1.2.3",
    versions: ["1.0.0", "1.1.0", "1.2.3", "2.0.0-rc.1"],
    description: "包元数据里的描述",
  };
  app = Fastify();
  app.register(mcpApi, {
    mcp,
    secrets,
    workspaces,
    capabilities,
    runtime,
    presets,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await runtime.close();
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(registry)) delete registry[k];
});

const get = (url: string) => app.inject({ method: "GET", url });
const post = (url: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url, payload: payload as object });
const put = (url: string, payload: unknown) =>
  app.inject({ method: "PUT", url, payload: payload as object });
const patch = (url: string, payload: unknown) =>
  app.inject({ method: "PATCH", url, payload: payload as object });
const del = (url: string) => app.inject({ method: "DELETE", url });

const fixtureEntry = (extra: object = {}) => ({
  command: process.execPath,
  args: [FIXTURE],
  ...extra,
});
const json = (name: string, entry: object) => ({
  json: { mcpServers: { [name]: entry } },
});
const npxEntry = (extra: object = {}) => ({
  command: fakeNpx,
  args: ["-y", "fx-pkg"],
  ...extra,
});
const addNpx = async (name = "fx") =>
  (await post("/api/v1/mcp", json(name, npxEntry()))).json();

describe("POST /mcp/validate", () => {
  test("逐条诊断；合法时给预览，不落库", async () => {
    let r = (
      await post("/api/v1/mcp/validate", {
        json: JSON.stringify({
          mcpServers: {
            "bad.name": { command: "npx -y x", env: { A: 1 }, foo: 1 },
          },
        }),
      })
    ).json();
    expect(r.ok).toBe(false);
    expect(r.preview).toBeNull();
    expect(r.diagnostics.map((d: { code: string }) => d.code).sort()).toEqual(
      [
        "command_has_space",
        "invalid_map",
        "invalid_name",
        "unknown_key",
      ].sort(),
    );
    r = (await post("/api/v1/mcp/validate", json("ok", fixtureEntry()))).json();
    expect(r).toMatchObject({
      ok: true,
      preview: { name: "ok", transport: "stdio", envCount: 0 },
    });
    expect(mcp.list()).toEqual([]);
  });

  test("重名按 - 与 _ 相同、不分大小写；editing 把自己排除", async () => {
    await post("/api/v1/mcp", json("my-srv", fixtureEntry()));
    const dup = (
      await post("/api/v1/mcp/validate", json("MY_SRV", fixtureEntry()))
    ).json();
    expect(dup.ok).toBe(false);
    expect(dup.diagnostics[0]).toMatchObject({ code: "name_exists" });
    const self = (
      await post("/api/v1/mcp/validate", {
        ...json("my-srv", fixtureEntry()),
        editing: "my-srv",
      })
    ).json();
    expect(self.ok).toBe(true);
  });

  test("没有 json 字段 400", async () => {
    expect((await post("/api/v1/mcp/validate", {})).statusCode).toBe(400);
  });
});

describe("POST /mcp {json}", () => {
  test("创建：名称取自键，新字段取默认值，描述拿不到时写来源未提供描述", async () => {
    const r = await post(
      "/api/v1/mcp",
      json("notes", fixtureEntry({ exposure: "hidden", timeout: 30 })),
    );
    expect(r.statusCode).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({
      name: "notes",
      transport: "stdio",
      approval: "ask",
      enabled: true,
      exposure: "hidden",
      timeout: 30,
      description: "来源未提供描述",
      handshake: null,
      version: null,
      pinned: false,
      latestVersion: null,
      source: null,
      status: null,
      conf: { command: process.execPath, exposure: "hidden", timeout: 30 },
    });
  });

  test("校验失败 400 带逐条诊断；重名 409", async () => {
    let r = await post("/api/v1/mcp", json("x", { command: "a b" }));
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({
      error: "invalid_config",
      diagnostics: [{ code: "command_has_space" }],
    });
    await post("/api/v1/mcp", json("a-b", fixtureEntry()));
    r = await post("/api/v1/mcp", json("A_B", fixtureEntry()));
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("name_exists");
  });

  test("旧的结构化入参照常可用，视图带新字段；重名判断同样按 -/_ 与大小写", async () => {
    const cfg: McpConfig = {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: [],
    };
    const r = await post("/api/v1/mcp", { name: "old-style", config: cfg });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      name: "old-style",
      config: cfg,
      approval: "ask",
      enabled: true,
    });
    const dup = await post("/api/v1/mcp", { name: "OLD_STYLE", config: cfg });
    expect(dup.statusCode).toBe(409);
  });

  test("env 里的 ${VAR} 在连接时取 Server 环境；没设置就点名", async () => {
    await post(
      "/api/v1/mcp",
      json("e", fixtureEntry({ env: { X: "p-${YS_MCP_TEST_VAR}" } })),
    );
    process.env.YS_MCP_TEST_VAR = "hello";
    try {
      const r = await runtime.call("e", "env", { name: "X" });
      expect(JSON.stringify(r.content)).toContain("p-hello");
    } finally {
      delete process.env.YS_MCP_TEST_VAR;
    }
    await runtime.forget("e");
    const c = (await post("/api/v1/mcp/e/check")).json();
    expect(c.ok).toBe(false);
    expect(c.steps.start.error).toContain("YS_MCP_TEST_VAR");
  });
});

describe("PATCH 审批档与启停", () => {
  test("审批两档与启停；非法值（含已去掉的 deny）400；404", async () => {
    await post("/api/v1/mcp", json("m", fixtureEntry()));
    let v = (await patch("/api/v1/mcp/m", { approval: "allow" })).json();
    expect(v).toMatchObject({ approval: "allow", enabled: true });
    v = (await patch("/api/v1/mcp/m", { enabled: false })).json();
    expect(v).toMatchObject({ approval: "allow", enabled: false });
    expect(v.conf.enabled).toBe(false);
    for (const approval of ["yes", "deny", 1])
      expect((await patch("/api/v1/mcp/m", { approval })).statusCode).toBe(400);
    expect((await patch("/api/v1/mcp/m", { enabled: "no" })).statusCode).toBe(
      400,
    );
    expect(
      (await patch("/api/v1/mcp/none", { enabled: true })).statusCode,
    ).toBe(404);
  });

  test("禁用即断开实例：运行时状态清掉，新会话不再带它的工具", async () => {
    await post("/api/v1/mcp", json("m", fixtureEntry()));
    await post("/api/v1/mcp/m/refresh");
    expect(runtime.status("m")?.state).toBe("ok");
    capabilities.set(wsId, "mcp", ["m"]);
    expect((await runtime.prepare("s", wsId)).length).toBe(3);
    await patch("/api/v1/mcp/m", { enabled: false });
    expect(runtime.status("m")).toBeUndefined();
    expect(await runtime.prepare("s", wsId)).toEqual([]);
  });

  test("exposure=hidden（含按工具覆盖）的工具不注册给模型", async () => {
    await post(
      "/api/v1/mcp",
      json("m", fixtureEntry({ toolExposure: { fail: "hidden" } })),
    );
    capabilities.set(wsId, "mcp", ["m"]);
    expect(
      (await runtime.prepare("s", wsId)).map((d) => d.tool.name).sort(),
    ).toEqual(["echo", "env"]);
    await put("/api/v1/mcp/m", json("m", fixtureEntry({ exposure: "hidden" })));
    expect(await runtime.prepare("s", wsId)).toEqual([]);
  });
});

describe("改名（A10）", () => {
  test("旧名被预设能力集 / 工作区分配引用：409 并列出位置，不改", async () => {
    await post("/api/v1/mcp", json("old", fixtureEntry()));
    presets.create({
      kind: "agent",
      name: "引用者",
      capabilities: ["mcp:old"],
    });
    capabilities.set(wsId, "mcp", ["old"]);
    const r = await put("/api/v1/mcp/old", json("fresh", fixtureEntry()));
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.error).toBe("mcp_referenced");
    expect(
      body.references.map((x: { kind: string; name: string }) => [
        x.kind,
        x.name,
      ]),
    ).toEqual([
      ["preset", "引用者"],
      ["workspace", expect.any(String)],
    ]);
    expect(mcp.get("old")).toBeDefined();
    expect(mcp.get("fresh")).toBeUndefined();
  });

  test("没有引用：等于新增并删除，新条目用 JSON 里的值与默认审批档", async () => {
    await post("/api/v1/mcp", json("old", fixtureEntry()));
    await patch("/api/v1/mcp/old", { approval: "allow" });
    const r = await put("/api/v1/mcp/old", json("fresh", fixtureEntry()));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      name: "fresh",
      renamedFrom: "old",
      approval: "ask",
    });
    expect(mcp.get("old")).toBeUndefined();
  });

  test("改成与别的条目重名（- 与 _ 同）409", async () => {
    await post("/api/v1/mcp", json("a", fixtureEntry()));
    await post("/api/v1/mcp", json("b-c", fixtureEntry()));
    const r = await put("/api/v1/mcp/a", json("B_C", fixtureEntry()));
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("name_exists");
  });

  test("名字不变只是改配置：保留审批档，作废工具缓存与握手", async () => {
    await post("/api/v1/mcp", json("m", fixtureEntry()));
    await patch("/api/v1/mcp/m", { approval: "allow" });
    await post("/api/v1/mcp/m/refresh");
    expect(mcp.get("m")?.handshake?.ok).toBe(true);
    const r = await put(
      "/api/v1/mcp/m",
      json("m", fixtureEntry({ exposure: "direct" })),
    );
    expect(r.json()).toMatchObject({
      approval: "allow",
      exposure: "direct",
      handshake: null,
      tools: null,
    });
  });

  test("旧的 { config } 入参仍能更新", async () => {
    await post("/api/v1/mcp", json("m", fixtureEntry()));
    const r = await put("/api/v1/mcp/m", {
      config: {
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
        env: [{ key: "X", value: "1" }],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().conf.env).toEqual({ X: "1" });
  });
});

describe("检测", () => {
  test("成功：启动 / 握手 / 列工具三步都带耗时，握手结果落库", async () => {
    await post("/api/v1/mcp", json("m", fixtureEntry()));
    const r = (await post("/api/v1/mcp/m/check")).json();
    expect(r).toMatchObject({
      name: "m",
      ok: true,
      tools: 3,
      steps: {
        start: { state: "ok" },
        handshake: { state: "ok" },
        list: { state: "ok" },
      },
      handshake: { ok: true, tools: 3 },
    });
    for (const s of Object.values(r.steps) as { ms: number }[])
      expect(s.ms).toBeGreaterThanOrEqual(0);
    expect(r.handshake.ms).toBeGreaterThan(0);
    expect(r.server.handshake).toMatchObject({ ok: true, tools: 3 });
    expect(r.server.tools).toHaveLength(3);
  });

  test("失败逐步点名：命令不存在卡在启动，后两步跳过", async () => {
    await post(
      "/api/v1/mcp",
      json("m", { command: path.join(dir, "no-such-bin") }),
    );
    const r = (await post("/api/v1/mcp/m/check")).json();
    expect(r.ok).toBe(false);
    expect(r.steps.start).toMatchObject({ state: "error" });
    expect(r.steps.start.error).toContain("ENOENT");
    expect(r.steps.handshake.state).toBe("skipped");
    expect(r.steps.list.state).toBe("skipped");
    expect(r.server.handshake).toMatchObject({ ok: false, tools: 0 });
    expect(r.server.handshake.error).toContain("ENOENT");
  });

  test("http 401：失败原因点名令牌过期，卡在握手", async () => {
    const srv = createServer((_req, res) => {
      res.statusCode = 401;
      res.end("token expired");
    });
    http = srv;
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    await post("/api/v1/mcp", json("remote", { url }));
    const r = (await post("/api/v1/mcp/remote/check")).json();
    expect(r.ok).toBe(false);
    expect(r.steps.start.state).toBe("ok");
    expect(r.steps.handshake.state).toBe("error");
    expect(r.steps.handshake.error).toContain("HTTP 401");
    expect(r.steps.handshake.error).toContain("令牌");
    expect(r.handshake.error).toContain("HTTP 401");
  });

  test("refresh 也记握手（耗时），旧响应形状不变", async () => {
    await post("/api/v1/mcp", json("m", fixtureEntry()));
    const r = await post("/api/v1/mcp/m/refresh");
    expect(r.statusCode).toBe(200);
    expect(r.json().tools).toHaveLength(3);
    expect(r.json().handshake).toMatchObject({ ok: true, tools: 3 });
    await post("/api/v1/mcp", json("bad", { command: path.join(dir, "nope") }));
    const f = await post("/api/v1/mcp/bad/refresh");
    expect(f.statusCode).toBe(502);
    expect(f.json().error).toBe("mcp_unavailable");
  });

  test("全部检测：只测已启用的，串行并汇总就绪数", async () => {
    await post("/api/v1/mcp", json("ok1", fixtureEntry()));
    await post("/api/v1/mcp", json("off", fixtureEntry({ enabled: false })));
    await post("/api/v1/mcp", json("bad", { command: path.join(dir, "nope") }));
    const r = (await post("/api/v1/mcp/check-all")).json();
    expect(r.total).toBe(2);
    expect(r.ready).toBe(1);
    expect(r.results.map((x: { name: string }) => x.name)).toEqual([
      "bad",
      "ok1",
    ]);
    expect(mcp.get("off")?.handshake).toBeNull();
    expect(r.servers).toHaveLength(3);
  });
});

describe.skipIf(process.platform === "win32")("试装并固定", () => {
  test("成功才写回 pkg@版本；版本取解析到的最新版，工具与握手随之更新", async () => {
    await addNpx();
    const before = (await get("/api/v1/mcp")).json().servers[0];
    expect(before).toMatchObject({
      pinned: false,
      version: null,
      source: { runtime: "npm", pkg: "fx-pkg" },
    });
    const r = await post("/api/v1/mcp/fx/try-pin");
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      ok: true,
      version: "1.2.3",
      latestVersion: "1.2.3",
      check: { ok: true, tools: 3 },
    });
    expect(body.server).toMatchObject({
      pinned: true,
      version: "1.2.3",
      latestVersion: "1.2.3",
      description: "包元数据里的描述",
      handshake: { ok: true, tools: 3 },
      conf: { args: ["-y", "fx-pkg@1.2.3"] },
    });
    expect(mcp.get("fx")?.tools).toHaveLength(3);
  });

  test("选旧版本 = 回退并锁定；解析到的最新版仍记着（低于解析）", async () => {
    await addNpx();
    await post("/api/v1/mcp/fx/try-pin");
    const r = (
      await post("/api/v1/mcp/fx/try-pin", { version: "1.0.0" })
    ).json();
    expect(r).toMatchObject({
      ok: true,
      version: "1.0.0",
      latestVersion: "1.2.3",
    });
    expect(r.server).toMatchObject({
      version: "1.0.0",
      latestVersion: "1.2.3",
      conf: { args: ["-y", "fx-pkg@1.0.0"] },
    });
  });

  test("试装失败：不写回，仍是浮动；原因点名", async () => {
    await addNpx();
    const r = await post("/api/v1/mcp/fx/try-pin", { version: "9.9.9" });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({
      error: "run_failed",
      steps: { handshake: { state: "error" } },
    });
    expect(r.json().message).toContain("9.9.9");
    expect(r.json().message).toContain("ETARGET");
    const cfg = mcp.get("fx")?.config;
    expect(cfg?.transport === "stdio" && cfg.args).toEqual(["-y", "fx-pkg"]);
    expect(r.json().server).toMatchObject({ pinned: false, version: null });
  });

  test("已固定后再试装失败：保留之前的固定版本", async () => {
    await addNpx();
    await post("/api/v1/mcp/fx/try-pin", { version: "1.1.0" });
    const r = await post("/api/v1/mcp/fx/try-pin", { version: "9.9.9" });
    expect(r.statusCode).toBe(502);
    expect(r.json().server).toMatchObject({ pinned: true, version: "1.1.0" });
  });

  test("无网络：明确的 network_unavailable，不写回", async () => {
    await addNpx();
    registry["fx-pkg"] = new ResolveError(
      "network_unavailable",
      "无法访问包仓库（无网络？）",
    );
    const r = await post("/api/v1/mcp/fx/try-pin");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "network_unavailable" });
    expect(r.json().message).toContain("无网络");
    expect(mcp.get("fx")?.handshake).toBeNull();
    const v = await post("/api/v1/mcp/fx/versions");
    expect(v.statusCode).toBe(503);
  });

  test("包不存在 422；非 npx/uvx 或 http 不可固定 400；版本形如 x.y.z", async () => {
    await post(
      "/api/v1/mcp",
      json("gone", { command: fakeNpx, args: ["nope"] }),
    );
    expect((await post("/api/v1/mcp/gone/try-pin")).statusCode).toBe(422);
    await post("/api/v1/mcp", json("plain", fixtureEntry()));
    const np = await post("/api/v1/mcp/plain/try-pin");
    expect(np.statusCode).toBe(400);
    expect(np.json().error).toBe("not_pinnable");
    await post("/api/v1/mcp", json("web", { url: "https://a.example/mcp" }));
    expect((await post("/api/v1/mcp/web/try-pin")).json().error).toBe(
      "not_pinnable",
    );
    await addNpx();
    for (const version of ["latest", "1.2", "^1.2.3"]) {
      const r = await post("/api/v1/mcp/fx/try-pin", { version });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_version");
    }
    expect((await post("/api/v1/mcp/none/try-pin")).statusCode).toBe(404);
  });

  test("候选版本：新的在前，标出当前与最新，预发布不抢最新", async () => {
    await addNpx();
    await post("/api/v1/mcp/fx/try-pin", { version: "1.1.0" });
    const r = (await post("/api/v1/mcp/fx/versions")).json();
    expect(r).toMatchObject({
      pkg: "fx-pkg",
      runtime: "npm",
      current: "1.1.0",
      latest: "1.2.3",
    });
    expect(r.versions.map((v: { version: string }) => v.version)).toEqual([
      "2.0.0-rc.1",
      "1.2.3",
      "1.1.0",
      "1.0.0",
    ]);
    expect(r.versions.filter((v: { current: boolean }) => v.current)).toEqual([
      { version: "1.1.0", current: true, latest: false },
    ]);
    expect(r.versions.find((v: { latest: boolean }) => v.latest).version).toBe(
      "1.2.3",
    );
  });

  test("查候选版本会刷新解析到的最新版：固定之后包源出了新版，列表上能看出来", async () => {
    await addNpx();
    await post("/api/v1/mcp/fx/try-pin", { version: "1.1.0" });
    expect(mcp.get("fx")?.latestVersion).toBe("1.2.3");
    registry["fx-pkg"] = {
      latest: "1.3.0",
      versions: ["1.1.0", "1.2.3", "1.3.0"],
      description: null,
    };
    await post("/api/v1/mcp/fx/versions");
    expect(mcp.get("fx")?.latestVersion).toBe("1.3.0");
    const row = (await get("/api/v1/mcp")).json().servers[0];
    expect(row).toMatchObject({ version: "1.1.0", latestVersion: "1.3.0" });
  });

  test("改成别的包：固定版本与解析到的最新版随之作废", async () => {
    await addNpx();
    await post("/api/v1/mcp/fx/try-pin");
    const r = await put(
      "/api/v1/mcp/fx",
      json("fx", { command: fakeNpx, args: ["-y", "other-pkg"] }),
    );
    expect(r.json()).toMatchObject({
      pinned: false,
      version: null,
      latestVersion: null,
    });
  });
});

describe("批量", () => {
  test("逐项结果，部分失败不回滚其它项", async () => {
    await addNpx("a");
    await post("/api/v1/mcp", json("b", { command: fakeNpx, args: ["nope"] }));
    const r = (
      await post("/api/v1/mcp/batch", {
        action: "pin",
        names: ["a", "b", "ghost", "a"],
      })
    ).json();
    expect(r.action).toBe("pin");
    expect(r.okCount).toBe(1);
    expect(r.failCount).toBe(2);
    expect(
      r.results.map((x: { name: string; ok: boolean; error?: string }) => [
        x.name,
        x.ok,
        x.error,
      ]),
    ).toEqual([
      ["a", true, undefined],
      ["b", false, "package_not_found"],
      ["ghost", false, "not_found"],
    ]);
    expect(mcp.get("a")?.config).toMatchObject({
      args: ["-y", "fx-pkg@1.2.3"],
    });
    expect(mcp.get("b")?.config).toMatchObject({ args: ["nope"] });
  });

  test("启用 / 禁用 / 检测 / 卸载", async () => {
    await post("/api/v1/mcp", json("a", fixtureEntry()));
    await post("/api/v1/mcp", json("b", fixtureEntry()));
    let r = (
      await post("/api/v1/mcp/batch", { action: "disable", names: ["a", "b"] })
    ).json();
    expect(r.okCount).toBe(2);
    expect(mcp.list().every((m) => !m.enabled)).toBe(true);
    r = (
      await post("/api/v1/mcp/batch", { action: "enable", names: ["a"] })
    ).json();
    expect(mcp.get("a")?.enabled).toBe(true);
    expect(mcp.get("b")?.enabled).toBe(false);
    r = (
      await post("/api/v1/mcp/batch", {
        action: "check",
        names: ["a", "ghost"],
      })
    ).json();
    expect(r.results[0]).toMatchObject({ name: "a", ok: true });
    expect(r.results[0].detail.steps.list.state).toBe("ok");
    expect(r.results[1]).toMatchObject({ ok: false, error: "not_found" });
    capabilities.set(wsId, "mcp", ["a"]);
    r = (
      await post("/api/v1/mcp/batch", {
        action: "uninstall",
        names: ["a", "b"],
      })
    ).json();
    expect(r.okCount).toBe(2);
    expect(mcp.list()).toEqual([]);
    expect(capabilities.list(wsId, "mcp")).toEqual([]);
    expect(runtime.status("a")).toBeUndefined();
  });

  test("参数校验", async () => {
    for (const body of [
      { action: "nuke", names: ["a"] },
      { action: "check", names: [] },
      { action: "check", names: [1] },
      { action: "check" },
    ])
      expect((await post("/api/v1/mcp/batch", body)).statusCode).toBe(400);
  });
});

describe("旧路由回归", () => {
  test("GET/POST/PUT/DELETE /mcp 与 /refresh 保持可用", async () => {
    const cfg: McpConfig = {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: [],
    };
    expect(
      (await post("/api/v1/mcp", { name: "m", config: cfg })).statusCode,
    ).toBe(201);
    expect((await get("/api/v1/mcp")).json().servers).toHaveLength(1);
    expect((await put("/api/v1/mcp/m", { config: cfg })).statusCode).toBe(200);
    expect((await post("/api/v1/mcp/m/refresh")).statusCode).toBe(200);
    expect((await del("/api/v1/mcp/m")).statusCode).toBe(204);
    expect((await get("/api/v1/mcp")).json().servers).toEqual([]);
  });
});
