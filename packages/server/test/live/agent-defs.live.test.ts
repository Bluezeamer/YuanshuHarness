// 手动冒烟：真实模型，验证会话模式生效——激活只读模式后写调用被拒，没有模式时能写。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。
//
// 用法（密钥只从文件读取，不会打印）：
//   YUANSHU_LIVE=1 pnpm --filter yuanshu-harness-server exec vitest run test/live/agent-defs.live.test.ts
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
import type { Frame } from "../support/frames.js";
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
async function askWrite(
  presetId: string,
  line: string,
  modeId?: string,
): Promise<Frame[]> {
  const session = await call("POST", "/api/v1/sessions", {
    promptPresetId: presetId,
    ...(modeId ? { modePresetIds: [modeId] } : {}),
  });
  if (modeId)
    await call("PUT", `/api/v1/sessions/${session.id}/modes`, {
      activeModeId: modeId,
    });
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
    // 没等到运行结束时把已收到的帧列出来，方便区分是模型卡住还是别的
    expect(
      client.frames.some((f) => f.type === "run.ended"),
      `没有 run.ended；收到的帧：${client.frames
        .map((f) => f.type)
        .reduce<string[]>((acc, t) => {
          const m = /^(.*)×(\d+)$/.exec(acc.at(-1) ?? "");
          if (m?.[1] === t) acc[acc.length - 1] = `${t}×${Number(m[2]) + 1}`;
          else if (acc.at(-1) === t) acc[acc.length - 1] = `${t}×2`;
          else acc.push(t);
          return acc;
        }, [])
        .join(
          ",",
        )} | 最后一帧：${JSON.stringify(client.frames.at(-1)?.data ?? null).slice(0, 400)}`,
    ).toBe(true);
    return client.frames.filter((f) => f.type === "tool.ended");
  } finally {
    client.close();
  }
}

test.skipIf(!enabled)(
  "激活只读模式后写文件被拒，没有模式时能写",
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
    await call("PUT", "/api/v1/defaults", { permissionTier: "full" });

    // 同一个 agent（全部工具、完全允许档）；区别只在会话是否激活了「限定为只读工具集」的模式。
    const agent = await call("POST", "/api/v1/studio/presets", {
      kind: "agent",
      description: "live",
      name: "live-agent",
      capabilities: toolNames(() => true).map((name) => `tool:${name}`),
    });
    const readOnly = await call("POST", "/api/v1/studio/presets", {
      kind: "mode",
      description: "live",
      name: "live-readonly",
      capabilities: ["tool:read", "tool:grep", "tool:find", "tool:ls"],
    });

    const target = path.join(start, "target.txt");
    const planEnded = await askWrite(agent.id, "PLAN-LINE", readOnly.id);
    expect(existsSync(target), "只读模式下不应写出文件").toBe(false);
    const planWrite = planEnded.find((f) => f.data.toolName === "write");
    // 模型也可能一开始就拒绝尝试；尝试了就必须是被拒的。
    if (planWrite) expect(planWrite.data.isError).toBe(true);

    const buildEnded = await askWrite(agent.id, "BUILD-LINE");
    const buildWrite = buildEnded.find((f) => f.data.toolName === "write");
    expect(buildWrite, "模型没有调用 write").toBeDefined();
    expect(buildWrite?.data.isError).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("BUILD-LINE");
  },
  360_000,
);
