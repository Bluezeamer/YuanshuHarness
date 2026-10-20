import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildRuntime, type ModelStore } from "../store/models.js";
import type { SecretStore } from "../store/secrets.js";
import type { SessionFactory } from "./pool.js";

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

// 真实会话工厂。有登记的默认模型就用它（密钥运行时注入）；没有则沿用 SDK 默认配置目录。
export function createSessionFactory(deps?: {
  models: ModelStore;
  secrets: SecretStore;
  agentDir: string;
}): SessionFactory {
  return async ({ id, sessionDir, cwd, file, extensions, agent }) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      extensionFactories: extensions,
      // 有 agent 定义时提示词完全由 Server 组装（项目 AGENTS.md 也在其中），关掉 SDK 自带读取以免重复。
      ...(agent
        ? {
            noContextFiles: true,
            appendSystemPromptOverride: (base: string[]) => {
              const t = agent.promptText();
              return t ? [...base, t] : base;
            },
          }
        : {}),
    });
    await resourceLoader.reload();
    const sessionManager = file
      ? SessionManager.open(file, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir, { id });
    const entry =
      (agent?.modelId ? deps?.models.get(agent.modelId) : null) ??
      deps?.models.default() ??
      null;
    const picked =
      deps && entry
        ? await buildRuntime(deps.agentDir, entry, deps.secrets)
        : null;
    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      resourceLoader,
      sessionManager,
      ...(picked ? { modelRuntime: picked.runtime, model: picked.model } : {}),
      ...(agent ? { tools: agent.tools } : {}),
      ...(agent?.thinkingLevel
        ? { thinkingLevel: agent.thinkingLevel as ThinkingLevel }
        : {}),
    });
    return session;
  };
}
