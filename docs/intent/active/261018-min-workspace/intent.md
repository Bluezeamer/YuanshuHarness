# Intent: 最小 workspace（仅本机）
Author: bluezeamer
Status: accepted
Date: 2026-10-18
Lane: decide
Why: 命中"难逆"——新增持久化表与对外 REST，会话增加 workspace 绑定；权限档位与规则以后都挂在它上面。不是 build 档，因为表结构与接口一经发布就是契约。

## Links
来源: ROADMAP 第 5 条（权限）依赖它；人工提出
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0003](../../../genesis/adr/0003-concept-model.md)、[ADR-0006](../../../genesis/adr/0006-permission-tiers.md)、[ADR-0029](../../../genesis/adr/0029-minimal-workspace.md)
下游: [spec.md](spec.md)、[plan.md](plan.md)

## Problem
权限档位挂在 workspace 上，但仓库里还没有 workspace：会话的 cwd 由注入的工厂随意决定。没有挂靠点，第 5 条的档位与规则无处存放；若先挂在会话上，第 6 条要迁移存量数据。

## Proposed outcome
Server 有本机 workspace 登记：首次启动自动登记启动目录为默认，REST 与 WebUI 可新增、改名、改档位、删除；新建会话选一个 workspace，会话的 cwd 即其路径。

## Out of scope
环境表与 ssh（第 6 条）；会话中途切换 workspace；规则与审批（本变更只存 `tier` 字段，不据此拦截）。

## Constraints
[ADR-0003](../../../genesis/adr/0003-concept-model.md)、[ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md) 的迁移与备份规则。

## Decisions needed
- 最小 workspace 提前到第 5 条：决定 2026-10-18，bluezeamer 确认；ROADMAP 调整记录已写。
- 默认自动登记 + WebUI 可新增：决定 2026-10-18，bluezeamer 确认。

## Open questions
无
