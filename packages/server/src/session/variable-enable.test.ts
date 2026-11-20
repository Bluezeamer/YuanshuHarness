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

// 变量只在会话所属工作区启用了才可见（默认全不开）。同一条命令里两个变量：
// 启用的被替换并记 ok 引用，没启用的原样留着（等于没登记）并留一条 unknown 引用记录；
// 之后把第二个也启用，下一回合它也随即可用（每次现查，不缓存）。
// 真实服务 + 真实会话工厂 + stub 模型（让它调 bash）。
const ENABLED_VAL = "ENABLED-VALUE-aaaa1111";
const HELD_VAL = "HELD-VALUE-bbbb2222";
const CMD = "echo A={{@enabled.var}} B={{@held.var}}";

const stub = await startStub((_n, body) => {
  const msgs = (body.messages ?? []) as { role: string }[];
  return msgs.at(-1)?.role === "tool"
    ? "done"
    : { tool: "bash", args: { command: CMD } };
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

let enabledId = "";
let heldId = "";

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-varenable-")));
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
  // 完全允许档：本测试只关心替换，不想被审批卡住
  await call("PUT", "/api/v1/defaults", { permissionTier: "full" });
  const enabled = await call("POST", "/api/v1/variables", {
    name: "enabled.var",
    desc: "启用的变量",
    value: ENABLED_VAL,
  });
  const held = await call("POST", "/api/v1/variables", {
    name: "held.var",
    desc: "还没启用的变量",
    value: HELD_VAL,
  });
  enabledId = enabled.id;
  heldId = held.id;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

// 跑一回合，返回工具输出与这一回合的请求体。
async function runTurn(client: TestClient) {
  const before = client.frames.length;
  stub.requests.length = 0;
  expect((await client.command("send_message", { text: "go" })).ok).toBe(true);
  await waitFor(
    () => client.frames.slice(before).some((f) => f.type === "run.ended"),
    "run.ended",
    30_000,
  );
  const ended = client.frames
    .slice(before)
    .filter((f) => f.type === "tool.ended")
    .at(-1);
  return {
    output: String(ended?.data.output ?? ""),
    firstRequest: JSON.stringify(stub.requests[0]?.body),
  };
}

test("工作区启用的变量被替换，没启用的不替换、不进上下文清单，并留 unknown 记录；启用后下一回合也替换", async () => {
  const session = await call("POST", "/api/v1/sessions", {});
  const workspaceId = session.workspaceId as string;
  expect(workspaceId).toBeTruthy();
  await call("PUT", `/api/v1/workspaces/${workspaceId}/variables`, {
    variables: [enabledId],
  });

  const client = await TestClient.connect(
    `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
  );
  try {
    const first = await runTurn(client);
    // 真值经输出遮罩换回占位符，所以看不到明文；启用的显示成占位符，没启用的原样留着
    expect(first.output).not.toContain(ENABLED_VAL);
    expect(first.output).not.toContain(HELD_VAL);
    expect(first.output).toContain("A={{@enabled.var}}");
    expect(first.output).not.toContain("A=@enabled.var");
    expect(first.output).toContain("B={{@held.var}}");
    // 上下文清单只列启用的那个
    expect(first.firstRequest).toContain("{{@enabled.var}}");
    expect(first.firstRequest).not.toContain("held.var");
    // 真值都没有进过模型请求
    expect(JSON.stringify(stub.requests.map((r) => r.body))).not.toContain(
      HELD_VAL,
    );

    const refs = (await call("GET", "/api/v1/references")).references as Array<{
      name: string;
      result: string;
    }>;
    expect(refs.find((r) => r.name === "enabled.var")?.result).toBe("ok");
    expect(refs.find((r) => r.name === "held.var")?.result).toBe("unknown");

    // 启用第二个变量：下一回合它也被替换，不再留 unknown
    await call("PUT", `/api/v1/workspaces/${workspaceId}/variables`, {
      variables: [enabledId, heldId],
    });
    const second = await runTurn(client);
    expect(second.output).toContain("A={{@enabled.var}}");
    expect(second.output).toContain("B={{@held.var}}");
    expect(second.output).not.toContain(HELD_VAL);
    expect(JSON.stringify(stub.requests.map((r) => r.body))).not.toContain(
      HELD_VAL,
    );
    const after = (await call("GET", "/api/v1/references"))
      .references as Array<{
      name: string;
      result: string;
    }>;
    expect(after.some((r) => r.name === "held.var" && r.result === "ok")).toBe(
      true,
    );
  } finally {
    client.close();
  }
}, 90_000);
