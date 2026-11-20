// 远程目录的会话：stdio MCP 服务经 SSH 起在那台主机上；用户断开 / 重新激活主机后行为正确。
// 真实会话池 + pi 的 MCP 扩展 + 回环 sshd；模型是桩，工具是 test/support/mcp-fixture.mjs。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { collector, waitFor } from "../../test/support/frames.js";
import { hasSshd, startSshd, type TestSshd } from "../../test/support/sshd.js";
import {
  startStub,
  stubSessionFactory,
  testData,
  testPool,
} from "../../test/support/stub.js";
import { EnvHub } from "../env/hub.js";
import { CapabilityStore } from "../store/capabilities.js";
import { EnvironmentStore } from "../store/environments.js";
import { McpStore } from "../store/mcp.js";
import { loadMasterKey, SecretStore } from "../store/secrets.js";
import { McpRuntime } from "./runtime.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/support/mcp-fixture.mjs", import.meta.url),
);

const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [];
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{ role: string }>;
  return CALLS[msgs.filter((m) => m.role === "tool").length] ?? "done";
});
afterAll(() => stub.close());

let sshd: TestSshd;
beforeAll(async () => {
  if (hasSshd) sshd = await startSshd();
});
afterAll(async () => {
  if (hasSshd) await sshd.close();
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  CALLS.length = 0;
  stub.requests.length = 0;
});

// 请求里带着整段历史：只看最新的一条工具结果，旧的结果不能算数
const lastToolResult = () => {
  const last = stub.requests.at(-1);
  if (!last) throw new Error("桩没收到请求");
  const msgs = (last.body as { messages: { role: string }[] }).messages;
  return JSON.stringify(msgs.filter((m) => m.role === "tool").at(-1));
};

test.skipIf(!hasSshd)(
  "远程目录会话：服务经 SSH 起在主机上；断开后报错带指引，重新激活后恢复，再断开仍然生效",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-mcp-session-"));
    const data = testData(path.join(dir, "data"));
    const secrets = new SecretStore(data.db, loadMasterKey(data.dir));
    const environments = new EnvironmentStore(data.db);
    const hub = new EnvHub(environments, secrets);
    const mcpStore = new McpStore(data.db);
    const capabilities = new CapabilityStore(data.db);
    const mcp = new McpRuntime({ mcp: mcpStore, secrets, capabilities });
    const t = testPool(stubSessionFactory(stub, {}, true), data, {
      mcp,
      envHub: hub,
      environments,
    });
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => hub.close(),
      () => mcp.close(),
      () => data.close(true),
      () => t.pool.dispose(),
    );

    const key = secrets.create("k", "ssh_key", sshd.privateKey);
    const env = environments.create({
      name: "loop",
      host: "127.0.0.1",
      port: sshd.port,
      username: sshd.user,
      os: "posix",
      secretId: key?.id ?? null,
    });
    const remote = env
      ? data.directories.create("remote", dir, new Date(), env.id)
      : null;
    if (!env || !remote) throw new Error("夹具没建成");
    mcpStore.create("fx", {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: [],
    });
    mcpStore.patch("fx", { approval: "allow", global: true });

    const info = await t.pool.create({ directoryIds: [remote.id] });
    const entry = t.pool.get(info.id);
    if (!entry) throw new Error("会话不在池里");
    const c = collector();
    entry.subscribe(c);

    // sshd 给它启动的进程设 SSH_CONNECTION，末段是 sshd 的端口：以此证明进程经 SSH 起来
    const callEnv = async () => {
      c.frames.length = 0;
      CALLS.push({ tool: "mcp__fx__env", args: { name: "SSH_CONNECTION" } });
      entry.send("go");
      await waitFor(() => c.types().includes("run.ended"), "run.ended", 20000);
      return lastToolResult();
    };
    const viaSsh = ` 127.0.0.1 ${sshd.port}`;
    // 断开后通道的关闭事件要几毫秒才传到 pi；真实使用里用户点断开与模型下次调用之间远不止这点
    const disconnect = async () => {
      hub.pause(env.id);
      await new Promise((ok) => setTimeout(ok, 300));
    };

    expect(await callEnv()).toContain(viaSsh);

    // 用户断开：工具调用的报错要让模型知道是用户断开、别重试、让用户去激活
    await disconnect();
    const cut = await callEnv();
    expect(cut).toContain("is disconnected");
    expect(cut).toContain("Settings → Remote connections");

    // 重新激活：主机的环境对象会换新，服务要重新起在新连接上
    hub.prepareActivation(env.id);
    expect(await callEnv()).toContain(viaSsh);

    // 再断开必须真的断：若工厂还拿着创建会话时的旧环境对象，这一步会绕开用户的断开
    await disconnect();
    expect(await callEnv()).toContain("is disconnected");
  },
  60000,
);
