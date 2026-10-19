import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildRuntime, type ModelStore } from "../store/models.js";
import type { SecretStore } from "../store/secrets.js";
import type { SessionFactory } from "./pool.js";

// 真实会话工厂。有登记的默认模型就用它（密钥运行时注入）；没有则沿用 SDK 默认配置目录。
export function createSessionFactory(deps?: {
  models: ModelStore;
  secrets: SecretStore;
  agentDir: string;
}): SessionFactory {
  return async ({ id, sessionDir, cwd, file, extensions }) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      extensionFactories: extensions,
    });
    await resourceLoader.reload();
    const sessionManager = file
      ? SessionManager.open(file, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir, { id });
    const entry = deps?.models.default() ?? null;
    const picked =
      deps && entry
        ? await buildRuntime(deps.agentDir, entry, deps.secrets)
        : null;
    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      resourceLoader,
      sessionManager,
      ...(picked
        ? { modelRuntime: picked.runtime, model: picked.model }
        : {}),
    });
    return session;
  };
}
