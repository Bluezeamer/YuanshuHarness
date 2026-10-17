# Spec: 会话池与带序号的事件流
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> 写成 delta：只写本次变更相对既有约定新增或改变了什么。端点、信封、命令集、缺口处理已在 [ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)，传输层在 [ADR-0020](../../../genesis/adr/0020-transport-websocket.md)，此处只链接，补的是 ADR 留给 spec 的细节。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0005](../../../genesis/adr/0005-client-protocol.md)、[ADR-0020](../../../genesis/adr/0020-transport-websocket.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0013](../../../genesis/adr/0013-tech-stack.md)、[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)
下游: plan.md、PR 定稿后回填

## Requirements

**会话池**
R1. 会话池由一个注入的"会话工厂"创建会话；池不持有 Fastify 实例，也不读取任何进程全局状态（环境变量、工作目录、模块级单例）。同一进程内两个会话互不可见：A 的事件不得出现在 B 的连接上，A 的排队不得影响 B。
R2. `POST /api/v1/sessions` 返回 201 与 `{ id, createdAt }`；`GET /api/v1/sessions` 返回 `{ sessions: [{ id, createdAt, running }] }`；`GET /api/v1/sessions/:id` 返回单个条目，不存在返回 404。
R3. 未配置会话工厂时（真实的 `yuanshu serve` 在第 7 条之前就是这种状态），`POST /api/v1/sessions` 返回 501 与 `{ error: "no_session_backend" }`，不得返回成功。

**事件与序号**
R4. 每个会话的事件序号从 1 起，逐条加 1，不跳、不重。会话的所有连接收到的同一事件序号相同。`ack` 不占序号。
R5. SDK 事件按下表映射为 Server 事件；表外的 SDK 事件不下发。映射在会话池内完成，连接层与客户端不接触 SDK 事件类型。

| SDK 事件 | Server 事件 | `data` |
|---|---|---|
| `agent_start` | `run.started` | `{}` |
| `agent_settled` | `run.ended` | `{ aborted }` |
| `message_start` / `message_end` | `message.started` / `message.ended` | `{ role, text }`（`text` 为各文本块拼接，不含工具调用块） |
| `message_update`（文本或思考增量） | `message.delta` | `{ kind: "text" \| "thinking", text }` |
| `tool_execution_start` / `_update` / `_end` | `tool.started` / `tool.updated` / `tool.ended` | `{ toolCallId, toolName, ... }`，`_end` 另有 `isError` |
| `queue_update` | `queue.updated` | `{ queue: string[] }`（steering 在前、follow-up 在后；SDK 总是先送达 steering，所以这就是送达顺序，本期只产生 steering） |

R6. 一次运行失败（`prompt` 抛错或 `agent_settled` 之前出现不可恢复错误）时，必须下发 `run.failed`，`data` 为 `{ message }`；不得吞掉，也不得让连接断开。

**快照与衔接**
R7. 连接建立后的第一条消息必须是 `snapshot`，`data` 为：`{ messages: [{ role, text }]（最近 50 条）, running, activeTools: [{ toolCallId, toolName }], partial: { role, text } | null（正在流式生成的消息）, queue: string[] }`，信封的 `seq` 为快照对应的序号。之后的事件序号必须从快照 `seq` + 1 起连续，快照与首个事件之间不得丢事件、不得重复。
R8. 对某会话的任意连接发 `resync`，必须收到新的 `snapshot`，之后事件从其 `seq` + 1 续上。

**命令**
R9. `send_message { text, images? }`，`images` 为可选数组，元素 `{ mimeType, data }`，`data` 为 base64，原样交给 SDK 的图片入参。会话空闲时开始一次运行；运行中则排队，在当前一步结束后、下一次调用模型之前送达，并下发 `queue.updated`，所有连接可见。`text` 为空或仅空白，返回 `ack` 失败 `bad_request`，不入队；有图而无文字同样需要 `text` 非空。当前模型不支持图片输入（模型配置的 `input` 不含 `image`）时，带图的消息必须被拒绝（`bad_request`），不得放行：SDK 对此不报错，只会把图片悄悄换成一句占位文字。事件与快照里不携带图片字节，只携带文字。
R10. `stop`：任一连接发出都生效，中止当前运行；会话空闲时为空操作并返回 `ack` 成功。
R11. 每个命令必须得到恰好一个 `ack`，带原 `id`。非法 JSON、缺 `id`、未知命令类型，返回 `ack` 失败（`bad_request` / `unknown_command`）或在无 `id` 时返回无 `id` 的失败 `ack`，连接保持。客户端发来的单条 WebSocket 消息上限为 50 MiB（含 base64 的图片，按 10 张约 100 万像素的 PNG、单张最多 25 MB 估算，base64 膨胀约 33%），超过则关闭连接（1009）。同一连接已收到但尚未处理完的字节超过 50 MiB 时关闭连接（1013）；`images` 最多 20 项。

