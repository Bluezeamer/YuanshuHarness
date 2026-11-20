import type { FastifyInstance } from "fastify";
import { isObject } from "../lib/validate.js";
import {
  DEFAULT_CRITERIA,
  POLICY_MAX,
  PROTOCOL_HEAD,
  PROTOCOL_TAIL,
} from "../permission/review-policy.js";
import type { DefaultsStore } from "../store/defaults.js";

// 审核提示词：头尾固定不可改，只有判别准则可编辑（null = 恢复默认）。
export function reviewPromptApi(
  app: FastifyInstance,
  opts: { defaults: DefaultsStore },
): void {
  const { defaults } = opts;

  const view = () => {
    const custom = defaults.reviewCriteria();
    return {
      head: PROTOCOL_HEAD,
      tail: PROTOCOL_TAIL,
      criteria: custom ?? DEFAULT_CRITERIA,
      defaultCriteria: DEFAULT_CRITERIA,
      custom: custom !== null,
      max: POLICY_MAX,
    };
  };

  app.get("/api/v1/review-prompt", async () => view());

  // criteria 为 null、trim 后为空、或与默认文本相同 = 恢复默认（删键，默认以后改了也跟着变），其余存 trim 后的文本。
  app.put("/api/v1/review-prompt", async (req, reply) => {
    const b = isObject(req.body) ? req.body : {};
    const raw = b.criteria;
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (
      value !== null &&
      (typeof value !== "string" || value.length > POLICY_MAX)
    )
      return reply.code(400).send({ error: "invalid_review_criteria" });
    const reset = value === null || value === "" || value === DEFAULT_CRITERIA;
    defaults.setReviewCriteria(reset ? null : value);
    return view();
  });
}
