// 手动冒烟：真实模型，验证 agent 定义的模式生效——plan 模式的写调用被拒，build 模式能写。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。
//
// 用法（密钥只从文件读取，不会打印）：
//   pnpm --filter yuanshu-harness-server exec vitest run test/live/agent-defs.live.test.ts
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
import type { Frame } from "../support/frames.js";
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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-defs-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  start = path.join(root, "start");
  mkdirSync(start);
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

// 开一个会话，让模型把一行字写进 target.txt，返回整轮的 tool.ended 帧。
async function askWrite(agentId: string, line: string): Promise<Frame[]> {
  const session = await call("POST", "/api/v1/sessions", { agentId });
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
  );
  try {
    const ack = await client.command("send_message", {
      text: `请只用 write 工具把「${line}」写入当前目录的 target.txt，不要做别的。`,
    });
    expect(ack.ok).toBe(true);
    const deadline = Date.now() + 150_000;
    while (
      !client.frames.some((f) => f.type === "run.ended") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 200));
    expect(client.frames.some((f) => f.type === "run.ended")).toBe(true);
    return client.frames.filter((f) => f.type === "tool.ended");
  } finally {
    client.close();
  }
}

test.skipIf(!enabled)(
  "plan 模式的 agent 写文件被拒，build 模式能写",
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
    // full 档：build 模式的写入不应被审批卡住。
    const ws = (await call("GET", "/api/v1/workspaces")).workspaces[0];
    await call("PATCH", `/api/v1/workspaces/${ws.id}`, { tier: "full" });

    // 两个 agent 能力集相同（全部工具），区别只在模式。
    const base = {
      description: "live",
      promptBlocks: [],
      capabilities: toolNames(() => true).map((name) => ({
        kind: "tool",
        name,
      })),
    };
    const plan = await call("POST", "/api/v1/agents", {
      ...base,
      name: "live-plan",
      defaultMode: "plan",
    });
    const build = await call("POST", "/api/v1/agents", {
      ...base,
      name: "live-build",
      defaultMode: "build",
    });

    const target = path.join(start, "target.txt");
    const planEnded = await askWrite(plan.id, "PLAN-LINE");
    expect(existsSync(target), "plan 模式不应写出文件").toBe(false);
    const planWrite = planEnded.find((f) => f.data.toolName === "write");
    // 模型也可能一开始就拒绝尝试；尝试了就必须是被拒的。
    if (planWrite) expect(planWrite.data.isError).toBe(true);

    const buildEnded = await askWrite(build.id, "BUILD-LINE");
    const buildWrite = buildEnded.find((f) => f.data.toolName === "write");
    expect(buildWrite, "模型没有调用 write").toBeDefined();
    expect(buildWrite?.data.isError).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("BUILD-LINE");
  },
  360_000,
);
