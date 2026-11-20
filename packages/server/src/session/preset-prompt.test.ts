// 验收：创建会话时选哪张 agent 预设，实际请求的 system prompt 就来自哪张。
// 真实服务 + 真实会话工厂 + OpenAI 兼容 stub。
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
  root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "yuanshu-preset-prompt-")),
  );
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "data"),
      // 不读开发机真实的 ~/.ys/AGENTS.md
      ysHome: path.join(root, "ys"),
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
  const p = await ok("POST", "/api/v1/providers", {
    name: "预设 stub",
    slug: "preset-stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "preset-key",
    models: [spec("m-a")],
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

/** 发一条消息，返回 stub 收到的最后一个请求体 */
async function sayAndGetBody(sessionId: string) {
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${sessionId}/stream`,
  );
  try {
    const before = stub.requests.length;
    expect(
      (await client.command("send_message", { text: "只回复 ok" })).ok,
    ).toBe(true);
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    expect(stub.requests.length).toBeGreaterThan(before);
    const req = stub.requests.at(-1) as unknown as {
      body: Record<string, unknown>;
    };
    return req.body;
  } finally {
    client.close();
  }
}

/** 发一条消息，返回 stub 收到的最后一个请求的 system 文本 */
async function sayAndGetSystem(sessionId: string) {
  const body = await sayAndGetBody(sessionId);
  const messages = body.messages as { role: string; content: unknown }[];
  const sys = messages.find((m) => m.role === "system");
  return typeof sys?.content === "string"
    ? sys.content
    : JSON.stringify(sys?.content ?? "");
}

test("选 page-reader 预设：system prompt 来自它，而不是默认预设", async () => {
  const presets = (await ok("GET", "/api/v1/studio/presets?kind=agent"))
    .presets as { id: string; name: string }[];
  const reader = presets.find((p) => p.name === "page-reader");
  expect(reader).toBeTruthy();
  expect(presets[0]?.name).toBe("coder-full");

  const s = await ok("POST", "/api/v1/sessions", {
    promptPresetId: reader?.id,
  });
  const sys = await sayAndGetSystem(s.id);
  // page-reader 的 identity 是页面阅读 agent，不含 pi 原生身份，也没有自己的段名
  expect(sys).toContain("You are the page reader");
  expect(sys).not.toContain("You are an expert coding assistant");
  expect(sys).not.toContain("<docs>");
});

test("不选预设时用默认预设（coder-full，含 pi 原生身份）", async () => {
  const s = await ok("POST", "/api/v1/sessions", {});
  const sys = await sayAndGetSystem(s.id);
  expect(sys).toContain("You are an expert coding assistant");
  expect(sys).toContain("<tools-rules>");
});

test("工具页改过的描述进入 request.tools", async () => {
  const desc = "读文件（调优后的描述）";
  await ok("PUT", "/api/v1/studio/tool-descriptions/read", {
    description: desc,
  });
  const s = await ok("POST", "/api/v1/sessions", {});
  const body = await sayAndGetBody(s.id);
  const tools = body.tools as {
    type: string;
    function: { name: string; description: string };
  }[];
  const read = tools.find((t) => t.function?.name === "read");
  expect(read?.function.description).toBe(desc);
  // 没覆盖的工具保持原样
  const write = tools.find((t) => t.function?.name === "write");
  expect(write?.function.description).toBeTruthy();
  expect(write?.function.description).not.toBe(desc);
});

test("调优页的原文是会话里实际注册的工具描述（英文原文），不受覆盖影响", async () => {
  await ok("PUT", "/api/v1/studio/tool-descriptions/read", {
    description: "读文件（调优后的描述）",
  });
  const s = await ok("POST", "/api/v1/sessions", {});
  const body = await sayAndGetBody(s.id);
  const sent = (
    body.tools as { function: { name: string; description: string } }[]
  ).find((t) => t.function?.name === "write");
  const got = await ok("GET", "/api/v1/studio/tool-descriptions");
  // 没覆盖的工具：原文就是模型收到的那份
  expect(got.originals.write).toBe(sent?.function.description);
  // 覆盖过的工具：原文仍是 pi 的英文描述，不是覆盖后的
  expect(got.originals.read).toContain("Read the contents of a file");
  expect(got.originals.read).not.toContain("调优后");
  // 只记我们目录里的内置工具，MCP 等不进来
  expect(Object.keys(got.originals).every((n) => !n.startsWith("mcp__"))).toBe(
    true,
  );
}, 60_000);
