// 手动冒烟：真实模型，验证 subagent 全链路——父 spawn 一个子去读文件返回暗号，父 wait 拿到结果。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。
//
// 用法（密钥只从文件读取，不会打印）：
//   YUANSHU_LIVE=1 pnpm --filter yuanshu-harness-server exec vitest run test/live/subagent.live.test.ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../../src/server.js";
import { createSessionFactory } from "../../src/session/factory.js";
import { toolNames } from "../../src/session/tool-catalog.js";
import { TestClient } from "../support/ws-client.js";

const MODEL_FILE = fileURLToPath(
  new URL("../../../../tmp/model", import.meta.url),
);
// pi models.json 形状：取第一个 provider 的第一个模型。
const provider = existsSync(MODEL_FILE)
  ? Object.values<any>(
      JSON.parse(readFileSync(MODEL_FILE, "utf8")).providers,
    )[0]
  : undefined;
const model = provider?.models?.[0];
const enabled = Boolean(model?.id);

const SECRET = `PINEAPPLE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

let root = "";
let start = "";
let server: YuanshuServer;
let http = "";

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${http}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return text ? JSON.parse(text) : undefined;
};

beforeAll(async () => {
  if (!enabled) return;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-sub-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  start = path.join(root, "start");
  mkdirSync(start);
  writeFileSync(path.join(start, "secret.txt"), `${SECRET}\n`);
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(root, "web"),
      startDir: start,
      makeSessionFactory: createSessionFactory,
      logStream: { write() {} },
    },
  );
  const addr = await server.start();
  http = `http://${addr.host}:${addr.port}`;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

test.skipIf(!enabled)(
  "父 spawn 子读文件拿暗号，父 wait 取回结果，拓扑里是一父一子",
  async () => {
    const m = await call("POST", "/api/v1/models", {
      name: "live",
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId: model.id,
      reasoning: Boolean(model.reasoning),
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: provider.compat,
      apiKey: provider.apiKey,
    });
    await call("PATCH", `/api/v1/models/${m.id}`, { isDefault: true });

    // 父与子共用同一个预设（全部工具；完全允许档不弹审批，子代理的档位仍最高到「模型」档）。
    await call("PUT", "/api/v1/defaults", { permissionTier: "full" });
    const preset = await call("POST", "/api/v1/studio/presets", {
      kind: "agent",
      name: "live-sub",
      description: "live",
      capabilities: toolNames(() => true).map((name) => `tool:${name}`),
    });
    const session = await call("POST", "/api/v1/sessions", {
      promptPresetId: preset.id,
    });
    const client = await TestClient.connect(
      `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text:
          "请用 spawn_subagent 派发一个子代理，任务是：用 read 工具读取当前目录的 secret.txt（相对路径直接用文件名；写绝对路径必须带主机前缀，如 local:/…），用 deliver 把里面的内容原样交付。" +
          "它交付后（交付内容就是 spawn_subagent 的工具结果），在你的最终回复里原样写出暗号。",
      });
      expect(ack.ok).toBe(true);
      const deadline = Date.now() + 240_000;
      while (
        !client.frames.some((f) => f.type === "run.ended") &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 200));
      expect(client.frames.some((f) => f.type === "run.ended")).toBe(true);

      const ended = client.frames.filter((f) => f.type === "tool.ended");
      const spawned = ended.find((f) => f.data.toolName === "spawn_subagent");
      expect(spawned, "模型没有调用 spawn_subagent").toBeDefined();
      expect(spawned?.data.isError).toBe(false);
      expect(String(spawned?.data.output), "交付里应有暗号").toContain(SECRET);
    } finally {
      client.close();
    }

    const { nodes } = await call("GET", "/api/v1/topology");
    expect(nodes).toHaveLength(2);
    const child = nodes.find((n: { parentId: string | null }) => n.parentId);
    expect(child?.parentId).toBe(session.id);
    expect(child?.state).toBe("done");
    expect(child?.denied, JSON.stringify(child?.deniedReasons)).toBe(0);
  },
  300_000,
);
