// 一次性的模型会话：无工具、不落盘、不带扩展与技能，系统提示只用我们给的那一份。
// 审核会话（审批模型）与辅助调用（辅助模型）共用。
import { tmpdir } from "node:os";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { limitRequests, type RequestLimiter } from "../provider/limiter.js";
import type { ModelResolver } from "../provider/resolve.js";

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

export interface OneShotModel {
  provider: string;
  model: string;
  thinking: string | null;
}

/** label 只用于报错文字（「审批模型」「辅助模型」） */
export async function createOneShot(
  deps: { resolver: ModelResolver; limiter?: RequestLimiter },
  pick: OneShotModel,
  systemPrompt: string,
  label: string,
): Promise<AgentSession> {
  // build 在找不到时会退回全局默认模型；这里的模型不能悄悄换成别的，先确认它还在。
  if (!deps.resolver.has(pick.provider, pick.model))
    throw new Error(`${label}不存在：${pick.provider}/${pick.model}`);
  const picked = await deps.resolver.build(pick.provider, pick.model);
  // build 在构造失败时同样会退回全局默认模型。
  if (!picked || picked.model.id !== pick.model)
    throw new Error(`${label}无法构造`);
  const cwd = tmpdir();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    // 系统提示只能是我们给的那一份，不追加用户 pi 目录里的 APPEND_SYSTEM.md。
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    modelRuntime: picked.runtime,
    model: picked.model,
    noTools: "all",
    ...(pick.thinking ? { thinkingLevel: pick.thinking as ThinkingLevel } : {}),
  });
  limitRequests(session, deps.limiter);
  return session;
}
