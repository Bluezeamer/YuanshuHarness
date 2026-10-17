# Plan: 最小命令行客户端
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> plan 是活的：实现中偏离计划，写进 Deviations，与对应代码同一次提交，无需重新审批。
> 只有偏离触及 spec 的 Requirements 时才回头改 spec。

## Links
来源: [spec.md](spec.md)
下游: 实现 PR 合并后回填

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/cli.ts` | `Deps` 增加可选 `stdin`；`serve` 之外的子命令分派到 `client/`；`serve` 分支不动 |
| `packages/server/src/config.ts` | 只在子命令名识别处放行三个新子命令；`serve` 的解析与校验不动 |
| `packages/server/src/bin.ts` | 传入 `stdin: process.stdin` |
| `packages/server/src/client/options.ts`（新） | 客户端参数与环境解析：`--url`、`YUANSHU_URL`、`YUANSHU_TOKEN`（纯函数） |
| `packages/server/src/client/http.ts`（新） | `fetch` 封装；状态码到一行原因；`attach` 前的预检 |
| `packages/server/src/client/render.ts`（新） | 帧到文本，纯函数 |
| `packages/server/src/client/stream.ts`（新） | WebSocket、序号校验、`resync`、命令与 `ack` 配对 |
| `packages/server/src/client/attach.ts`（新） | 输入行、流、渲染接起来；EOF 与 Ctrl-C |
| `packages/server/src/client/*.test.ts`、`cli.test.ts` | 按 spec Proof 表 |
| `scripts/smoke-package.sh` | 增加 `yuanshu sessions` 对着已启动的包做一次 |

## Order of work
1. **探测（已完成，见 Deviations）**：Node 24 全局 `WebSocket` 在升级成功后暴露协商出的 `protocol`，关闭事件带 `code`、`reason`、`wasClean`；升级被拒（非 101）只给无信息的 `error` 与 1006，拿不到 HTTP 状态码。
2. `options.ts` 与 `cli.ts` 分派：先写 R1、R2 的测试（含令牌不外泄），再实现；`serve` 既有用例保持全绿。
3. `http.ts`：`sessions`、`new` 与 R3 的五种状态码；`attach` 前用 `fetch` 带 `Authorization` 预检 `GET /api/v1/sessions/:id`，被拒的原因由预检给出。
4. `render.ts` 纯函数：快照到文本（消息、`partial`）、各事件到文本；先写测试。
5. `stream.ts`：序号校验与 `resync`（R7）。这是静默类需求，先写中间代理的丢帧、重复、乱序用例，再实现，并做变异验证。
6. `attach.ts`：输入行、`ack`、EOF、Ctrl-C、关闭码（R8–R10）。
7. 并入 `scripts/check.sh`（已跑全部测试，无需改动）与 `smoke-package.sh`。
8. 评审：新开空上下文 subagent，命中静默信号，多轮到无阻塞；变异结果写进 `review.md`。

## Deviations
- 2026-10-17 步骤 1 探测结论：升级被拒拿不到状态码，所以 R3 在 `attach` 上靠预检实现。这是实现路径，不改 Requirements；Risks 里的"改用 `ws`"评估为不需要，不新增依赖。
