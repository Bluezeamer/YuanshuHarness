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

// 已装载（常驻内存）的会话改模型 / 思考档位，下一条消息就要用新的；运行中改的等本轮结束再换。
// 真实服务 + 真实会话工厂 + OpenAI 兼容 stub。
const stub = await startStub((n) => `reply-${n}`);

let root = "";
let server: YuanshuServer;
let http = "";
let providerId = "";

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

const spec = (id: string, reasoning = false) => ({
  id,
  name: id,
  reasoning,
  levels: reasoning ? ["low", "high"] : [],
  input: ["text"],
  ctx: 32000,
  out: 4096,
  source: "manual",
});

// 同一个数据目录可以反复起（模拟重启）
async function boot() {
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
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-modelsw-")));
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
  await boot();
  const p = await ok("POST", "/api/v1/providers", {
    name: "切换 stub",
    slug: "switch-stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "switch-key",
    models: [spec("m-a"), spec("m-b"), spec("m-think", true)],
  });
  providerId = p.id;
  await ok("PUT", "/api/v1/default-model", {
    provider: providerId,
    model: "m-a",
  });
}, 30_000);

afterAll(async () => {
  await server?.stop();
  rmSync(root, { recursive: true, force: true });
});

// 同一个 WebSocket 连接上发一条消息、等这一轮结束，返回 stub 最近一次收到的请求
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
    expect(stub.requests.length).toBeGreaterThan(before);
    // run.ended 之后仍可能跟着 run.failed（流结束后的收尾出错），这一轮才算真的成功
    expect(client.frames.some((f) => f.type === "run.failed")).toBe(false);
    return stub.requests.at(-1) as (typeof stub.requests)[number];
  } finally {
    client.close();
  }
}

const choose = async (sessionId: string, model: string, reasoning = "off") => {
  const cfg = await ok("GET", `/api/v1/sessions/${sessionId}/config`);
  return call("PATCH", `/api/v1/sessions/${sessionId}/config`, {
    baseRev: cfg.rev,
    patch: {
      model: { mode: "explicit", provider: providerId, model, reasoning },
    },
  });
};

test("常驻的空闲会话改模型：立即生效，下一条消息用新模型，之前的对话还在", async () => {
  const s = await ok("POST", "/api/v1/sessions", {});
  expect((await say(s.id, "第一句")).body.model).toBe("m-a");

  const r = await choose(s.id, "m-b");
  expect(r.status).toBe(200);
  expect(r.body.appliedAt).toBe("now");

  const req = await say(s.id, "第二句");
  expect(req.body.model).toBe("m-b");
  // 同一个会话：历史没丢，新请求里仍带着第一句
  expect(JSON.stringify(req.body.messages)).toContain("第一句");

  // 再切回去
  expect((await choose(s.id, "m-a")).body.appliedAt).toBe("now");
  expect((await say(s.id, "第三句")).body.model).toBe("m-a");
});

