import "../contract/isolate.js";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  type PoolDeps,
  type SessionFactory,
  SessionPool,
} from "../../src/session/pool.js";
import { openDatabase } from "../../src/store/db.js";
import { RuleStore } from "../../src/store/rules.js";
import { SessionStore } from "../../src/store/sessions.js";
import { WorkspaceStore } from "../../src/store/workspaces.js";

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

// 回复可以是文本，也可以是一次工具调用（模型“决定”调用工具）。
export type StubReply =
  | string
  | { tool: string; args: Record<string, unknown> };

// 最小的 OpenAI 兼容 stub：记录请求体，流式返回预设文本或工具调用。
export async function startStub(
  reply: (n: number, body: Record<string, unknown>) => StubReply = (n) =>
    `stub-reply-${n}`,
): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const mode = { delayMs: 0, status: 200, chunkBytes: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const out = reply(requests.length, body);
      const call = typeof out === "string" ? null : out;
      const text = typeof out === "string" ? out : "";
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
        if (call) {
          send({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${requests.length}`,
                      type: "function",
                      function: {
                        name: call.tool,
                        arguments: JSON.stringify(call.args),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
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
    // false：启用内置工具（read/bash/edit/write 等）；缺省只保留扩展工具。
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
    ...(opts.noTools === false ? {} : { noTools: "builtin" as const }),
  });
  return { session, modelRuntime, resourceLoader };
}

// 每次调用按传入的 id 与目录新建（或按 file 恢复）一个隔离会话，对着给定的 stub；
// 关闭重试，避免失败用例等退避。
export function stubSessionFactory(
  stub: { url: string },
  modelExtra: Record<string, unknown> = {},
  builtinTools = false,
): SessionFactory {
  return async ({ id, sessionDir, file, cwd, extensions }) => {
    // 工作目录以池给出的 workspace 路径为准；其余（agentDir 等）仍是隔离的临时目录。
    const env = { ...makeEnv(), cwd };
    writeModels(env, stub.url, modelExtra);
    const manager = file
      ? SessionManager.open(file, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir, { id });
    const { session } = await openSession(env, {
      sessionManager: manager,
      retry: false,
      loader: { extensionFactories: extensions },
      ...(builtinTools ? { noTools: false as const } : {}),
    });
    return session;
  };
}

// 一个临时数据目录：已迁移的数据库、索引与 sessions 目录。close() 释放并删除。
export function testData(existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "yuanshu-data-"));
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const db = openDatabase(dir);
  const store = new SessionStore(db);
  const workspaces = new WorkspaceStore(db);
  const rules = new RuleStore(db);
  // 默认 workspace 指向数据目录本身（真实存在的目录）；已有 workspace 时不重复登记。
  workspaces.ensureDefault(dir);
  return {
    dir,
    sessionDir,
    db,
    store,
    workspaces,
    rules,
    close(remove = true) {
      try {
        db.close();
      } catch {}
      if (remove) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type TestData = ReturnType<typeof testData>;

export function testPool(
  factory: SessionFactory,
  data: TestData = testData(),
  extra: Partial<PoolDeps> = {},
): { pool: SessionPool; data: TestData } {
  return {
    pool: new SessionPool({
      factory,
      store: data.store,
      workspaces: data.workspaces,
      rules: data.rules,
      sessionDir: data.sessionDir,
      ...extra,
    }),
    data,
  };
}

// 在给定目录里建一个已持久化的会话：按 id 创建、依次发送 prompts，返回 JSONL 路径。
export async function persistSession(
  stub: { url: string },
  sessionDir: string,
  id: string,
  prompts: string[],
  name?: string,
): Promise<string> {
  const env = makeEnv();
  writeModels(env, stub.url);
  const manager = SessionManager.create(env.cwd, sessionDir, { id });
  const { session } = await openSession(env, {
    sessionManager: manager,
    retry: false,
  });
  if (name) manager.appendSessionInfo(name);
  for (const p of prompts) await session.prompt(p);
  const file = manager.getSessionFile();
  session.dispose();
  if (!file) throw new Error("会话没有落盘");
  return file;
}

// 给会话 JSONL 末尾追加一条带工具调用、没有结果的助手消息，模拟运行中被打断。
export function appendDanglingToolCall(file: string, callId = "call_x"): void {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1] as string) as { id: string };
  const entry = {
    type: "message",
    id: "dangle01",
    parentId: last.id,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "t", arguments: {} }],
      api: "openai-completions",
      provider: "stub",
      model: "stub-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
  };
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
