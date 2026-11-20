// 手动冒烟：真实模型，验证后台任务全链路——模型把一个 http 服务放到后台，列出、读日志、停止。
// 不进默认检查：主仓库 tmp/model 不存在时整体跳过；只验一遍，不做评测。
//
// 用法（密钥只从文件读取，不会打印）：
//   YUANSHU_LIVE=1 pnpm --filter yuanshu-harness-server exec vitest run test/live/job.live.test.ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type YuanshuServer } from "../../src/server.js";
import { createSessionFactory } from "../../src/session/factory.js";
import { TestClient } from "../support/ws-client.js";

const MODEL_FILE = fileURLToPath(
  new URL("../../../../tmp/model", import.meta.url),
);
// pi models.json 形状：取第一个 provider 的第一个模型。
const provider = existsSync(MODEL_FILE)
  ? Object.values<any>(
      JSON.parse(readFileSync(MODEL_FILE, "utf8")).providers,
    )[0]
  : undefined;
const model = provider?.models?.[0];
const enabled = Boolean(model?.id);

let root = "";
let work = "";
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

const freePort = () =>
  new Promise<number>((ok, bad) => {
    const s = net.createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => ok(port));
    });
  });

const listening = (port: number) =>
  new Promise<boolean>((ok) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("connect", () => (c.destroy(), ok(true)));
    c.once("error", () => ok(false));
  });

beforeAll(async () => {
  if (!enabled) return;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-live-job-")));
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  mkdirSync(path.join(root, "web"));
  writeFileSync(path.join(root, "web", "index.html"), "<!doctype html>");
  work = path.join(root, "work");
  mkdirSync(work);
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "data"),
      allowCidrs: [],
    },
    {
      webRoot: path.join(root, "web"),
      startDir: work,
      makeSessionFactory: createSessionFactory,
      logStream: { write() {} },
    },
  );
  const addr = await server.start();
  http = `http://${addr.host}:${addr.port}`;
}, 30_000);

afterAll(async () => {
  // 模型若没停干净，兜底停掉，免得留下野进程。
  if (http) {
    const { sessions } = await call("GET", "/api/v1/sessions").catch(() => ({
      sessions: [],
    }));
    for (const s of sessions) {
      const { jobs } = await call("GET", `/api/v1/sessions/${s.id}/jobs`).catch(
        () => ({ jobs: [] }),
      );
      for (const j of jobs)
        if (j.state === "running")
          await call("POST", `/api/v1/jobs/${j.id}/stop`).catch(() => {});
    }
  }
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

test.skipIf(!enabled)(
  "模型把 http 服务放到后台，列出、读日志、停止，端口随之关闭",
  async () => {
    const m = await call("POST", "/api/v1/models", {
      name: "live",
      api: provider.api,
      baseUrl: provider.baseUrl,
      modelId: model.id,
      reasoning: Boolean(model.reasoning),
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: provider.compat,
      apiKey: provider.apiKey,
    });
    await call("PATCH", `/api/v1/models/${m.id}`, { isDefault: true });

    // full 档：冒烟不应被审批卡住。
    // 启动目录已自动登记为第一个 directory。
    const ws = (await call("GET", "/api/v1/directories")).directories[0];
    await call("PUT", "/api/v1/defaults", { permissionTier: "full" });
    const session = await call("POST", "/api/v1/sessions", {
      directoryId: ws.id,
    });
    const port = await freePort();

    const client = await TestClient.connect(
      `${http.replace("http", "ws")}/api/v1/sessions/${session.id}/stream`,
    );
    try {
      const ack = await client.command("send_message", {
        text:
          `请依次完成，每步都用对应工具：1) 用 job_start 在后台运行 bash 命令 \`python3 -m http.server ${port} --bind 127.0.0.1\`，` +
          "remind_after 填 0，label 填 demo；2) 用 job_list 看状态；3) 用 job_list 带上任务 id 读它的日志；" +
          "4) 用 job_stop 停掉它。最后用一句话汇报每步结果。不要直接用 bash。",
      });
      expect(ack.ok).toBe(true);

      const deadline = Date.now() + 240_000;
      while (
        !client.frames.some((f) => f.type === "run.ended") &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 200));
      expect(client.frames.some((f) => f.type === "run.ended")).toBe(true);

      const ended = client.frames.filter((f) => f.type === "tool.ended");
      for (const name of ["job_start", "job_list", "job_stop"]) {
        const f = ended.find((x) => x.data.toolName === name);
        expect(f, `模型没有调用 ${name}`).toBeDefined();
        expect(f?.data.isError, `${name} 报错：${f?.data.output}`).toBe(false);
      }
    } finally {
      client.close();
    }

    const { jobs } = await call("GET", `/api/v1/sessions/${session.id}/jobs`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("stopped");
    expect(jobs[0].label).toBe("demo");
    expect(await listening(port)).toBe(false);
  },
  300_000,
);
