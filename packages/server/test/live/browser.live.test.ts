// 手动冒烟：真实模型 + 本机真实 Chromium，让模型用 browser_open 打开本地起的测试页并读到页面内容，
// 同时从侧边流上确认收到了 state 通知与 JPEG 截图帧。只冒烟，不评测。
// 不进默认检查：主仓库 tmp/model 不存在或本机找不到 Chromium 时整体跳过。
//
// 用法：pnpm --filter yuanshu-harness-server exec vitest run test/live/browser.live.test.ts
// 端点从主仓库 tmp/model（pi 的 models.json 形状）读取，只由程序读取，不会打印。
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { findBrowser } from "../../src/browser/locate.js";
import { createServer, type YuanshuServer } from "../../src/server.js";
import { createSessionFactory } from "../../src/session/factory.js";
import type { Frame } from "../support/frames.js";
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
const enabled = endpoint !== null && findBrowser() !== null;

// 每次随机：模型只有真的读到页面，才可能复述出这个标记。
const MARKER = `PAGE-${randomUUID().slice(0, 8)}`;

let root = "";
let server: YuanshuServer;
let origin = "";
let pageServer: http.Server;
let pageUrl = "";

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${origin}${url}`, {
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
  pageServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><title>冒烟页</title><h1>${MARKER}</h1><a href="/next">下一页</a>`,
    );
  });
  await new Promise<void>((r) => pageServer.listen(0, "127.0.0.1", r));
  pageUrl = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}/`;

  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-br-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
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
  origin = `http://${addr.host}:${addr.port}`;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await new Promise<void>((r) =>
    pageServer ? pageServer.close(() => r()) : r(),
  );
  if (root) rmSync(root, { recursive: true, force: true });
});

const outputOf = (f: Frame) => String(f.data.output ?? "");

test.skipIf(!enabled)(
  "模型用 browser_open 打开本地页面并读到内容，侧边流收到 state 与截图",
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

    const ws = await call("POST", "/api/v1/workspaces", { path: root });
    // full 档：冒烟不应被审批卡住（审批文案与记住站点由单测覆盖）。
    await call("PATCH", `/api/v1/workspaces/${ws.id}`, { tier: "full" });
    const session = await call("POST", "/api/v1/sessions", {
      workspaceId: ws.id,
    });

    const wsBase = origin.replace("http", "ws");
    // 先接上侧边流，再让模型动手，才能看到 agent 打开页面后的推送。
    const side = new WebSocket(
      `${wsBase}/api/v1/sessions/${session.id}/browser/stream`,
      ["yuanshu.v1"],
    );
    side.binaryType = "arraybuffer";
    const states: Array<Record<string, unknown>> = [];
    let jpegFrames = 0;
    let jpegHead = "";
    side.onmessage = (e) => {
      if (typeof e.data === "string") {
        try {
          const n = JSON.parse(e.data) as Record<string, unknown>;
          if (n.type === "state") states.push(n);
        } catch {}
      } else if (e.data instanceof ArrayBuffer) {
        jpegFrames++;
        if (!jpegHead)
          jpegHead = Buffer.from(e.data.slice(0, 3)).toString("hex");
      }
    };

    const client = await TestClient.connect(
      `${wsBase}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text:
          `请用 browser_open 工具打开 ${pageUrl} ，` +
          "然后告诉我页面里那个大标题（h1）的原文，不要做别的。",
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

      const opened = client.frames.find(
        (f) => f.type === "tool.ended" && f.data.toolName === "browser_open",
      );
      expect(opened, "模型没有调用 browser_open").toBeDefined();
      expect(outputOf(opened as Frame)).toContain(MARKER);

      // 模型最终回复里复述了标记，说明它确实读到了页面内容。
      const reply = client.frames
        .filter((f) => f.type === "message.ended")
        .map((f) => JSON.stringify(f.data))
        .join("\n");
      expect(reply).toContain(MARKER);

      // 侧边流：state 通知 active 且带 URL；JPEG 帧以 ffd8ff 开头。
      await new Promise((r) => setTimeout(r, 1500));
      expect(
        states.some((s) => s.active === true && s.url === pageUrl),
        "侧边流没有收到 active 的 state",
      ).toBe(true);
      expect(jpegFrames, "侧边流没有收到截图帧").toBeGreaterThan(0);
      expect(jpegHead).toBe("ffd8ff");
    } finally {
      side.close();
      client.close();
    }
  },
  240_000,
);
