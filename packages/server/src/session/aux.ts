// 辅助调用（team.md §5）：一次性的小调用，用全局的辅助模型；没配置就用调用方会话自己的模型。
// 板子摘要用它，以后会话自动命名也用它。每次现读配置，改了下一次调用就生效。
import { lastAssistantText } from "../permission/review.js";
import type { RequestLimiter } from "../provider/limiter.js";
import type { ModelResolver } from "../provider/resolve.js";
import type { AuxModel } from "../store/defaults.js";
import { createOneShot } from "./one-shot.js";

export const AUX_TIMEOUT_MS = 60_000;

/** 对会话 sessionId 做一次辅助调用：系统提示 + 一条用户消息，返回助手的回复文字 */
export type AuxRunner = (
  sessionId: string,
  systemPrompt: string,
  userText: string,
) => Promise<string>;

export function createAuxRunner(deps: {
  resolver: ModelResolver;
  limiter?: RequestLimiter;
  auxModel: () => AuxModel | null;
  /** 会话此刻用的模型（没配辅助模型时退回它） */
  sessionModel: (
    sessionId: string,
  ) => { provider: string; model: string } | null;
  timeoutMs?: number;
}): AuxRunner {
  return async (sessionId, systemPrompt, userText) => {
    const own = deps.sessionModel(sessionId);
    const pick = deps.auxModel() ?? (own ? { ...own, thinking: null } : null);
    if (!pick) throw new Error("没有可用于辅助调用的模型");
    const session = await createOneShot(deps, pick, systemPrompt, "辅助模型");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.prompt(userText),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("辅助调用超时")),
            deps.timeoutMs ?? AUX_TIMEOUT_MS,
          );
        }),
      ]);
      return lastAssistantText(session);
    } finally {
      clearTimeout(timer);
      session.dispose();
    }
  };
}
