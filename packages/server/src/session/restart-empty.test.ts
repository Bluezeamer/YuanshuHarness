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
import { findSessionFile } from "../store/sessions.js";
import { createSessionFactory } from "./factory.js";

// 会话库里的会话从创建起就要持久：没发过消息的会话，Server 重启后标题、配置、分组都还在，也还能接着聊。
// （pi 默认等到第一条用户消息才写文件，之前这类会话重启后整个消失。）真实服务 + 真实会话工厂 + stub 模型。
const stub = await startStub((n) => `reply-${n}`);

let root = "";
let dataDir = "";
let server: YuanshuServer | null = null;
let http = "";

async function boot() {
  server = createServer(
    { host: "127.0.0.1", port: 0, dataDir, allowCidrs: [] },
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
async function shutdown() {
  await server?.stop();
  server = null;
}

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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-restart-")));
  dataDir = path.join(root, "data");
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  mkdirSync(path.join(root, "start"));
  await boot();
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
}, 30_000);

afterAll(async () => {
  await shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("没发过消息的会话：创建时就落盘，重启后还在，标题与配置都在，还能接着聊", async () => {
  // 与界面一致：先建会话，再用 PATCH 写标题
  const created = await call("POST", "/api/v1/sessions", {});
  const id = created.id as string;
  await call("PATCH", `/api/v1/sessions/${id}`, { title: "重启前没发过消息" });

  // 创建时就有文件，里面只有会话头；文件在所属工作区的子目录里
  const root = path.join(dataDir, "sessions");
  const file = findSessionFile(root, id);
  expect(file).not.toBeNull();
  expect(path.dirname(file as string)).not.toBe(root);
  const lines = readFileSync(file as string, "utf8")
    .trim()
    .split("\n");
  expect(JSON.parse(lines[0] as string)).toMatchObject({
    type: "session",
    id,
  });

  const cfgBefore = await call("GET", `/api/v1/sessions/${id}/config`);
  await shutdown();
  await boot();

  const list = (await call("GET", "/api/v1/sessions")).sessions as Array<{
    id: string;
    title: string;
  }>;
  expect(list.find((s) => s.id === id)?.title).toBe("重启前没发过消息");
  const cfgAfter = await call("GET", `/api/v1/sessions/${id}/config`);
  expect(cfgAfter.rev).toBe(cfgBefore.rev);

  // 重启后装载的是只有会话头的文件，照样能发消息、拿到回复
  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${id}/stream`,
  );
  try {
    const before = stub.requests.length;
    const ack = await client.command("send_message", { text: "重启后第一句" });
    expect(ack.ok).toBe(true);
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    expect(stub.requests.length).toBeGreaterThan(before);
  } finally {
    client.close();
  }
}, 60_000);
