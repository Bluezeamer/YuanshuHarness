import {
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

// 自定义端点的「协议兼容」与「鉴权头」要真的进到发给上游的请求里，而不只是存进库。
// 真实服务 + 真实会话工厂 + OpenAI 兼容 stub，从 stub 收到的请求头 / 请求体里看。
// 每个场景一个独立的供应商（模型清单同名也互不干扰）。
const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as { role: string }[];
  // 每个会话的第一轮：先吐一段思考再给答案；之后只回文本
  return msgs.some((m) => m.role === "assistant")
    ? "answer-2"
    : { reasoning: "pondering", text: "answer-1" };
});

let root = "";
let server: YuanshuServer;
let http = "";
let seq = 0;

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${http}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const ok = async (method: string, url: string, body?: unknown) => {
  const r = await call(method, url, body);
  if (r.status >= 300)
    throw new Error(
      `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`,
    );
  return r.body;
};

// 带思考能力的模型：档位 off / low / high
const THINKER = {
  id: "thinker",
  name: "thinker",
  reasoning: true,
  levels: ["off", "low", "high"],
  input: ["text"],
  ctx: 32000,
  out: 4096,
  source: "manual",
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-compat-")));
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
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
}, 30_000);

afterAll(async () => {
  await server?.stop();
  rmSync(root, { recursive: true, force: true });
});

// 登记一个指向 stub 的自定义供应商，新建一个显式用它的会话
async function open(extra: Record<string, unknown>, reasoning = "off") {
  seq += 1;
  const p = await ok("POST", "/api/v1/providers", {
    name: `compat ${seq}`,
    slug: `compat-${seq}`,
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "gw-key-1",
    models: [THINKER],
    ...extra,
  });
  const s = await ok("POST", "/api/v1/sessions", {
    config: {
      model: { mode: "explicit", provider: p.id, model: "thinker", reasoning },
    },
  });
  return { provider: p, sessionId: s.id as string };
}

// 在会话里发一条消息、等这一轮结束，返回这一轮 stub 收到的请求
async function say(sessionId: string, text: string) {
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${sessionId}/stream`,
  );
  try {
    const before = stub.requests.length;
    expect((await client.command("send_message", { text })).ok).toBe(true);
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    expect(client.frames.filter((f) => f.type === "run.failed")).toEqual([]);
    expect(stub.requests.length).toBeGreaterThan(before);
    return stub.requests.at(-1) as (typeof stub.requests)[number];
  } finally {
    client.close();
  }
}

test("鉴权头：密钥按「头名」发出，协议默认的 Bearer 仍在", async () => {
  const { sessionId } = await open({ authHeader: "X-Gw-Key" });
  const req = await say(sessionId, "hi");
  expect(req.headers["x-gw-key"]).toBe("gw-key-1");
  expect(req.headers.authorization).toBe("Bearer gw-key-1");
});

test("鉴权头带前缀：同名取代协议默认头，密钥拼在前缀后", async () => {
  const { sessionId } = await open({ authHeader: "Authorization: Token" });
  const req = await say(sessionId, "hi");
  expect(req.headers.authorization).toBe("Token gw-key-1");
});

test("鉴权头：密钥里的 $ 和开头的 ! 原样发出，不被当成变量或命令", async () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 故意用 pi 配置语法里的变量引用与命令前缀
  const key = "!echo pwned $HOME ${PATH} $$";
  const { sessionId } = await open({
    authHeader: "X-Gw-Key",
    apiKey: key,
  });
  const req = await say(sessionId, "hi");
  expect(req.headers["x-gw-key"]).toBe(key);
});

test("没有填鉴权头：只有协议默认的 Bearer", async () => {
  const { sessionId } = await open({});
  const req = await say(sessionId, "hi");
  expect(req.headers.authorization).toBe("Bearer gw-key-1");
  expect(req.headers["x-gw-key"]).toBeUndefined();
});

test("reasoning_effort：自动时随思考档位发出，显式关掉后请求里没有", async () => {
  const auto = await open({}, "high");
  expect((await say(auto.sessionId, "hi")).body.reasoning_effort).toBe("high");

  const off = await open(
    { compat: { supportsReasoningEffort: false } },
    "high",
  );
  const req = await say(off.sessionId, "hi");
  expect(req.body).not.toHaveProperty("reasoning_effort");

  // 显式开：与自动一致（对本地地址自动推断本来就是开）
  const on = await open({ compat: { supportsReasoningEffort: true } }, "low");
  expect((await say(on.sessionId, "hi")).body.reasoning_effort).toBe("low");
});

test("thinkingFormat：qwen 写法带 enable_thinking，自动时没有", async () => {
  const auto = await open({}, "high");
  expect(await say(auto.sessionId, "hi")).toMatchObject({
    body: { reasoning_effort: "high" },
  });
  expect((await say(auto.sessionId, "again")).body).not.toHaveProperty(
    "enable_thinking",
  );

  const qwen = await open({ compat: { thinkingFormat: "qwen" } }, "high");
  expect((await say(qwen.sessionId, "hi")).body.enable_thinking).toBe(true);
});

test("思考转文本：下一轮把上一轮的思考块并进 assistant 文本；不开则走 reasoning_content", async () => {
  const assistantOf = (r: { body: Record<string, unknown> }) =>
    (
      r.body.messages as {
        role: string;
        content: unknown;
        reasoning_content?: string;
      }[]
    ).find((m) => m.role === "assistant");

  const plain = await open({}, "high");
  await say(plain.sessionId, "first");
  const a = assistantOf(await say(plain.sessionId, "second"));
  expect(a?.content).toBe("answer-1");
  expect(a?.reasoning_content).toBe("pondering");

  const asText = await open(
    { compat: { requiresThinkingAsText: true } },
    "high",
  );
  await say(asText.sessionId, "first");
  const b = assistantOf(await say(asText.sessionId, "second"));
  expect(b?.content).toEqual([
    { type: "text", text: "pondering" },
    { type: "text", text: "answer-1" },
  ]);
  expect(b).not.toHaveProperty("reasoning_content");
});
