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

// 设置页里登记的供应商与模型，要能真的被会话用上：默认模型、会话里单独选的模型、旧登记的回落。
// 真实服务 + 真实会话工厂 + OpenAI 兼容 stub，不经过任何假工厂。
const stub = await startStub((n) => `reply-${n}`);

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

const spec = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  levels: [],
  input: ["text"],
  ctx: 32000,
  out: 4096,
  source: "manual",
});

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-provmodel-")));
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
  rmSync(root, { recursive: true, force: true });
});

// 发一条消息、等这一轮结束，返回 stub 最近一次收到的请求
async function say(sessionId: string, text: string) {
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${sessionId}/stream`,
  );
  try {
    const before = stub.requests.length;
    const ack = await client.command("send_message", { text });
    expect(ack.ok).toBe(true);
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    // 请求发出去了还不够：这一轮必须跑完（用量、成本结算失败也会是 run.failed）
    expect(client.frames.filter((f) => f.type === "run.failed")).toEqual([]);
    expect(stub.requests.length).toBeGreaterThan(before);
    return stub.requests.at(-1) as (typeof stub.requests)[number];
  } finally {
    client.close();
  }
}

test("什么都没配置时 GET 默认模型是 null，PUT 不存在的模型被拒", async () => {
  expect((await call("GET", "/api/v1/default-model")).body).toEqual({
    default: null,
  });
  const r = await call("PUT", "/api/v1/default-model", {
    provider: "nope",
    model: "x",
  });
  expect(r.status).toBe(404);
  expect(r.body.error).toBe("unknown_model");
});

test("自定义供应商里的模型设为全局默认后，会话用的就是它，并带上设置页里存的密钥", async () => {
  const p = await ok("POST", "/api/v1/providers", {
    name: "本地 stub",
    slug: "local-stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "provider-key-1",
    models: [spec("stub-a"), spec("stub-b")],
  });
  // 还没人设过默认：第一次配好供应商就能直接用（取第一个用户选入的模型）
  expect((await ok("GET", "/api/v1/default-model")).default).toMatchObject({
    provider: p.id,
    model: "stub-a",
  });
  const put = await call("PUT", "/api/v1/default-model", {
    provider: p.id,
    model: "stub-a",
  });
  expect(put.status).toBe(200);
  expect(put.body.default).toMatchObject({ provider: p.id, model: "stub-a" });

  const session = await ok("POST", "/api/v1/sessions", {});
  const req = await say(session.id, "你好");
  expect(req.body.model).toBe("stub-a");
  expect(String(req.headers.authorization)).toBe("Bearer provider-key-1");
});

test("会话创建时单独选了供应商里的另一个模型，请求用它而不是默认模型", async () => {
  const provider = (await ok("GET", "/api/v1/providers")).providers.find(
    (x: { custom: boolean }) => x.custom,
  );
  const session = await ok("POST", "/api/v1/sessions", {
    config: {
      model: {
        mode: "explicit",
        provider: provider.id,
        model: "stub-b",
        reasoning: "off",
      },
    },
  });
  const req = await say(session.id, "用另一个模型");
  expect(req.body.model).toBe("stub-b");
});

test("会话配置里选不存在的模型仍被拒（unknown_model）", async () => {
  const provider = (await ok("GET", "/api/v1/providers")).providers.find(
    (x: { custom: boolean }) => x.custom,
  );
  const session = await ok("POST", "/api/v1/sessions", {});
  const cfg = await ok("GET", `/api/v1/sessions/${session.id}/config`);
  const bad = await call("PATCH", `/api/v1/sessions/${session.id}/config`, {
    baseRev: cfg.rev,
    patch: {
      model: {
        mode: "explicit",
        provider: provider.id,
        model: "no-such-model",
        reasoning: "off",
      },
    },
  });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toBe("unknown_model");
});

test("内置供应商目录里没添加的模型也能登记为默认并建出会话；启动档位不合法被拒", async () => {
  // 目录模型没有被「添加」（视图里没有它）也能直接指定：模型解析不依赖视图
  const catalog = (
    await ok("GET", "/api/v1/providers/anthropic/catalog-models")
  ).models;
  const model = catalog[0].id as string;
  const put = await call("PUT", "/api/v1/default-model", {
    provider: "anthropic",
    model,
    thinking: "low",
  });
  expect(put.status).toBe(200);
  expect(put.body.default).toEqual({
    provider: "anthropic",
    model,
    thinking: "low",
  });
  // 创建会话会走工厂、用目录里的模型起运行时；不发消息，不会真的联网
  const session = await call("POST", "/api/v1/sessions", {});
  expect(session.status).toBe(201);

  const bad = await call("PUT", "/api/v1/default-model", {
    provider: "anthropic",
    model,
    thinking: "turbo",
  });
  expect(bad.status).toBe(400);
});

// 内置供应商：设置页里手加的、目录外的模型，以及对目录模型改的规格，都要真的进到请求里。
// 把内置的 deepseek（openai-completions）端点指到 stub，从 stub 收到的请求体里看。
async function builtinAt(models: unknown[]) {
  await ok("PATCH", "/api/v1/providers/deepseek", {
    baseUrl: stub.url,
    apiKey: "builtin-key-1",
    models,
  });
}
const bodyMax = (b: Record<string, unknown>) =>
  b.max_tokens ?? b.max_completion_tokens;

test("内置供应商里手加的目录外模型：设为默认后，会话用的就是它（不静默换成别的）", async () => {
  await builtinAt([{ ...spec("not-in-catalog-x"), source: "manual" }]);
  const put = await call("PUT", "/api/v1/default-model", {
    provider: "deepseek",
    model: "not-in-catalog-x",
  });
  expect(put.status).toBe(200);
  const session = await ok("POST", "/api/v1/sessions", {});
  const req = await say(session.id, "目录外的模型");
  expect(req.body.model).toBe("not-in-catalog-x");
  expect(String(req.headers.authorization)).toBe("Bearer builtin-key-1");
  // 没填的规格走合成默认，而不是借模板模型的数值
  expect(bodyMax(req.body)).toBe(4096);
});

test("内置供应商里对目录模型改的规格（输出上限）运行时生效", async () => {
  const cat = (await ok("GET", "/api/v1/providers/deepseek/catalog-models"))
    .models[0];
  await builtinAt([{ ...cat, out: 321, source: "manual" }]);
  await call("PUT", "/api/v1/default-model", {
    provider: "deepseek",
    model: cat.id,
  });
  const session = await ok("POST", "/api/v1/sessions", {});
  const req = await say(session.id, "改过规格的目录模型");
  expect(req.body.model).toBe(cat.id);
  expect(bodyMax(req.body)).toBe(321);
});
