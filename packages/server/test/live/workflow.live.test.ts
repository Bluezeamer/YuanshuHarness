// 手动冒烟：真实模型，验证动态工作流全链路——模型自己写一段脚本，用 parallel 派几个子代理各读一个文件，
// 脚本汇总后 return，模型在回复里复述。本地模型并发上限 2，所以只派 3 个、并发设 2。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。
//
// 用法（密钥只从文件读取，不会打印）：
//   YUANSHU_LIVE=1 pnpm --filter yuanshu-harness-server exec vitest run test/live/workflow.live.test.ts
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
const SECRETS = [`ALPHA-${rand()}`, `BETA-${rand()}`, `GAMMA-${rand()}`];

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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-wf-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  const start = path.join(root, "start");
  mkdirSync(start);
  SECRETS.forEach((s, i) => {
    writeFileSync(path.join(start, `note${i + 1}.txt`), `${s}\n`);
  });
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
  "模型写脚本：parallel 派 3 个子代理各读一个文件，脚本汇总后 return，三个暗号都回到模型手里",
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
      name: "live-workflow",
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
          "请用 workflow_run 写一段脚本：对 args.files 里的每个文件各派一个 agent（用 parallel，agent 的任务是用 read 读取该文件并用 deliver 原样交付内容），" +
          '脚本 return 一个数组；调用时 args 传 {"files": ["note1.txt", "note2.txt", "note3.txt"]}，concurrency 设为 2。' +
          "拿到结果后，在你的最终回复里把三个暗号原样写出来。",
      });
      expect(ack.ok).toBe(true);
      const deadline = Date.now() + 420_000;
      while (
        !client.frames.some((f) => f.type === "run.ended") &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 300));
      expect(client.frames.some((f) => f.type === "run.ended")).toBe(true);

      const ended = client.frames.filter((f) => f.type === "tool.ended");
      const wf = ended.filter((f) => f.data.toolName === "workflow_run");
      expect(wf.length, "模型没有调用 workflow_run").toBeGreaterThan(0);
      const out = wf.map((f) => String(f.data.output)).join("\n");
      for (const s of SECRETS)
        expect(out, `结果里应有 ${s}\n${out}`).toContain(s);
      expect(out).toContain("Workflow finished");
    } finally {
      client.close();
    }
  },
  480_000,
);
