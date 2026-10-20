// 手动冒烟：真实模型，验证 subagent 全链路——父 spawn 一个子去读文件返回暗号，父 wait 拿到结果。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。
//
// 用法（密钥只从文件读取，不会打印）：
//   pnpm --filter yuanshu-harness-server exec vitest run test/live/subagent.live.test.ts
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
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../../src/server.js";
import { createSessionFactory } from "../../src/session/factory.js";
import { toolNames } from "../../src/session/tool-catalog.js";
import { TestClient } from "../support/ws-client.js";

const MODEL_FILE = "/home/bluezeamer/projects/Yuanshu-harness/tmp/model";
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

    // 父与子共用同一个 agent（全部工具，含 spawn/wait/interrupt）。
    const agent = await call("POST", "/api/v1/agents", {
      name: "live-sub",
      description: "live",
      promptBlocks: [],
      capabilities: toolNames(() => true).map((name) => ({
        kind: "tool",
        name,
      })),
      defaultMode: "build",
    });
    const session = await call("POST", "/api/v1/sessions", {
      agentId: agent.id,
    });
    const client = await TestClient.connect(
      `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text:
          "请先用 spawn_subagent 派发一个子代理，任务是：读取当前目录的 secret.txt，把里面的内容原样作为最终回复。" +
          "派发后用 wait_subagent 等它完成，然后在你的最终回复里原样写出它返回的暗号。",
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
      const waited = ended.find((f) => f.data.toolName === "wait_subagent");
      expect(spawned, "模型没有调用 spawn_subagent").toBeDefined();
      expect(spawned?.data.isError).toBe(false);
      expect(waited, "模型没有调用 wait_subagent").toBeDefined();
      expect(waited?.data.isError).toBe(false);
      expect(String(waited?.data.output), "wait 的结果里应有暗号").toContain(
        SECRET,
      );
    } finally {
      client.close();
    }

    const { nodes } = await call("GET", "/api/v1/topology");
    expect(nodes).toHaveLength(2);
    const child = nodes.find((n: { parentId: string | null }) => n.parentId);
    expect(child?.parentId).toBe(session.id);
    expect(child?.state).toBe("done");
    expect(child?.denied).toBe(0);
  },
  300_000,
);
