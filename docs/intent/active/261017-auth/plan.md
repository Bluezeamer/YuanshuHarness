# Plan: 访问认证（令牌、来源网段、限流）
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
| `packages/server/src/config.ts` | 新增 `token`、`allowCidrs`；令牌校验的错误信息不回显值；`KNOWN_ENV` 加两项 |
| `packages/server/src/auth.ts`（新） | 令牌解析与常量时间比较、CIDR 解析与匹配、限流表、`onRequest` hook 工厂 |
| `packages/server/src/server.ts` | `start()` 开头做非回环无令牌检查；删除非回环警告，改记认证状态日志；`/api/v1` 路由放进带 hook 的封装作用域；websocket 插件设 `handleProtocols`；`ServerOptions` 加测试专用的限流时钟与数值 |
| `packages/server/test/support/ws-client.ts` | `connect` 支持带令牌（子协议），其余行为不变 |
| `packages/server/src/auth.test.ts`、`config.test.ts`、`server.test.ts`、`src/api/auth.test.ts`（新） | 对应 spec 的 Proof 表；`server.test.ts` 里"非回环警告"用例改为"拒绝启动" |
| `scripts/smoke-image.sh`、`README.md` | 容器必须带 `YUANSHU_TOKEN`；无令牌启动失败的探测；参数表与升级说明 |
| `docs/genesis/ARCHITECTURE.md` | 已随 ADR-0026 更新；实现后核对「数据流」与「边界与约定」是否需补认证位置 |

`scripts/check.sh` 已在跑测试与镜像冒烟，新增用例自动纳入，预计不需要改动。

## Order of work
每一步结束都要 `typecheck` 与相关测试全绿再进下一步；红绿顺序：先写会失败的测试，再实现。

1. **探测，不写生产代码**（结论写进 Deviations，与 spec 假设不符先停下改 spec）：
   (a) `BlockList` 对 `::ffff:a.b.c.d` 与 IPv4 规则、IPv6 规则的比对结果；
   (b) Fastify 的 `onRequest` hook 对 `@fastify/websocket` 升级请求是否在升级之前执行，拒绝时返回的是普通 HTTP 响应；
   (c) `ws` 不设 `handleProtocols` 时是否回显请求里的第一个子协议（确认 R10 的风险真实存在）；
   (d) `req.socket.remoteAddress` 在 IPv4 监听与双栈监听下的形态。
2. **`config.ts`**：先写 R1 的失败用例（含错误信息不含令牌的断言），再实现；变异验证。
3. **`auth.ts` 纯函数**：令牌提取（头与子协议）、常量时间比较、CIDR 解析与匹配、限流表（注入时钟）；单测覆盖 R6、R8、R9、R11、R12，逐个变异验证。
4. **hook 与接线**：封装作用域、hook、`handleProtocols`、`start()` 前置检查与日志；集成测试覆盖 R2–R5、R7、R8、R10、R13；R4 的路由遍历用例，变异验证。
5. **既有测试带令牌重跑**：`sessions.test.ts`、`persist.test.ts` 的服务配置加令牌跑一遍（R13），同时保留一组回环无令牌的用例。
6. **镜像与文档**：`smoke-image.sh` 加"无令牌启动失败"与"有令牌三项探测"；README 参数表、升级说明、令牌推荐用环境变量。
7. **整体回归**：`scripts/check.sh` 全量；手动用 Node 全局 `WebSocket`（子协议带令牌）与 `fetch` 对着真实启动的 Server 跑一遍：无令牌 401、错令牌累计到 429、正确令牌连接并收到快照，把关键输出记入评审记录。
8. **评审**：新开空上下文评审，命中静默信号（限流状态、乱序与重连无关但涉及并发请求计数），至少两轮：一轮盯认证绕过面（路由覆盖、检查顺序、来源判定、子协议回显、日志泄漏），一轮盯限流状态的边界（计数、封禁、过期、容量）与启动检查的副作用顺序。连续三轮仍有阻塞则暂停请你裁决。

## Rollback
- 本期不涉及持久化数据，不改存量数据；revert 本 PR 即回到"非回环只警告"的状态。
- 对外契约变化：新增两个启动参数与三种拒绝响应；此前部署的非回环实例升级后会因缺令牌启动失败，这是有意行为，README 升级说明已写。回退后参数会被旧版本当作未知参数而启动失败，所以回退前要从部署配置里去掉它们。
- 限流状态只在内存，无清理动作。
- 提交粒度：配置与 `auth.ts` 纯函数（步骤 2–3，不接入）与接线（步骤 4–5）、镜像与文档（步骤 6）分开提交。

## Deviations
无
