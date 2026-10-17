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
- 2026-10-17 步骤 1 的探测结论（SDK 1.3.0，stub provider，一次性探针，已删除）：
  - `agent_settled` 在正常（`aborted:false`）、abort（`aborted:true`）、provider 报错三种结局下都会触发，`prompt()` 在三种情况下都 resolve，不抛错。
  - provider 返回 500 时，SDK 默认自动重试 3 次（共 4 次请求，间隔有退避），其间会重复出现 `agent_start`/`agent_end{willRetry:true}`/`auto_retry_start`，最终 `agent_end{willRetry:false}` 后才 `agent_settled`。失败只体现在最后一条助手消息上（`stopReason:"error"`、`errorMessage`）。
  - 对 spec 的影响（不改 Requirements，只改实现方式）：
    - `run.started` 由池在"空闲→运行"转换时发一次，`run.ended` 在 `agent_settled` 时发一次；重试期间多次 `agent_start` 不重复发 `run.started`。
    - R6 的 `run.failed` 不靠 `prompt()` 抛错，而是在 `agent_settled` 时检查最后一条助手消息，`stopReason === "error"` 则在 `run.ended` 之前下发 `run.failed { message: errorMessage }`。`prompt()` 真抛错时同样兜底下发。
    - 测试里用 `SettingsManager.inMemory` 关闭重试，避免失败用例等退避。
  - `steer` 已确认：运行中调用立即 resolve，返回前触发 `queue_update`（steering:["two"]）；当前助手轮结束后、下一次模型调用之前送达，随后 `queue_update` 变空；stub 共收到 2 次请求，与 spec 一致。
  - SDK 会发出 `role:"system"` 的 `message_start/end`；`message.*` 只映射 `user` 与 `assistant` 两种角色，其余角色（含 system、toolResult）不下发。
- 2026-10-17 步骤 4：
  - 快照的全部状态（最近窗口、`partial`、`activeTools`、`queue`、`running`）由池自己从同一条事件流累积，不读 `session.messages`，这样快照与 `seq` 构造上一致；窗口初始为空，持久化 intent 加载历史时再从 JSONL 播种。
  - 探测发现：模型配置的 `input` 不含 `image` 时，SDK 把图片悄悄换成"(image omitted: model does not support images)"，不报错。已在 `send` 里拒绝并补进 spec R9；这是静默类问题，评审时重点复核。
  - 变异验证已做（改坏后对应用例变红，还原后全绿）：广播先于状态更新、吞掉 `run.failed`、排队改直插、不拒绝不支持的图片、`dispose` 不清订阅、快照不含 `partial`。
- 2026-10-17 步骤 5/6：
  - `@fastify/websocket` 锁 11.3.4；测试用的 `ws` 8.22.0 与 `@types/ws` 8.18.2 作为 devDependencies 精确锁定（前者原本只是传递依赖）。
  - 服务停止顺序实现为 Fastify 的 `preClose` 钩子：先关全部 WebSocket，再 `pool.dispose()`，然后 HTTP 关闭；`@fastify/websocket` 自带的 preClose 也会关连接，所以客户端看到的关闭码是 1005 而非 1001，测试不断言具体码。
  - R14 的实测发现：背压只检查"写入前的积压"，所以一个本身很大的帧（例如全文很长的 `message.ended`）会让紧接着的下一帧触发关闭，健康的客户端也一样。单个回复远小于 4 MiB 的正常使用不受影响；测试用多轮累积 700KB 的回复来区分快慢连接。评审时复核这一取舍。
  - 变异验证（API 层）：去背压检查、关闭不清订阅、不要求 id、resync 不回快照、心跳不断开、停止时不释放池、升级前不查会话，均有用例变红。"停止时不释放池"最初无人发现，已补 R15 断言（会话 dispose 次数）。
  - 手动：用 Node 内置全局 `WebSocket` 对着真实 `createServer` 跑完整会话，序号 0（快照）、1..7 连续，`ack` 不占序号。`scripts/check.sh` 全绿。
- 2026-10-17 评审第 1、2 轮后的变更（均已在 review.md 记录）：命令按连接串行；背压改为"已排队 + 本帧"硬上限，代价是单帧超 4 MiB 的连接会被断开；入站待处理字节与 images 数量设上限；stop() 等待连接真正关闭；base64 校验。spec R9/R11/R14/R15 相应补充。
- 2026-10-17 PR #10 讨论后追加（bluezeamer 确认）：背压“单帧超 4 MiB 即断开”会让含大工具结果的会话重连即断、永远连不上，属缺陷。改为：载荷截断（R16）加“仅有积压时才按阈值断开”（R14）。变异验证：不截断事件、不截断快照、空队列也限制，均变红。
