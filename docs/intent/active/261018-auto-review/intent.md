# Intent: 二档自动模式（审核模型）
Author: bluezeamer
Status: accepted
Date: 2026-10-18
Lane: decide
Why: 命中"难逆"（新增会话字段 `review_policy` 与 PATCH 契约）与"静默"（模型判定错误会静默放行危险动作；超时/出错/拿不准必须降级为人工）。

## Links
来源: ROADMAP 第 5 条（自动审批与审核模型）
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0006](../../../genesis/adr/0006-permission-tiers.md)、[ADR-0031](../../../genesis/adr/0031-auto-review.md)、[ADR-0030](../../../genesis/adr/0030-permission-rules.md)
下游: [spec.md](spec.md)、[plan.md](plan.md)、[review.md](review.md)

## Problem
一档下规则外动作都要人点，长任务决策疲劳。

## Proposed outcome
档位 `auto` 的 workspace 里，规则外动作先交独立审核会话判定：放行则执行，拒绝则理由回 agent，拿不准/超时/出错弹给用户。会话可设审核策略覆盖。

## Out of scope
模型配置与接入向导（第 7 条）：审核方通过注入接入，真实 `yuanshu serve` 暂无审核模型，`auto` 退化为一档；全局策略追加；审核方用工具补查上下文。

## Constraints
[ADR-0031](../../../genesis/adr/0031-auto-review.md)；敏感路径与 sudo 类动作不交模型。

## Decisions needed
无（口径已在 ADR-0031）。

## Open questions
无
