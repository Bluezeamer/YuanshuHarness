# Intent: WebUI 对话与停止
Author: bluezeamer
Status: active
Date: 2026-10-17
Lane: build
Why: 改动操作流式事件、排队队列与重连，命中"事件时序、队列、并发乱序"静默信号，按 hardening.md 需要失败先行、独立评审与真实运行验证。不涉及存储形状变更和外部契约（WebSocket 子协议与帧类型已由 ADR 定稿，本 intent 只在客户端实现），所以不是决策档。

> 位置：`docs/intent/active/261017-webui-conversation/intent.md`。需求正文只在 [spec.md](spec.md)，本文件不重复。

## Links
来源: ROADMAP 第 4 条（WebUI 基础）的一块
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0020](../../../genesis/adr/0020-transport-websocket.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)；继承 [261017-webui-skeleton](../261017-webui-skeleton/intent.md) 的分支与产物
下游: [spec.md](spec.md)

## Problem

skeleton 只做到会话列表。用户选中会话后看不到对话内容，也不能发消息、停止运行，连接断了只能刷新页面。

## Proposed outcome

选中会话后，主区显示历史消息与实时流；用户可以发送（运行中进入服务端队列）、停止、向上加载更早的历史；连接中断时自动重连，重连不成功再给手动按钮。发送没被确认送达时，输入不会丢。

## Out of scope

- 图片上传或粘贴、消息编辑 / 删除 / 再生成（ROADMAP 未规划）
- 会话创建、重命名（后续 intent）
- 无限滚动式的自动翻页；加载更早只用按钮触发

## Constraints

- 子协议 `yuanshu.v1` 加 `bearer.<token>`，首帧必须是快照，序号跳号发 `resync`（ADR-0020、0021）
- 客户端必须忽略未知的事件类型与载荷字段（ADR-0021）
- 历史接口 `GET /api/v1/sessions/:id/messages?limit&before`，游标是严格上界，序位只增不变（ADR-0024）
- 令牌错误计入限流：同一来源连续失败 10 次封 60 秒，封的是该来源的全部 `/api/v1`（ADR-0026，`auth.ts`）。浏览器的 WebSocket 看不到握手的 401，自动重连不能盲目重试。

## Decisions needed

已决（确认人 bluezeamer）：

- 历史与快照的拼接（2026-10-17，方案 1）：以快照为准；快照窗口无序位，靠 HTTP 页尾逐条比对来对齐，错位则重取，3 次失败降级为只显示窗口并提示。
- 向上翻页（2026-10-18，选项 A）：顶部有未加载的更早内容时显示"加载更早"按钮，点击取下一页。不做自动翻页。
- 历史累积而非替换（2026-10-18）：重新对齐（`resync`、重连后的新快照）时，已加载的历史必须保留并合并，不得被新快照的窗口替换。
- 自动重连（2026-10-18）：按原 intent，间隔 3 秒、最多 5 次，期间显示"正在重连…"，失败后显示"连接已断开"与手动按钮。每次重试前先用带令牌的 REST 请求探一次：401 回令牌页，429 提示等待并停止，403 提示并停止，其余才重连 WebSocket。
- 运行中可发送（2026-10-18）：服务端会排队（ADR-0005、0021），输入框与发送按钮运行中不禁用；原 intent "运行中禁用输入框"作废。
- 发送失败保留输入（2026-10-18）：回执失败或连接断开时未确认的发送，原文放回输入框。
- 草稿按会话保留（2026-10-18，确认人 bluezeamer）：切换会话再切回，输入框里的内容不丢；切换时未确认的发送放回原会话的草稿。

## Open questions

无
