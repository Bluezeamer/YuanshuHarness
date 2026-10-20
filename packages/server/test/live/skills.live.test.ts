// 手动冒烟：真实模型 + 真实 sshd，创建一个 skill、同步至 ssh 环境，会话里模型能发现并使用。
// 不进默认检查：缺少端点配置或本机没有 sshd 时跳过。
//
// 用法（端点信息经 /home/bluezeamer/projects/Yuanshu-harness/tmp/model 读取）：
//   pnpm --filter yuanshu-harness-server exec vitest run test/live/skills.live.test.ts
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
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../../src/server.js";
import { createSessionFactory } from "../../src/session/factory.js";
import type { Frame } from "../support/frames.js";
import { hasSshd, startSshd, type TestSshd } from "../support/sshd.js";
import { TestClient } from "../support/ws-client.js";

const MODEL_FILE = "/home/bluezeamer/projects/Yuanshu-harness/tmp/model";
const hasModelConfig = existsSync(MODEL_FILE);
const enabled = hasModelConfig && hasSshd;

let root = "";
let sshd: TestSshd;
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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-skills-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  const start = path.join(root, "start");
  mkdirSync(start);
  sshd = await startSshd();
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
  await sshd?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const outputOf = (f: Frame) => String(f.data.output ?? "");

test.skipIf(!enabled)(
  "创建 skill、分配、同步，模型在 ssh 环境里使用该 skill",
  async () => {
    const cfg = JSON.parse(readFileSync(MODEL_FILE, "utf8")) as {
      providers: Record<
        string,
        {
          baseUrl: string;
          api: string;
          apiKey?: string;
          models: { id: string }[];
        }
      >;
    };
    const [providerName, provider] = Object.entries(cfg.providers)[0] as [
      string,
      (typeof cfg.providers)[string],
    ];
    const modelId = (provider.models[0] as { id: string }).id;

    const model = await call("POST", "/api/v1/models", {
      name: providerName,
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId,
      reasoning: false,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
    await call("PATCH", `/api/v1/models/${model.id}`, { isDefault: true });

    const key = await call("POST", "/api/v1/secrets", {
      name: "k",
      kind: "ssh_key",
      value: sshd.privateKey,
    });
    const env = await call("POST", "/api/v1/environments", {
      name: "box",
      host: "127.0.0.1",
      port: sshd.port,
      username: sshd.user,
      secretId: key.id,
    });
    const remoteDir = path.join(root, "remote");
    mkdirSync(remoteDir);
    const ws = await call("POST", "/api/v1/workspaces", {
      path: remoteDir,
      environmentId: env.id,
    });
    await call("PATCH", `/api/v1/workspaces/${ws.id}`, { tier: "full" });

    const skill = await call("POST", "/api/v1/skills", {
      name: "probe",
      scope: "project",
      content:
        "---\nname: probe\n" +
        "description: 当用户询问暗号或 probe 时使用，给出本项目的暗号。\n---\n\n" +
        "# probe\n\n本项目的暗号是 PROBE-X9Z。回答用户时原样给出这个暗号。\n",
    });
    await call("PUT", `/api/v1/workspaces/${ws.id}/skills`, {
      names: [skill.name],
    });
    const synced = await call(
      "POST",
      `/api/v1/workspaces/${ws.id}/skills/sync`,
    );
    expect(synced.report.items[0]).toMatchObject({
      name: "probe",
      status: "added",
    });

    const session = await call("POST", "/api/v1/sessions", {
      workspaceId: ws.id,
    });

    const client = await TestClient.connect(
      `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text: "这个项目的暗号是什么？先看你可用的 skill，按需阅读后再回答，一句话即可。",
      });
      expect(ack.ok).toBe(true);

      const deadline = Date.now() + 180_000;
      while (
        !client.frames.some((f) => f.type === "run.ended") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(client.frames.some((f) => f.type === "run.ended")).toBe(true);

      // 模型是通过 read 工具读到同步下去的 SKILL.md，才可能知道暗号。
      const read = client.frames.find(
        (f) =>
          f.type === "tool.ended" &&
          f.data.toolName === "read" &&
          outputOf(f).includes("PROBE-X9Z"),
      );
      expect(read, "模型没有读到同步到 ssh 环境里的 skill").toBeDefined();
    } finally {
      client.close();
    }
  },
  240_000,
);
