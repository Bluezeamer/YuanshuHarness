import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { createSessionFactory } from "../session/factory.js";

// 真实服务 + 真实会话工厂：team_* 与 post 经 pi 注册、成员无人值守也能用 post / deliver，
// team_status 的板子摘要走辅助模型（没配就用会话自己的模型）。stub 按请求内容扮演 lead、成员与辅助调用。
type Msg = { role: string; content?: unknown };
const plain = (c: unknown): string =>
  Array.isArray(c)
    ? c.map((p) => (p as { text?: string }).text ?? "").join("")
    : String(c ?? "");

const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as Msg[];
  const system = plain(msgs[0]?.content);
  if (system.includes("condense the bulletin board"))
    return `SUMMARY via ${String(body.model)}`;
  const isMember = msgs.some(
    (m) =>
      m.role === "user" &&
      plain(m.content).includes("You are a member of a team of agents"),
  );
  const last = msgs.at(-1);
  if (isMember) {
    // 先发一条公告，再交付，最后收尾
    const results = msgs.filter((m) => m.role === "tool").length;
    if (results === 0) return { tool: "post", args: { text: "started A" } };
    if (results === 1)
      return { tool: "deliver", args: { summary: "alpha-done" } };
    return "done";
  }
  // lead：建队 → 收到成员交付的回调后看一眼 team_status → 收尾
  // 回调后面可能还跟着状态通知，所以看上一条助手回复之后的全部消息
  const lastAssistant = msgs.map((m) => m.role).lastIndexOf("assistant");
  const fresh = msgs
    .slice(lastAssistant + 1)
    .map((m) => plain(m.content))
    .join("\n");
  if (fresh.includes("[Team member alpha delivered]"))
    return { tool: "team_status", args: {} };
  if (last?.role === "tool") return "ok";
  return {
    tool: "team_create",
    args: { members: [{ name: "alpha", task: "write A" }] },
  };
});

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
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
};

const model = (id: string) => ({
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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-team-")));
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
  const p = await call("POST", "/api/v1/providers", {
    name: "stub",
    slug: "stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "k",
    models: [model("stub-model"), model("aux-model")],
  });
  providerId = p.id;
  await call("PUT", "/api/v1/default-model", {
    provider: providerId,
    model: "stub-model",
  });
}, 30_000);

afterAll(async () => {
  await server?.stop().catch(() => {});
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

// 开一个会话让模型建队，等到 team_status 的结果回到模型手里；返回会话 id 与摘要那次请求用的模型
async function runTeam() {
  stub.requests.length = 0;
  const session = await call("POST", "/api/v1/sessions", {});
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
  );
  try {
    expect((await client.command("send_message", { text: "go" })).ok).toBe(
      true,
    );
    await waitFor(
      () =>
        stub.requests.some((r) =>
          JSON.stringify(r.body).includes("SUMMARY via"),
        ),
      "team_status 的摘要回到模型手里",
      60_000,
    );
    const aux = stub.requests.find((r) =>
      plain((r.body.messages as Msg[])[0]?.content).includes(
        "condense the bulletin board",
      ),
    );
    return { id: session.id as string, auxModel: String(aux?.body.model) };
  } finally {
    client.close();
  }
}

test("没配辅助模型：建队、成员用 post 与 deliver、板子摘要用会话自己的模型", async () => {
  const { id, auxModel } = await runTeam();
  expect(auxModel).toBe("stub-model");
  const board = readFileSync(
    path.join(root, "data", "collab", id, "board.md"),
    "utf8",
  );
  expect(board).toContain("Task for alpha");
  expect(board).toMatch(/· alpha → all\nstarted A/);
  expect(board).toMatch(/· alpha → all\nDelivered: alpha-done/);
  // 摘要出现在 team_status 的结果里
  const status = stub.requests
    .flatMap((r) => (r.body.messages ?? []) as Msg[])
    .map((m) => plain(m.content))
    .find((t) => t.includes("Members:\n- alpha"));
  expect(status).toContain("delivered: alpha-done");
  expect(status).toContain("SUMMARY via stub-model");
}, 90_000);

test("配了辅助模型：摘要改用它；设置的校验与清除", async () => {
  const bad = await fetch(`${http}/api/v1/defaults`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auxModel: { provider: providerId, model: "nope" } }),
  });
  expect(bad.status).toBe(404);
  const put = await call("PUT", "/api/v1/defaults", {
    auxModel: { provider: providerId, model: "aux-model" },
  });
  expect(put.auxModel).toEqual({
    provider: providerId,
    model: "aux-model",
    thinking: null,
  });
  const { auxModel } = await runTeam();
  expect(auxModel).toBe("aux-model");
  const cleared = await call("PUT", "/api/v1/defaults", { auxModel: null });
  expect(cleared.auxModel).toBeNull();
}, 90_000);
