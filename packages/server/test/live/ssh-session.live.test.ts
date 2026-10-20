// 手动冒烟：真实模型 + 真实 sshd，在 ssh workspace 里跑一轮会话，确认工具走远程。
// 不进默认检查：缺少 YUANSHU_LIVE_* 环境变量或本机没有 sshd 时整体跳过。
//
// 用法（密钥只经环境变量传入，不会打印）：
//   YUANSHU_LIVE_BASE_URL=<含 /v1> YUANSHU_LIVE_MODEL=<模型 id> [YUANSHU_LIVE_API_KEY=<key>] \
//     pnpm --filter yuanshu-harness-server exec vitest run test/live/ssh-session.live.test.ts
//
// 判据：sshd 只会给经它启动的命令设置 SSH_CONNECTION，所以 bash 工具输出里有它，
// 就说明命令确实是经 ssh 通道执行的，而不是在 Server 进程本机直接 spawn。
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
import { createServer, type YuanshuServer } from "../../src/server.js";
import { createSessionFactory } from "../../src/session/factory.js";
import type { Frame } from "../support/frames.js";
import { hasSshd, startSshd, type TestSshd } from "../support/sshd.js";
import { TestClient } from "../support/ws-client.js";

const baseUrl = process.env.YUANSHU_LIVE_BASE_URL;
const modelId = process.env.YUANSHU_LIVE_MODEL;
const apiKey = process.env.YUANSHU_LIVE_API_KEY;
const enabled = Boolean(baseUrl && modelId) && hasSshd;

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
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-ssh-")));
  // 工厂读 SDK 的默认配置目录；指到临时目录，不碰用户的真实配置。
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
  "ssh workspace 里的 bash 经 ssh 通道执行，read 读到远程文件",
  async () => {
    const model = await call("POST", "/api/v1/models", {
      name: "live",
      api: "openai-completions",
      baseUrl,
      modelId,
      reasoning: false,
      ...(apiKey ? { apiKey } : {}),
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
    writeFileSync(path.join(remoteDir, "marker.txt"), "MARKER-7Q2\n");
    const ws = await call("POST", "/api/v1/workspaces", {
      path: remoteDir,
      environmentId: env.id,
    });
    // full 档：冒烟不应被审批卡住。
    await call("PATCH", `/api/v1/workspaces/${ws.id}`, { tier: "full" });
    const session = await call("POST", "/api/v1/sessions", {
      workspaceId: ws.id,
    });

    const client = await TestClient.connect(
      `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text:
          "请依次做两件事，不要做别的：" +
          '1) 用 bash 工具原样执行：echo "conn=$SSH_CONNECTION"；' +
          "2) 用 read 工具读取当前目录下的 marker.txt。完成后用一句话汇报两者的结果。",
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

      const ended = client.frames.filter((f) => f.type === "tool.ended");
      const bash = ended.find((f) => f.data.toolName === "bash");
      const read = ended.find((f) => f.data.toolName === "read");
      expect(bash, "模型没有调用 bash").toBeDefined();
      expect(outputOf(bash as Frame)).toMatch(/conn=\S+ \d+ \S+ \d+/);
      expect(read, "模型没有调用 read").toBeDefined();
      expect(outputOf(read as Frame)).toContain("MARKER-7Q2");
    } finally {
      client.close();
    }
  },
  240_000,
);
