# Plan: 统一弹窗
Author: bluezeamer
Status: accepted
Date: 2026-10-18

## Links
来源: [spec.md](spec.md)
下游: 实现后回填

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/session/prompts.ts`（新）、`tools.ts`（新）、`pool.ts`、`events.ts` | 弹窗表、`ask_user`、快照与广播 |
| `packages/server/src/api/sessions.ts` | `answer_prompt` 命令 |
| `packages/server/src/client/*` | 命令行显示与 `/answer` |
| `packages/server/test/support/stub.ts` | 工厂接收 `extensions` |
| `packages/web/src/**` | 弹窗 store 与组件，ChatView 接入 |

## Order of work
1. 弹窗表与池（测试先行）。2. 命令与快照。3. `ask_user` 与工厂 `extensions`，用 stub 模型端到端。4. 命令行。5. WebUI。

## Rollback
revert 提交即可；协议增量只增不改，无数据迁移。

## Deviations
无
