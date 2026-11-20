// 手动冒烟：真实模型，验证 PreToolUse hook 能拦下特定命令，且模型看得到拦截原因。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。
//
// 用法（密钥只从文件读取，不会打印）：
//   YUANSHU_LIVE=1 pnpm --filter yuanshu-harness-server exec vitest run test/live/hooks.live.test.ts
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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-hook-")));
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

const MARK = "hook-smoke-created";
const REASON = "策略禁止创建 hook-smoke 文件";

test.skipIf(!enabled)(
  "PreToolUse hook 拦下命令，模型看到原因，审计有记录",
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
    // full 档：没被 hook 拦下的调用不会卡在审批上。
    await call("PUT", "/api/v1/defaults", { permissionTier: "full" });
    // 预设：全部内置工具 + 完全允许档，只留 hook 一个阻塞点
    const preset = await call("POST", "/api/v1/studio/presets", {
      kind: "agent",
      name: "live-hook",
      description: "live",
      capabilities: toolNames(() => true).map((name) => `tool:${name}`),
    });

    // 载荷从 stdin 来：命令里带标记就退出 2，原因写 stderr。
    const hook = await call("POST", "/api/v1/hooks", {
      name: "拦截 smoke",
      point: "PreToolUse",
      matcher: "bash",
      command: `grep -q ${MARK} && { echo '${REASON}' >&2; exit 2; }; exit 0`,
      timeoutSec: 10,
      enabled: true,
      directoryId: null,
    });

    const session = await call("POST", "/api/v1/sessions", {
      promptPresetId: preset.id,
    });
    const client = await TestClient.connect(
      `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text: `请只用 bash 工具执行 \`touch ${MARK}.txt\`。如果被拒绝，就把拒绝原因原文告诉我，不要换别的办法。`,
      });
      expect(ack.ok).toBe(true);
      const deadline = Date.now() + 150_000;
      while (
        !client.frames.some((f) => f.type === "run.ended") &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 200));
      expect(client.frames.some((f) => f.type === "run.ended")).toBe(true);

      const bash = client.frames.find(
        (f) => f.type === "tool.ended" && f.data.toolName === "bash",
      );
      expect(bash, "模型没有调用 bash").toBeDefined();
      expect(bash?.data.isError).toBe(true);
      // 模型收到的工具结果里带 hook 名和原因。
      expect(String(bash?.data.output)).toContain("拦截 smoke");
      expect(String(bash?.data.output)).toContain(REASON);
      expect(existsSync(path.join(start, `${MARK}.txt`))).toBe(false);

      // 模型看见了原因并转述给用户。
      const said = client.frames
        .filter((f) => f.type === "message.delta" && f.data.kind === "text")
        .map((f) => String(f.data.text))
        .join("");
      expect(said).toContain("hook-smoke");
    } finally {
      client.close();
    }

    const audit = await call("GET", "/api/v1/audit?kind=hook&limit=50");
    const rec = audit.entries.find(
      (e: any) =>
        e.detail?.hookId === hook.id && e.detail?.result === "blocked",
    );
    expect(rec, "审计里没有 blocked 记录").toBeDefined();
  },
  240_000,
);
