# Intent: 统一弹窗（prompt.* 帧与 agent 提问）
Author: bluezeamer
Status: accepted
Date: 2026-10-18
Lane: decide
Why: 命中"难逆"——`prompt.*` 事件与 `answer_prompt` 命令是对外协议，所有客户端依赖；同时命中"静默"（多端先答先赢、超时与撤销、无人在线时补发）。

## Links
来源: ROADMAP 第 5 条（统一弹窗）
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0005](../../../genesis/adr/0005-client-protocol.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0028](../../../genesis/adr/0028-prompt-wire-protocol.md)
下游: [spec.md](spec.md)、[plan.md](plan.md)

## Problem
服务端没有弹窗帧（ADR-0021 只预留命名空间）；agent 无法向用户提问；将来的审批没有通路。

## Proposed outcome
会话池支持待处理弹窗：发出、先答先赢、超时、撤销、重连补发。agent 有 `ask_user` 工具。WebUI 在对话里弹出提示并作答，命令行客户端也能作答。审批（下一个变更）复用这条通路。

## Out of scope
权限审批本身（[permission-rules](../261018-permission-rules/intent.md)）；保密输入（密码）；IM 渠道。

## Constraints
[ADR-0028](../../../genesis/adr/0028-prompt-wire-protocol.md)；WebUI 样式遵循 `yuanshu-webui-style`。

## Decisions needed
超时 30 分钟、Server 常量：决定 2026-10-18，bluezeamer 确认。

## Open questions
无
