// 手动冒烟：真实模型 + 真实 sshd，让模型用一个隐私变量跑一条命令，
// 断言事件帧与落盘文件里都没有变量明文，而输出里的回显被换回了 @变量名。只冒烟，不评测。
// 不进默认检查：缺少模型端点文件或本机没有 sshd 时整体跳过。
//
// 用法：pnpm --filter yuanshu-harness-server exec vitest run test/live/private-vars.live.test.ts
// 端点从主仓库 tmp/model（pi 的 models.json 形状）读取，只由程序读取，不会打印。
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

interface Endpoint {
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey: string | null;
}

function readEndpoint(): Endpoint | null {
  if (!existsSync(MODEL_FILE)) return null;
  try {
    const cfg = JSON.parse(readFileSync(MODEL_FILE, "utf8")) as {
      providers: Record<
        string,
        {
          api: string;
          baseUrl: string;
          apiKey?: string;
          models: { id: string }[];
        }
      >;
    };
    const p = Object.values(cfg.providers)[0];
    const id = p?.models[0]?.id;
    if (!p || !id) return null;
    return {
      api: p.api,
      baseUrl: p.baseUrl,
      modelId: id,
      apiKey: p.apiKey ?? null,
    };
  } catch {
    return null;
  }
}

const endpoint = readEndpoint();
const enabled = endpoint !== null && hasSshd;

// 明显的假值；每次随机，避免和别处的文本巧合相撞。
const VALUE = `test-secret-${randomUUID().slice(0, 8)}`;

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

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

beforeAll(async () => {
  if (!enabled) return;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-vars-")));
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

test.skipIf(!enabled)(
  "模型用隐私变量完成命令：帧与落盘里没有明文，回显被遮罩",
  async () => {
    const ep = endpoint as Endpoint;
    const model = await call("POST", "/api/v1/models", {
      name: "live",
      api: ep.api,
      baseUrl: ep.baseUrl,
      modelId: ep.modelId,
      reasoning: false,
      ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
    });
    await call("PATCH", `/api/v1/models/${model.id}`, { isDefault: true });

    // 变量与 workspace 都用 full 档：冒烟不应被审批卡住。
    await call("POST", "/api/v1/variables", {
      name: "tok",
      value: VALUE,
      purpose: "冒烟用的假令牌，命令里写 @tok 引用",
      scopeKind: "any",
      tier: "full",
    });
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
    const session = await call("POST", "/api/v1/sessions", {
      workspaceId: ws.id,
    });

    const client = await TestClient.connect(
      `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text:
          "请只做一件事：用 bash 工具原样执行下面这条命令（@tok 是已登记的隐私变量，不要改写它），" +
          "然后用一句话汇报输出。\nprintf %s @tok | wc -c; printf 'a:%s:b' @tok",
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

      const bash = client.frames.find(
        (f: Frame) => f.type === "tool.ended" && f.data.toolName === "bash",
      );
      expect(bash, "模型没有调用 bash").toBeDefined();
      const out = String(bash?.data.output ?? "");
      // 命令确实拿到了真值（字节数对得上），回显被换回了占位符。
      expect(out).toMatch(new RegExp(`\\b${Buffer.byteLength(VALUE)}\\b`));
      expect(out).toContain("a:@tok:b");

      expect(JSON.stringify(client.frames)).not.toContain(VALUE);
      // 会话 JSONL、SQLite、日志等一切落盘文件里都不应有明文。
      const files = [...walk(root)];
      const leaked = files.filter((f) =>
        readFileSync(f).includes(Buffer.from(VALUE)),
      );
      expect(leaked).toEqual([]);
      const jsonl = files.filter((f) => f.endsWith(".jsonl"));
      expect(
        jsonl.some((f) => readFileSync(f, "utf8").includes("@tok")),
        "会话文件里应记录占位符",
      ).toBe(true);
    } finally {
      client.close();
    }
  },
  240_000,
);
