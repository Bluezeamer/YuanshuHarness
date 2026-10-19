import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionFactory } from "./pool.js";

// 真实会话工厂：模型与凭据沿用 SDK 的默认配置目录（PI_CODING_AGENT_DIR 或 ~/.pi/agent），
// 统一的模型接入与配置界面属于路线图第 7 条。
export function createSessionFactory(agentDir = getAgentDir()): SessionFactory {
  return async ({ id, sessionDir, cwd, file, extensions }) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: extensions,
    });
    await resourceLoader.reload();
    const sessionManager = file
      ? SessionManager.open(file, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir, { id });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager,
    });
    return session;
  };
}
