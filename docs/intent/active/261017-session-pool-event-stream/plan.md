# Plan: 会话池与带序号的事件流
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> plan 是活的：实现中偏离计划，写进 Deviations，与对应代码同一次提交，无需重新审批。
> 只有偏离触及 spec 的 Requirements 时才回头改 spec。

## Links
来源: [spec.md](spec.md)
下游: 实现后回填 PR

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/package.json`、`pnpm-lock.yaml` | 新增 `@fastify/websocket`，精确版本（先核对 11.3.4 与 Fastify 5.12.7 的兼容与公告） |
| `packages/server/src/session/events.ts`（新） | SDK 事件到 Server 事件的纯函数映射，含 `message` 文本抽取 |
| `packages/server/src/session/pool.ts`（新） | `SessionPool`：工厂注入、会话条目（序号、订阅者集合、快照构造）、命令（发送、停止）、`dispose` |
| `packages/server/src/api/sessions.ts`（新） | Fastify 插件：REST 三个端点、stream 升级、命令编解码与 `ack`、心跳、背压、`maxPayload` |
| `packages/server/src/server.ts` | `ServerOptions` 增加 `sessionFactory?`；注册 websocket 插件与 sessions 插件；`stop()` 先关连接与池再 `app.close()` |
| `packages/server/test/support/stub.ts`（新） | 从 `test/contract/harness.ts` 抽出 stub provider、`makeEnv`、`writeModels` 与会话工厂，契约测试改为从这里导入（行为不变） |
| `packages/server/test/support/ws-client.ts`（新） | 测试用协议客户端：收集信封、检查序号连续、发命令等 `ack` |
| `packages/server/src/session/*.test.ts`、`src/api/*.test.ts`（新） | 对应 spec 的 Proof 表，每条需求一组用例，含变异验证 |
| `docs/genesis/ARCHITECTURE.md` | 「数据流」「边界与约定」补会话池与协议实现位置，演进记录一条 |

`scripts/check.sh` 已在跑 `pnpm test`，新增测试自动纳入，预计不需要改动。

## Order of work
每一步结束都要 `typecheck` 与相关测试全绿再进下一步；红绿顺序：先写会失败的测试，再实现。

1. **读源码定映射与排队**（不写生产代码）：读 `AssistantMessageEvent` 的增量种类、`AgentMessage` 的内容块结构，写一个契约式小测试确认 (a) `agent_settled` 在正常、abort、provider 报错三种结局下都触发；(b) 运行中 `prompt(..., { streamingBehavior: "steer" })` 的送达时机与 `queue_update` 事件；(c) 空闲时调用返回的 Promise 何时 resolve。结论写进 Deviations（若与 spec 假设不符，先停下回头改 spec）。
2. **抽出测试支撑**：把 stub 与工厂移到 `test/support/`，契约测试改 import，全量跑契约测试确认零变化。
3. **`events.ts`**：映射表的纯函数与单测（含表外事件被丢弃、思考增量、工具块不进 `text`）。
4. **`pool.ts`**：会话条目、序号分配、订阅与快照的同步原子段、`send`/`stop`、`run.failed` 兜底、`dispose`。池的单测覆盖 R1、R4–R7、R9、R10、R15，附变异验证（逐个做，确认变红后还原）。
5. **依赖与路由**：加 `@fastify/websocket`；`sessions.ts` 实现 REST 与 stream；`server.ts` 接线。集成测试覆盖 R2、R3、R8、R11–R14，同样做变异验证。
6. **整体回归**：`scripts/check.sh` 全量；手动用 Node 全局 `WebSocket` 对着 stub 跑一遍完整会话，把关键输出记入评审记录。
7. **文档**：更新 ARCHITECTURE；本 plan 的 Deviations 补全。
8. **评审**：新开空上下文评审（命中静默信号，至少两轮，评审者各带不同视角：一轮盯序号与快照的衔接和连接生命周期，一轮盯背压、输入校验与安全）。

## Rollback
- 本期不涉及持久化数据与存量迁移，会话只在内存，回退没有数据后果。
- 对外契约（`/api/v1` 端点与事件格式）此前不存在，没有已发布客户端依赖；实现合并后若发现协议缺陷，在 `v1` 内只增不改，必须破坏时升 `v2`，不回改已发布字段。
- 代码层面整个变更在一个 PR 内，出问题 revert 该 PR 即可恢复到"只有 `/healthz` 与静态托管"的状态；因为 R3，未配置工厂的 Server 对外没有新增可用功能，暴露面只多出两个会返回 501/404 的路径。
- 唯一的新依赖 `@fastify/websocket` 随 revert 一并撤掉，锁文件同步回退。
- 步骤 2 的测试支撑抽取是纯重构，独立成提交，出问题可单独撤回。

## Deviations
无
