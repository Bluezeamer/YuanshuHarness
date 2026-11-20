// 手动冒烟：真实模型，验证团队全链路——lead 建队，两个成员各读一个文件、在公告板上发一句、再交付，
// 交付分别回调 lead，公告板上有双方的署名条目。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。本地模型并发上限 2，所以只建两个成员。
//
// 用法（密钥只从文件读取，不会打印）：
//   YUANSHU_LIVE=1 pnpm --filter yuanshu-harness-server exec vitest run test/live/team.live.test.ts
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
const provider = existsSync(MODEL_FILE)
  ? Object.values<any>(
      JSON.parse(readFileSync(MODEL_FILE, "utf8")).providers,
    )[0]
  : undefined;
const model = provider?.models?.[0];
const enabled = Boolean(model?.id);

const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const SECRET_A = `APPLE-${rand()}`;
const SECRET_B = `PEAR-${rand()}`;

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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-team-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  start = path.join(root, "start");
  mkdirSync(start);
  writeFileSync(path.join(start, "a.txt"), `${SECRET_A}\n`);
  writeFileSync(path.join(start, "b.txt"), `${SECRET_B}\n`);
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
  "lead 建队，两个成员各自读文件、发公告、交付；公告板上有署名条目，lead 收到两份交付",
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
    await call("PUT", "/api/v1/defaults", { permissionTier: "full" });
    const preset = await call("POST", "/api/v1/studio/presets", {
      kind: "agent",
      name: "live-team",
      description: "live",
      capabilities: [
        ...toolNames(() => true).map((name) => `tool:${name}`),
        "unit:team",
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
          "请用 team_create 建一个两人团队，成员 alpha 与 beta。" +
          "alpha 的任务：用 read 读取当前目录的 a.txt；beta 的任务：用 read 读取当前目录的 b.txt（相对路径直接用文件名；写绝对路径必须带主机前缀，如 local:/…）。" +
          "两人都要先用 post 工具（不写 to）在公告板上发一句『started』，再用 deliver 把文件内容原样交付。" +
          "两份交付都到齐之后（它们会作为消息送到你这里），在你的最终回复里原样写出两个暗号。",
      });
      expect(ack.ok).toBe(true);
      const deadline = Date.now() + 360_000;
      const done = () => {
        const text = JSON.stringify(client.frames.map((f) => f.data));
        return text.includes(SECRET_A) && text.includes(SECRET_B);
      };
      while (
        !(client.frames.some((f) => f.type === "run.ended") && done()) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 300));

      const created = client.frames.find(
        (f) => f.type === "tool.ended" && f.data.toolName === "team_create",
      );
      expect(created, "模型没有调用 team_create").toBeDefined();
      expect(String(created?.data.output)).toContain("Team created");
      expect(done(), "lead 应收到两个暗号").toBe(true);
    } finally {
      client.close();
    }

    const board = readFileSync(
      path.join(root, "data", "collab", session.id, "board.md"),
      "utf8",
    );
    expect(board).toContain("Task for alpha");
    expect(board).toContain("Task for beta");
    expect(board).toMatch(/· alpha → all\nDelivered:/);
    expect(board).toMatch(/· beta → all\nDelivered:/);
    expect(board).toContain(SECRET_A);
    expect(board).toContain(SECRET_B);
    // 成员发的公告带框架加的署名标题
    expect(board).toMatch(/· (alpha|beta) → all\n(?!Delivered)\S/);
  },
  420_000,
);
