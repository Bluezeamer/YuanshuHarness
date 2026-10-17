import "../contract/isolate.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface Stub {
  url: string;
  requests: RecordedRequest[];
  // 每个请求到达时读取，测试可随时改。
  mode: { delayMs: number; status: number; chunkBytes: number };
  close(): Promise<void>;
}

// 最小的 OpenAI 兼容 stub：记录请求体，流式返回预设文本。
export async function startStub(
  reply: (n: number) => string = (n) => `stub-reply-${n}`,
): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const mode = { delayMs: 0, status: 200, chunkBytes: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const text = reply(requests.length);
      if (mode.status !== 200) {
        res.writeHead(mode.status, { "content-type": "application/json" });
        res.end('{"error":{"message":"stub failure"}}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = {
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "stub-model",
      };
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      });
      // 首个 chunk 先发出，其余延迟：让测试能在"生成中途"观察会话。
      setTimeout(async () => {
        // chunkBytes>0 时把文本切成多个增量，模拟真实的流式输出。
        const size = mode.chunkBytes > 0 ? mode.chunkBytes : text.length || 1;
        for (let i = 0; i < Math.max(text.length, 1); i += size) {
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: { content: text.slice(i, i + size) },
                finish_reason: null,
              },
            ],
          });
          if (mode.chunkBytes > 0) await new Promise((r) => setTimeout(r, 2));
        }
        send({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        send({
          ...base,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }, mode.delayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    mode,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function tmpDir(prefix = "yuanshu-contract-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Env {
  root: string;
  agentDir: string;
  cwd: string;
}

export function makeEnv(): Env {
  const root = tmpDir();
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, agentDir, cwd };
}

export function writeModels(
  env: Env,
  baseUrl: string,
  extra: Record<string, unknown> = {},
  apiKey: string | null = "stub-key",
): void {
  writeFileSync(
    join(env.agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl,
          api: "openai-completions",
          ...(apiKey === null ? {} : { apiKey }),
          models: [{ id: "stub-model", ...extra }],
        },
      },
    }),
  );
}

export async function openSession(
  env: Env,
  opts: {
    sessionManager?: SessionManager;
    loader?: Partial<ConstructorParameters<typeof DefaultResourceLoader>[0]>;
    compaction?: { keepRecentTokens: number; reserveTokens: number };
    retry?: boolean;
    noTools?: false;
  } = {},
) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(env.agentDir, "auth.json"),
    modelsPath: join(env.agentDir, "models.json"),
  });
  const model = modelRuntime.getModel("stub", "stub-model");
  if (!model) throw new Error("stub model not found");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, ...opts.compaction },
    ...(opts.retry === false ? { retry: { enabled: false } } : {}),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: env.cwd,
    agentDir: env.agentDir,
    settingsManager,
    ...opts.loader,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: env.cwd,
    agentDir: env.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: opts.sessionManager ?? SessionManager.inMemory(env.cwd),
    ...(opts.noTools === false ? {} : { noTools: "all" as const }),
  });
  return { session, modelRuntime, resourceLoader };
}

// 每次调用建一个全新的隔离会话，对着给定的 stub；关闭重试，避免失败用例等退避。
export function stubSessionFactory(
  stub: { url: string },
  modelExtra: Record<string, unknown> = {},
) {
  return async () => {
    const env = makeEnv();
    writeModels(env, stub.url, modelExtra);
    const { session } = await openSession(env, { retry: false });
    return session;
  };
}
