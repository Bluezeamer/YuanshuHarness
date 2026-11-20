// 输入栏测试用的假服务端世界（只被 *.test.tsx 引用）：供应商 / 会话配置 / agent / 工具 / MCP 与 fetch 路由。
import { vi } from "vitest";
import type { DefaultModel } from "../../../api/defaultModel";
import { PI_IMAGE_COMPRESSION, type Tier } from "../../../api/defaults";
import type {
  AuthMethod,
  ModelSpec,
  ProviderView,
} from "../../../api/providers";
import type { ConfigPatch, SessionConfig } from "../../../api/sessionConfig";

export const spec = (
  id: string,
  name: string,
  over: Partial<ModelSpec> = {},
): ModelSpec => ({
  id,
  name,
  reasoning: true,
  levels: ["off", "low", "medium", "high", "xhigh", "max"],
  input: ["text"],
  ctx: 200000,
  out: 8192,
  source: "catalog",
  ...over,
});

export const provider = (
  id: string,
  name: string,
  method: AuthMethod,
  models: ModelSpec[],
  status: ProviderView["status"] = "ok",
): ProviderView => ({
  id,
  name,
  custom: false,
  added: true,
  methods: [method],
  method,
  status,
  probeable: true,
  maxConcurrent: 50,
  keyStorage: "auth",
  hasKey: true,
  credential: { source: null, chain: [] },
  models,
});

// 已连接 5 家 10 个模型 + 一家未连接（不该出现在选单里）
export const PROVIDERS: ProviderView[] = [
  provider("anthropic", "Anthropic", "oauth", [
    spec("claude-sonnet-5", "Claude Sonnet 5"),
    spec("claude-opus-4-8", "Claude Opus 4.8"),
    spec("claude-haiku-5-5", "Claude Haiku 5.5"),
  ]),
  provider("openai", "OpenAI", "key", [
    spec("gpt-5", "GPT-5", { ctx: 400000 }),
    spec("gpt-5-mini", "GPT-5 mini", { ctx: 400000 }),
    spec("gpt-5-nano", "GPT-5 nano", { ctx: 400000 }),
  ]),
  provider("deepseek", "DeepSeek", "key", [
    spec("deepseek-v4", "DeepSeek V4", { ctx: 1_000_000 }),
    spec("deepseek-r2", "DeepSeek R2"),
  ]),
  provider("qwen", "Qwen", "env", [
    spec("qwen3-8-27b", "Qwen3.8 27B", {
      levels: ["off", "low", "high"],
      map: { high: "xhigh" },
    }),
  ]),
  provider("openrouter", "OpenRouter", "key", [
    spec("or-sonnet", "Sonnet via OpenRouter"),
  ]),
  provider("gemini", "Gemini", "key", [spec("gemini-3", "Gemini 3")], "off"),
];

export const baseConfig = (
  over: Partial<SessionConfig> = {},
): SessionConfig => ({
  sessionId: "s1",
  model: { mode: "follow-default" },
  capabilities: ["skill:code-review", "mcp:github", "mcp:linear"],
  permissionTier: null,
  rev: 3,
  ...over,
});

export interface World {
  config: SessionConfig;
  providers: ProviderView[];
  /** GET /default-model 的返回；null = 没设置默认模型 */
  defaultModel: DefaultModel | null;
  /** GET /defaults 里权限相关的两项：会话没覆盖时跟随的档位、审批模型（null = 没配） */
  defaults: { permissionTier: Tier; reviewModel: DefaultModel | null };
  /** GET /sessions/:id/context：会话实际生效的技能与 MCP（输入栏的 MCP 胶囊读它） */
  context: {
    skills: {
      name: string;
      description: string;
      path: string;
      loadedAt: string;
    }[];
    mcp: {
      name: string;
      state: "ready" | "connecting" | "failed" | "disabled";
      tools: number;
      error?: string;
      global: boolean;
      transport: "stdio" | "http";
      where?: string;
    }[];
  };
  /** GET / PUT /sessions/:id/modes：可切换的模式与当前模式（没有模式时输入栏不显示胶囊） */
  modes: { modes: { id: string; name: string }[]; activeModeId: string | null };
  /** 收到的 PATCH 会话配置请求体 */
  patches: { baseRev: number; patch: ConfigPatch }[];
  /** 下一次 PATCH 的失败状态与错误体 */
  fail: { status: number; body: unknown } | null;
  /** 收到的会话动作请求（如 /api/v1/sessions/s1/resume） */
  actions: string[];
}

export function installWorld(over: Partial<World> = {}): World {
  const w: World = {
    config: baseConfig(),
    providers: PROVIDERS,
    defaultModel: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      thinking: "medium",
    },
    context: {
      skills: [
        {
          name: "code-review",
          description: "代码审查",
          path: "/skills/code-review/SKILL.md",
          loadedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      mcp: [
        {
          name: "github",
          state: "ready",
          tools: 3,
          global: true,
          transport: "http",
          where: "Server",
        },
        {
          name: "linear",
          state: "failed",
          tools: 0,
          error: "握手超时 · 15s · 未收到 ListTools 响应",
          global: false,
          transport: "http",
          where: "Server",
        },
      ],
    },
    defaults: { permissionTier: "rules", reviewModel: null },
    modes: { modes: [], activeModeId: null },
    patches: [],
    fail: null,
    actions: [],
    ...over,
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input.endsWith("/modes")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          activeModeId?: string | null;
        };
        w.modes = { ...w.modes, activeModeId: body.activeModeId ?? null };
      }
      return reply(200, w.modes);
    }
    if (input.endsWith("/config")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as World["patches"][number];
        w.patches.push(body);
        if (w.fail) {
          const f = w.fail;
          w.fail = null;
          return reply(f.status, f.body);
        }
        w.config = { ...w.config, ...body.patch, rev: w.config.rev + 1 };
        return reply(200, { config: w.config, appliedAt: "now" });
      }
      return reply(200, w.config);
    }
    if (init?.method === "POST" && /\/sessions\/s1\/\w+$/.test(input)) {
      w.actions.push(input);
      return reply(200, {});
    }
    if (input === "/api/v1/sessions/s1/flows")
      return reply(200, {
        executions: [],
        workflow: [],
      });
    if (input === "/api/v1/sessions/s1/context")
      return reply(200, {
        files: [
          {
            path: "/w/a.ts",
            hostId: "local",
            tokens: 12,
            reads: 1,
            modified: false,
            lastAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        skills: w.context.skills,
        mcp: w.context.mcp,
      });
    if (input === "/api/v1/providers")
      return reply(200, { providers: w.providers });
    if (input === "/api/v1/default-model")
      return reply(200, { default: w.defaultModel });
    if (input === "/api/v1/defaults")
      return reply(200, {
        directoryStart: "~",
        imageCompression: PI_IMAGE_COMPRESSION,
        ...w.defaults,
      });
    return reply(404, {});
  });
  return w;
}
