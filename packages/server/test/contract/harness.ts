import "./isolate.js";
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
  close(): Promise<void>;
}

// 最小的 OpenAI 兼容 stub：记录请求体，流式返回预设文本。
export async function startStub(
  reply: (n: number) => string = (n) => `stub-reply-${n}`,
): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const text = reply(requests.length);
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
      send({
        ...base,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
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
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
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

export const textOf = (m: { content?: unknown }): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m);

// 统计标记在整个请求（所有消息）里出现的总次数，而不是包含标记的消息条数。
export const countIn = (
  body: { messages: Array<{ content?: unknown }> },
  needle: string,
): number => body.messages.map(textOf).join("\n").split(needle).length - 1;

export const toolNames = (body: {
  tools?: Array<{ function?: { name: string } }>;
}): string[] => (body.tools ?? []).map((t) => t.function?.name ?? "");

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as never;
export const makeTool = (name: string) => ({
  name,
  label: name,
  description: `tool ${name}`,
  parameters: emptySchema,
  execute: async () => ({
    content: [{ type: "text" as const, text: "ok" }],
    details: {},
  }),
});

export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i < 0 ? arr.length + i : i];
  if (v === undefined)
    throw new Error(`index ${i} out of range (length ${arr.length})`);
  return v;
}