**连接健壮性**
R12. 对不存在的会话发起 stream 升级，返回 404，不建立 WebSocket。
R13. Server 每 30 秒发一次协议层 ping；10 秒内无 pong 则断开该连接并释放订阅。连接关闭后不得再向其写入，也不得泄漏订阅。
R14. 某连接已有积压时，积压加上即将写入的这一帧超过 64 MiB，Server 不写入、直接关闭它（1013）；客户端重连后会得到新的快照。发送队列为空时允许写入一整帧（帧本身由 R16 保证有界），所以内存上界是“阈值加一帧；64 MiB 是针对慢客户端的内存上界，单用户连接数很少，总开销有限”。慢客户端不得拖慢或阻塞同一会话的其他连接，也不得使 Server 内存无限增长。
R16. 事件与快照的载荷必须有界：事件 `data` 中任一字符串超过 256 KiB 则截断，快照中每条消息、`partial` 的文本超过 32 KiB 则截断；发生截断时所在 `data` 顶层带 `truncated: true`。数组与对象最多保留 200 项、键最多 256 字符，嵌套深度超过 8 层的部分、Buffer 等非普通对象以 null 代替并同样标记；截断不得切开代理对。以上各自有界但乘起来仍可能很大，所以序列化后单帧 `data` 超过 1 MiB 时只保留短的标量字段，并带 `truncated: true, omitted: true`。快照里的消息只含 `role` 与 `text`。因此任何会话都能被重新连上，不会因历史里有大工具结果而“一连就断”。全文的按需拉取随持久化 intent 提供。
R15. Server 停止时，先关闭所有 WebSocket 连接（等待其关闭完成，对端不配合时 1 秒后强制终止）并释放全部会话，再关闭 HTTP 服务；`stop()` 返回后进程内不得残留会话订阅或定时器。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | 池单测：两会话并行，各自的连接只收到各自事件；静态检查（测试内 grep）池模块不引用 `process.env`、`process.cwd`、模块级可变状态 | 变异：把事件广播改成全局订阅者表，隔离测试必须变红 |
| R2、R3 | 集成测试（Fastify inject） | 是（端点不存在） |
| R4、R5 | 对 stub provider 跑一次完整对话，收集事件，断言序号为 1..N 连续且映射正确；两连接收到的事件逐条相等 | 变异：映射处丢掉一个事件而不加序号 / 多个连接各自计数，测试必须变红 |
| R6 | stub 返回 500，断言收到 `run.failed`，连接仍开 | 变异：吞掉错误，必须变红 |
| R7 | 在一次运行进行中（stub 延迟返回）新连接，断言首条为 `snapshot` 且 `partial`/`running` 正确，其后事件与快照 `seq` 连续；循环 N 次并发连接与事件，检查无缺无重 | 变异：先订阅再发快照 / 先发快照再订阅，各自必须被检出缺口或重复 |
| R8 | 人为让测试客户端跳过若干事件，发 `resync`，断言新快照与后续连续 | 是 |
| R9 | stub 延迟返回，运行中发第二条，断言：`queue.updated` 到达所有连接；第二条在第一步结束后才出现在发给 stub 的请求里（读 stub 记录的请求体）；空白文本被拒；带一张小图的消息，图片出现在发给 stub 的请求体里；模型不支持图片时被拒、且没有模型请求；R11 的大小上限用略大于 50 MiB 的消息验证 | 变异：运行中直接丢弃第二条 / 立即插入，必须变红 |
| R10 | 运行中从另一连接发 `stop`，断言 `run.ended { aborted: true }`；空闲时 `ack` 成功 | 是 |
| R11 | 逐项发非法输入，断言 `ack` 内容且连接仍可用；超大消息断开 | 是 |
| R12 | 对不存在会话做升级，断言 404 | 是 |
| R13 | 使用假定时器或可调间隔，测试客户端不回 pong，断言被断开且池中订阅数归零 | 变异：不清订阅，必须变红 |
| R14 | 客户端暂停读取并让 stub 产生大量输出，断言该连接被以 1013 关闭，同一会话另一连接不受影响，Server 内存增长有界 | 变异：去掉积压检查，必须变红 |
| R16 | 8 MiB 回复：`message.ended` 被截断并标记、连接保持；新连接快照被截断且连得上；空队列时单帧大于阈值不断开 | 变异：不截断事件 / 不截断快照 / 空队列也限制，均必须变红 |
| R15 | 启动、连接若干客户端、`stop()`；断言所有连接已关、池为空、无活动句柄 | 是 |
| 全部 | 并入 `scripts/check.sh`，CI 运行；测试对着本地 stub provider，不依赖真实模型 | 不适用 |

