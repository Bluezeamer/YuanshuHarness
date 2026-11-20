// 审核提示词的读取与保存：判别准则存在服务端（/review-prompt），保存后下一次审核就生效。
import { useCallback, useEffect, useState } from "react";
import { ApiError, loadToken } from "../../../api/http";
import {
  getReviewPrompt,
  putReviewPrompt,
  type ReviewPrompt,
} from "../../../api/reviewPrompt";
import { describeError } from "../providers/errors";

export type ReviewPromptState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; saved: ReviewPrompt };

/** 判别准则的校验：不能空（想回默认用「恢复默认」）、不超过上限；返回错误文案或 null */
export function criteriaError(draft: string, max: number): string | null {
  const n = draft.trim().length;
  if (n === 0) return "判别准则不能为空；想用默认的，点「恢复默认」。";
  if (n > max) return `太长了：最多 ${max} 个字符，现在 ${n} 个。`;
  return null;
}

const messageOf = (e: unknown): string =>
  e instanceof ApiError && e.code === "invalid_review_criteria"
    ? "判别准则不合法：不能为空，也不能超过长度上限。"
    : describeError(e).message;

export function useReviewPrompt() {
  const [state, setState] = useState<ReviewPromptState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用来触发重试
  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    getReviewPrompt(loadToken()).then(
      (saved) => alive && setState({ phase: "ready", saved }),
      (e) => alive && setState({ phase: "error", message: messageOf(e) }),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  /** 返回 null = 成功，否则是给人看的一句话（useDraft 的约定）。 */
  const save = async (draft: string, max: number): Promise<string | null> => {
    const bad = criteriaError(draft, max);
    if (bad) return bad;
    try {
      const saved = await putReviewPrompt(loadToken(), draft.trim());
      setState({ phase: "ready", saved });
      return null;
    } catch (e) {
      return messageOf(e);
    }
  };

  return {
    state,
    retry: useCallback(() => setAttempt((n) => n + 1), []),
    save,
  };
}