test("运行中改模型：这一轮不受影响，回 next-run，本轮结束后自动换，下一条消息用新模型", async () => {
  const s = await ok("POST", "/api/v1/sessions", {});
  await say(s.id, "先装载");
  stub.mode.delayMs = 400;
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${s.id}/stream`,
  );
  try {
    const before = stub.requests.length;
    expect((await client.command("send_message", { text: "慢一点" })).ok).toBe(
      true,
    );
    await waitFor(() => stub.requests.length > before, "请求到达 stub");
    const r = await choose(s.id, "m-b");
    expect(r.body.appliedAt).toBe("next-run");
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    // 正在跑的这一轮用的还是旧模型
    expect(stub.requests.at(-1)?.body.model).toBe("m-a");
  } finally {
    client.close();
    stub.mode.delayMs = 0;
  }
  expect((await say(s.id, "下一句")).body.model).toBe("m-b");
});

test("只改思考档位（同一个模型）也立即生效", async () => {
  const s = await ok("POST", "/api/v1/sessions", {});
  expect((await choose(s.id, "m-think", "low")).status).toBe(200);
  expect((await say(s.id, "低档")).body.reasoning_effort).toBe("low");

  const r = await choose(s.id, "m-think", "high");
  expect(r.body.appliedAt).toBe("now");
  expect((await say(s.id, "高档")).body.reasoning_effort).toBe("high");
});

test("未装载的会话（重启后）改模型：直接落库，装载时读到新的", async () => {
  const s = await ok("POST", "/api/v1/sessions", {});
  await say(s.id, "先聊一句让它落盘");
  await server.stop();
  await boot();
  const r = await choose(s.id, "m-b");
  expect(r.body.appliedAt).toBe("now");
  expect((await say(s.id, "重启后")).body.model).toBe("m-b");
});

test("切到旧登记里的模型（不在共用 runtime）：回 next-run，当前会话不受影响，不报错", async () => {
  const legacy = await ok("POST", "/api/v1/models", {
    name: "旧登记",
    api: "openai-completions",
    baseUrl: stub.url,
    modelId: "legacy-x",
    reasoning: false,
    apiKey: "legacy-key",
  });
  const s = await ok("POST", "/api/v1/sessions", {});
  expect((await say(s.id, "先装载")).body.model).toBe("m-a");
  const cfg = await ok("GET", `/api/v1/sessions/${s.id}/config`);
  const r = await call("PATCH", `/api/v1/sessions/${s.id}/config`, {
    baseRev: cfg.rev,
    patch: {
      model: {
        mode: "explicit",
        provider: legacy.id,
        model: "legacy-x",
        reasoning: "off",
      },
    },
  });
  expect(r.status).toBe(200);
  expect(r.body.appliedAt).toBe("next-run");
  expect((await say(s.id, "还是旧的")).body.model).toBe("m-a");
});

// AGENTS.md（会话配置里选的提示词卡片）要真的进系统提示词。
const systemText = (body: Record<string, unknown>) =>
  JSON.stringify((body.messages as unknown[])[0]);
const makeCard = async (name: string, content: string) =>
  (
    await ok("POST", "/api/v1/prompt/blocks", {
      title: name,
      body: content,
      group: "项目约定",
    })
  ).id as string;

test.skip("AGENTS.md：创建时选的卡片进系统提示词", async () => {
  const card = await makeCard("创建时的约定", "MD-CREATE-7q1");
  const s = await ok("POST", "/api/v1/sessions", {
    config: { agentsMd: { mode: "card", blockId: card } },
  });
  expect(systemText((await say(s.id, "你好")).body)).toContain("MD-CREATE-7q1");
});

test.skip("AGENTS.md：空闲时改，立即进提示词；改回 none 就去掉", async () => {
  const card = await makeCard("空闲时改的约定", "MD-IDLE-4k2");
  const s = await ok("POST", "/api/v1/sessions", {});
  expect(systemText((await say(s.id, "先装载")).body)).not.toContain(
    "MD-IDLE-4k2",
  );
  const patchMd = async (agentsMd: unknown) => {
    const cfg = await ok("GET", `/api/v1/sessions/${s.id}/config`);
    return call("PATCH", `/api/v1/sessions/${s.id}/config`, {
      baseRev: cfg.rev,
      patch: { agentsMd },
    });
  };
  const r = await patchMd({ mode: "chain", blockIds: [card] });
  expect(r.body.appliedAt).toBe("now");
  expect(systemText((await say(s.id, "再来")).body)).toContain("MD-IDLE-4k2");
  expect((await patchMd({ mode: "none" })).body.appliedAt).toBe("now");
  expect(systemText((await say(s.id, "去掉")).body)).not.toContain(
    "MD-IDLE-4k2",
  );
});

test.skip("AGENTS.md：运行中改，本轮结束后补上，下一条消息就带着", async () => {
  const card = await makeCard("运行中改的约定", "MD-BUSY-9z3");
  const s = await ok("POST", "/api/v1/sessions", {});
  await say(s.id, "先装载");
  stub.mode.delayMs = 400;
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${s.id}/stream`,
  );
  try {
    const before = stub.requests.length;
    expect((await client.command("send_message", { text: "慢一点" })).ok).toBe(
      true,
    );
    await waitFor(() => stub.requests.length > before, "请求到达 stub");
    const cfg = await ok("GET", `/api/v1/sessions/${s.id}/config`);
    const r = await call("PATCH", `/api/v1/sessions/${s.id}/config`, {
      baseRev: cfg.rev,
      patch: { agentsMd: { mode: "card", blockId: card } },
    });
    expect(r.body.appliedAt).toBe("next-run");
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    expect(systemText(stub.requests.at(-1)?.body ?? {})).not.toContain(
      "MD-BUSY-9z3",
    );
  } finally {
    client.close();
    stub.mode.delayMs = 0;
  }
  expect(systemText((await say(s.id, "下一句")).body)).toContain("MD-BUSY-9z3");
});
