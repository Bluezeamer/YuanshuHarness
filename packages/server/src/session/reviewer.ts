// 审核会话工厂：用全局配置的审批模型建一个一次性会话（ADR-0031，见 one-shot.ts）。
// 每次审核现读配置：审批模型改了或清了，下一次审核就生效；没配或找不到就抛错，由 runReview 降级给用户。
import type { ReviewerFactory } from "../permission/review.js";
import type { RequestLimiter } from "../provider/limiter.js";
import type { ModelResolver } from "../provider/resolve.js";
import type { ReviewModel } from "../store/defaults.js";
import { createOneShot } from "./one-shot.js";

export function createReviewerFactory(deps: {
  resolver: ModelResolver;
  reviewModel: () => ReviewModel | null;
  limiter?: RequestLimiter;
}): ReviewerFactory {
  return async ({ systemPrompt }) => {
    const rm = deps.reviewModel();
    if (!rm) throw new Error("没有配置审批模型");
    return createOneShot(deps, rm, systemPrompt, "审批模型");
  };
}
