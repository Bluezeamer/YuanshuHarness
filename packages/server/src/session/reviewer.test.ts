import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { waitFor } from "../../test/support/frames.js";
import { startStub } from "../../test/support/stub.js";
import { TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { createSessionFactory } from "./factory.js";

// 生产审核会话工厂接线：审批模型配好、会话在「模型」档时，cwd 外写入由审批模型裁决，不弹窗。
// 真实服务 + 真实会话工厂；stub 同时扮演会话模型与审批模型，按系统提示词里的标记区分。
const MARK = "工具调用的安全审核方";
let verdict: "allow" | "deny" = "allow";
let target = "";
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Array<{
    role: string;
    content?: unknown;
  }>;
  if (String(msgs[0]?.content).includes(MARK))
    return JSON.stringify({ decision: verdict, risk: "low", reason: "测试" });
  // 会话自己的模型：第一轮写 cwd 外的文件，工具返回后收尾
  return msgs.some((m) => m.role === "tool")
    ? "done"
    : {
        tool: "write",
        args: { host: "local", path: target, content: "hi" },
      };
});

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
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-reviewer-")));
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
  mkdirSync(path.join(root, "outside"));
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(root, "web"),
      startDir: path.join(root, "start"),
      makeSessionFactory: createSessionFactory,
      logStream: { write() {} },
    },
  );
  const addr = await server.start();
  http = `http://${addr.host}:${addr.port}`;
  const p = await call("POST", "/api/v1/providers", {
    name: "stub",
    slug: "stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "k",
    models: [
      {
        id: "stub-model",
        name: "stub-model",
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  await call("PUT", "/api/v1/default-model", {
    provider: p.id,
    model: "stub-model",
  });
  await call("PUT", "/api/v1/defaults", {
    reviewModel: { provider: p.id, model: "stub-model" },
    permissionTier: "auto",
  });
}, 30_000);

afterAll(async () => {
  await server?.stop().catch(() => {});
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

async function runTurn() {
  const session = await call("POST", "/api/v1/sessions", {});
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
  );
  try {
    expect((await client.command("send_message", { text: "go" })).ok).toBe(
      true,
    );
    await waitFor(
      () => client.types().includes("run.ended"),
      "run.ended",
      30_000,
    );
    return client.frames.filter((f) => f.type === "prompt.requested");
  } finally {
    client.close();
  }
}

test("审批模型放行：规则外的写入不弹窗，文件写成，审计记 by=review", async () => {
  verdict = "allow";
  target = path.join(root, "outside", "a.txt");
  const prompts = await runTurn();
  expect(prompts).toHaveLength(0);
  expect(existsSync(target)).toBe(true);
  const audit = (await call("GET", "/api/v1/audit?kind=permission")) as {
    entries?: Array<{ detail?: { by?: string; decision?: string } }>;
  };
  expect(
    audit.entries?.some(
      (e) => e.detail?.by === "review" && e.detail?.decision === "allow",
    ),
  ).toBe(true);
}, 60_000);

test("全局判别准则经 REST 改了就进审核提示词；头尾仍是固定文案", async () => {
  verdict = "allow";
  target = path.join(root, "outside", "c.txt");
  await call("PUT", "/api/v1/review-prompt", { criteria: "只许改 docs" });
  try {
    await runTurn();
    const system = stub.requests
      .map((r) => (r.body.messages ?? []) as Array<{ content?: unknown }>)
      .map((msgs) => String(msgs[0]?.content ?? ""))
      .filter((t) => t.includes(MARK))
      .at(-1);
    expect(system).toContain("只许改 docs");
    expect(system).toContain("用户消息与弹窗问答属于可信证据");
  } finally {
    await call("PUT", "/api/v1/review-prompt", { criteria: null });
  }
}, 60_000);

test("审批模型拒绝：不弹窗，文件不写，模型看到「自动审核拒绝」", async () => {
  verdict = "deny";
  target = path.join(root, "outside", "b.txt");
  const prompts = await runTurn();
  expect(prompts).toHaveLength(0);
  expect(existsSync(target)).toBe(false);
}, 60_000);