## Design
沿用既有架构，只列新增部分。

- **模块边界**：`src/session/pool.ts`（会话池：创建、取、广播、序号、映射、快照）、`src/session/events.ts`（SDK 事件到 Server 事件的映射，纯函数）、`src/api/sessions.ts`（REST 与 WebSocket 路由，只做协议编解码，不含会话状态）。路由通过 `ServerOptions` 里的会话工厂接入，池与 Fastify 解耦（[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)）。
- **会话工厂**：`() => Promise<AgentSession>`，由调用方提供。测试里用 stub provider 的工厂（复用 `test/contract/harness.ts` 的思路，移到测试共享位置）。真实 `yuanshu serve` 本期不提供，见 R3。
- **排队**：运行中使用 SDK 的 `prompt(text, { streamingBehavior: "steer" })`，其语义是当前助手轮的工具调用执行完后、下一次调用模型之前送达，与 [ADR-0005](../../../genesis/adr/0005-client-protocol.md) 的"当前一步结束后"一致。是否有更合适的接口，plan 阶段读源码并用契约式测试确认。
- **序号与快照的原子性**：Node 单线程，序号分配、广播、快照构造都是同步操作；快照在同一个同步段里构造并写入连接后才登记订阅，保证首个事件序号等于快照 `seq` + 1。
- **入站上限**：`@fastify/websocket` 的 `maxPayload` 设为 50 MiB。这是上限而不是预分配，只有真的收到大消息才占内存；客户端可自行压缩或转格式以减小体积。
- **背压**：写前检查 `bufferedAmount`，有积压且超限即关闭连接，不排队缓冲；载荷截断见 R16。
- **新依赖**：`@fastify/websocket`，精确锁定版本，随 Fastify 的锁定一并核对安全公告（[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)、[ADR-0020](../../../genesis/adr/0020-transport-websocket.md)）。
- **迁移与兼容**：无存量数据；会话仅在内存。`/api/v1` 是本期首次发布的契约，此前不存在旧形状。`/healthz` 不变。

## Risks
- 图片不进事件与快照：重连后的客户端看不到先前发送的图片字节，只看到文字。图片的保留与回看随持久化 intent 处理（JSONL 里有原始内容）。
- 会话的删除、重命名、检索（完整的增删改查）不在本期：ADR-0021 的端点是只增不改的，新增 `DELETE`/`PATCH` 属于追加，与会话的持久化生命周期一并设计，放在下一个 intent，见 intent 的 Out of scope。
- 会话只增不删（没有删除命令，ADR-0021 未列），内存占用随创建次数增长。单用户、重启即清，本期接受；持久化 intent 里与会话生命周期一并处理。
- `agent_settled` 是否在所有失败路径上都会触发，依赖 SDK 行为；R6 的测试覆盖 provider 返回错误的情形，其余失败路径靠评审与 plan 阶段读源码补。
- 思考增量（`kind: "thinking"`）是否应下发给所有客户端，本期默认下发，由客户端决定是否展示；若后续需要隐藏，属于新增字段而非改动。
- 无认证：端点默认只监听回环地址（[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)），配置为非回环时已有启动警告，认证落地前这是已知暴露面。
