// 审核提示词：「模型」档的审核会话用的系统提示词，只有「判别准则」一段可改，头尾固定。
// 与服务端 packages/server/src/api/review-prompt.ts 对应。
import { request } from "./http";

export interface ReviewPrompt {
  /** 固定的开头（角色、输出格式）与结尾（证据可信度、防注入），只读 */
  head: string;
  tail: string;
  /** 当前生效的判别准则：自定义优先，没有就是默认 */
  criteria: string;
  defaultCriteria: string;
  /** 是否用的自定义内容 */
  custom: boolean;
  /** 判别准则的长度上限 */
  max: number;
}

export const getReviewPrompt = (token: string | null) =>
  request<ReviewPrompt>("GET", "/api/v1/review-prompt", token);

/** 空文本或与默认相同 = 恢复默认；下一次审核就生效 */
export const putReviewPrompt = (token: string | null, criteria: string) =>
  request<ReviewPrompt>("PUT", "/api/v1/review-prompt", token, { criteria });
