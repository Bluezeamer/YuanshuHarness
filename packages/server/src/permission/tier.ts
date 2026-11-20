// 审批档位：规则（rules）→ 模型（auto，交审批模型）→ 通过（full）。全局默认一份，会话可覆盖。
export const TIERS = ["rules", "auto", "full"] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (v: unknown): v is Tier =>
  typeof v === "string" && (TIERS as readonly string[]).includes(v);
