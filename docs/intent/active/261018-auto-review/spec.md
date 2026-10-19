# Spec: 二档自动模式
Author: bluezeamer
Status: accepted
Date: 2026-10-18

> 口径见 [ADR-0031](../../../genesis/adr/0031-auto-review.md)。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0031](../../../genesis/adr/0031-auto-review.md)、[ADR-0030](../../../genesis/adr/0030-permission-rules.md)
下游: [plan.md](plan.md)

## Requirements
R1. 迁移 v5 给 `sessions` 加 `review_policy`；`PATCH /sessions/:id` 支持 `reviewPolicy`（去空白后 0–4000 字符，空串清除，超长 400），会话条目返回该字段。
R2. 档位 `auto` 且注入了 `reviewerFactory` 时，规则外动作交审核；`allow` 执行，`deny` 以 `block` 返回并带理由。
R3. 审核输出非严格 JSON、取值非法、`decision: "ask"`、审核会话报错、超过 60 秒：一律降级为审批弹窗，绝不放行。
R4. 敏感路径与含 `sudo` 的动作不交审核，直接弹窗。
R5. 审核提示词：系统消息 = 内置策略 + 会话覆盖；用户消息分“可信证据”（用户消息、已解决弹窗的问答）与“不可信上下文”（助手/工具输出摘要，显式标注）；总量超上限截断并留标记。工具输出里的“请批准”类内容不得改变判定流程（由提示词约束，测试验证它被放在不可信段）。
R6. 审核会话不写入用户会话、不占 `seq`；用后释放。
R7. 未注入 `reviewerFactory` 时 `auto` 同 `rules`。
R8. WebUI：档位选择包含自动模式；会话设置可编辑审核策略；审批弹窗注明“审核方拿不准，交由你决定”。
R9. 既有测试不变。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R2、R3 | 假审核方：allow/deny/ask/乱码/抛错/挂起超时 | 变异：乱码或超时当 allow，必须变红 |
| R4、R7 | 敏感路径与 sudo 不调用审核方；无审核方降级 | 变异：敏感路径也交审核，必须变红 |
| R5 | 断言送审文本分段、标注、截断标记；注入文本位于不可信段 | 变异：不可信内容放入可信段，必须变红 |
| R6 | 审核后用户会话事件序列不变 | 是 |
| R1、R8 | REST 与 web 组件测试 | 是 |
| R9 | `scripts/check.sh` | 不适用 |

## Design
`src/permission/review.ts`（构造送审文本、解析判定、超时降级）；`permission/extension.ts` 在规则外分支调用；`ServerOptions.reviewerFactory`。迁移 v5 只加可空列，读侧兼容旧行。

## Risks
模型判断可能出错；上限是“多弹一次窗”或“放行了低风险的误判”，因此硬边界不交模型。
