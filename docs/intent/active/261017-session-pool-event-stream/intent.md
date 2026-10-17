# Intent: 主干（一）会话池与带序号的事件流
Author: bluezeamer
Status: closed
Date: 2026-10-17
Lane: decide
Why: 命中"难逆"——定下对外通信协议（传输层、事件格式、会话标识），客户端一旦依赖就难改；同时命中"静默"（乱序、断线重连、排队），实现阶段按加固处理。不降档：协议是日后所有客户端的契约。

## Links
来源: ROADMAP 第 3 条（主干）的第一块；第 3 条拆为四个 intent：会话池与事件流 → 持久化与恢复 → 认证 → 最小命令行客户端
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0005](../../../genesis/adr/0005-client-protocol.md)、[ADR-0013](../../../genesis/adr/0013-tech-stack.md)、[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)、[ADR-0001](../../../genesis/adr/0001-pi-sdk-no-fork.md)
下游: [spec.md](spec.md)、[plan.md](plan.md)、[review.md](review.md)、[PR #10](https://github.com/Bluezeamer/YuanshuHarness/pull/10)

## Problem
契约测试已证实 pi SDK 的关键行为，但 Server 里还没有任何会话相关代码。后续的持久化、认证、命令行客户端、WebUI 都要挂在"会话池 + 事件流"上，
而 ADR-0005 只定了语义（序号、最近窗口、排队、先答先赢），没有定传输层与线上格式；ADR-0017 明确把传输层留到本步骤。

## Proposed outcome
- Server 内有会话池：创建会话、按标识取会话、驱动 pi agent 循环；多会话在同一进程内互不干扰（无进程全局状态，[ADR-0013](../../../genesis/adr/0013-tech-stack.md)）。
- 每个会话的事件由 Server 打递增序号，推给所有接入的客户端；新接入或重连的客户端先收到最近窗口的状态，再接上实时流；序号出现缺口时客户端能发现并重新拉取。
- 运行中收到的新消息排队，在当前一步结束后送达，所有客户端可见；停止操作从任一客户端有效。
- 一个能说该协议的测试客户端（测试代码内），用于验证上述行为；不是最小命令行客户端，后者是下一批。
- 会话本期仅在内存中，重启即失。

## Out of scope
- 持久化、JSONL 落盘、重启恢复（下一个 intent）。
- 会话的完整管理（删除、重命名、检索等增删改查）：随持久化一并设计，属于下一个 intent 的范围（2026-10-17，bluezeamer 提出）。
- 认证、令牌、来源网段（第三个 intent）；本期端点不设防，只允许默认的本机监听。
- 弹窗（审批、提问）及其"先答先赢"：依赖权限层（ROADMAP 第 5 条）。本期协议的信封须能容纳后续新增的事件类型，但不实现弹窗。
- agent 定义、提示词装配、模型接入向导（第 7 条）：会话创建本期只接受最小参数，见 Open questions。
- 命令行客户端、WebUI。

## Constraints
- 序号仅是每个会话的单调计数器，不保存事件，不用于回放（[ADR-0005](../../../genesis/adr/0005-client-protocol.md)）。
- 单进程多会话，Fastify 实例与插件不承载会话状态，会话池独立于框架（[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)）。
- 只依赖 SDK 公开接口，版本精确锁定（[ADR-0001](../../../genesis/adr/0001-pi-sdk-no-fork.md)）。
- 测试对着本地 stub provider，CI 不调用真实模型（沿用契约测试的做法）。

## Decisions needed
难逆（各出 ADR）：
1. **传输层**：WebSocket、SSE 加 HTTP 命令，或其他。需实测评估 Fastify 对应插件（SSE 插件尚在 0.x，见 ADR-0017）。建议：评估后给出候选，等你拍板。
2. **线上协议与事件信封**：会话标识的形式、事件的公共字段（序号、会话标识、类型）、事件类型清单与命名、客户端到 Server 的命令集（发消息、停止、拉窗口）、缺口时的重新拉取方式。建议：与第 1 条同一份 ADR 定，因为传输层的选择直接约束信封形状。

易逆（推迟到 spec）：最近窗口的条数、排队的具体送达时机的实现、会话池的内部数据结构、错误码细目。

决定（2026-10-17，bluezeamer 确认）：intent、档位与范围同意；两份 ADR 可合并或分开定，由实施者按便利安排。

## Open questions
- ~~本期会话创建需要哪些最小参数~~ 已定：沿用契约测试的 stub provider 配置路径，由测试注入；真实模型接入留给第 7 条。（2026-10-17，bluezeamer 确认）
- pi SDK 里"当前一步结束后送达"对应哪个公开接口（steer / follow-up 一类），实现前读源码确认（spec 阶段）。
