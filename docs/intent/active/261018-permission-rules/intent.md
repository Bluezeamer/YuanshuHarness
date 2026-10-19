# Intent: 权限规则与一档审批（规则审批 / 完全允许）
Author: bluezeamer
Status: accepted
Date: 2026-10-18
Lane: decide
Why: 命中"难逆"（触及权限边界；新增 `permission_rules` 表与 REST）与"静默"（误判会静默放行危险动作或静默拦住正常动作；bash 解析、符号链接、sensitive 路径都是静默点）。

## Links
来源: ROADMAP 第 5 条（权限：三档、规则、只读命令白名单）
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0006](../../../genesis/adr/0006-permission-tiers.md)、[ADR-0030](../../../genesis/adr/0030-permission-rules.md)、[ADR-0029](../../../genesis/adr/0029-minimal-workspace.md)、[ADR-0028](../../../genesis/adr/0028-prompt-wire-protocol.md)
下游: [spec.md](spec.md)、[plan.md](plan.md)、[review.md](review.md)

## Problem
agent 的工具调用现在没有任何拦截，可读写任意路径、执行任意命令。

## Proposed outcome
每次工具调用经权限层：cwd 内读写放行、cwd 外与规则外弹审批（接受/拒绝/通过并记住）、敏感路径永远弹且不可记住、出厂只读命令放行；档位 `full` 全放行。记住的规则按 workspace 存，可查看与删除。

## Out of scope
二档审核模型（[auto-review](../261018-auto-review/intent.md)）；模式（plan）上限；subagent 继承；MCP 的档位归属；ssh 与跨 workspace 传输；输出脱敏。

## Constraints
[ADR-0006](../../../genesis/adr/0006-permission-tiers.md)、[ADR-0030](../../../genesis/adr/0030-permission-rules.md)。

## Decisions needed
记住粒度：文件类按目录、命令按完整命令行：决定 2026-10-18，bluezeamer 确认。

## Open questions
SDK 1.3.0 各工具 `path` 字段与阻断时序，实现时用契约测试确认。
