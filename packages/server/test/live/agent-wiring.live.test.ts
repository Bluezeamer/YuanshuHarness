// 手动冒烟：真实模型，agent 定义里勾选的 skill 与 MCP 工具在会话里真的被用上。
// 不进默认检查：缺少端点配置时跳过。
//
// 用法（端点信息经仓库根的 tmp/model 读取）：
//   YUANSHU_LIVE=1 pnpm --filter yuanshu-harness-server exec vitest run test/live/agent-wiring.live.test.ts
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
import type { Frame } from "../support/frames.js";
import { TestClient } from "../support/ws-client.js";

const MODEL_FILE = fileURLToPath(
  new URL("../../../../tmp/model", import.meta.url),
);
const enabled = existsSync(MODEL_FILE);
const FIXTURE = fileURLToPath(
  new URL("../support/mcp-fixture.mjs", import.meta.url),
);

let root = "";
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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-wiring-live-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  const start = path.join(root, "start");
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

const outputOf = (f: Frame) => String(f.data.output ?? "");

test.skipIf(!enabled)(
  "agent 勾选 skill 与 MCP 工具，模型在会话里读到 skill 并调用 MCP 工具",
  async () => {
    const cfg = JSON.parse(readFileSync(MODEL_FILE, "utf8")) as {
      providers: Record<
        string,
        {
          baseUrl: string;
          api: string;
          apiKey?: string;
          models: { id: string }[];
        }
      >;
    };
    const [providerName, provider] = Object.entries(cfg.providers)[0] as [
      string,
      (typeof cfg.providers)[string],
    ];
    const model = await call("POST", "/api/v1/models", {
      name: providerName,
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId: (provider.models[0] as { id: string }).id,
      reasoning: false,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
    await call("PATCH", `/api/v1/models/${model.id}`, { isDefault: true });
    await call("PUT", "/api/v1/defaults", { permissionTier: "full" });

    await call("POST", "/api/v1/mcp", {
      name: "fx",
      config: {
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE],
      },
    });
    await call("POST", "/api/v1/skills", {
      name: "probe",
      scope: "global",
      content:
        "---\nname: probe\n" +
        "description: 当用户询问暗号或 probe 时使用，给出本项目的暗号。\n---\n\n" +
        "# probe\n\n本项目的暗号是 PROBE-X9Z。回答用户时原样给出这个暗号。\n",
    });
    // 只勾选引用：不做 directory 分配，能否用上全靠预设能力。
    const preset = await call("POST", "/api/v1/studio/presets", {
      kind: "agent",
      name: "wired-live",
      description: "live",
      capabilities: ["tool:read", "mcp:fx", "skill:probe"],
    });
    // 技能清单由 pi 渲染：预设里放一个 skills 段，pi 才会把技能列进 system prompt。
    const { preset: detail } = await call(
      "GET",
      `/api/v1/studio/presets/${preset.id}`,
    );
    await call("PUT", `/api/v1/studio/presets/${preset.id}/nodes`, {
      nodes: [
        ...detail.nodes,
        {
          id: `${preset.id}-skills`,
          tag: "skills",
          title: "技能清单",
          slotKind: "system",
          channel: "system",
          builtin: true,
          items: [],
        },
      ],
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
          "做两件事：1) 调用 mcp__fx__echo 工具，text 参数填 hello-wiring；" +
          "2) 先看你可用的 skill，阅读后告诉我本项目的暗号。完成后一句话汇报。",
      });
      expect(ack.ok).toBe(true);

      const deadline = Date.now() + 180_000;
      while (
        !client.frames.some((f) => f.type === "run.ended") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(client.frames.some((f) => f.type === "run.ended")).toBe(true);

      const echo = client.frames.find(
        (f) =>
          f.type === "tool.ended" &&
          f.data.toolName === "mcp__fx__echo" &&
          outputOf(f).includes("echo:hello-wiring"),
      );
      expect(echo, "模型没有调用到 agent 勾选的 MCP 工具").toBeDefined();
      const read = client.frames.find(
        (f) =>
          f.type === "tool.ended" &&
          f.data.toolName === "read" &&
          outputOf(f).includes("PROBE-X9Z"),
      );
      expect(read, "模型没有读到 agent 勾选的 skill").toBeDefined();
    } finally {
      client.close();
    }
  },
  240_000,
);
