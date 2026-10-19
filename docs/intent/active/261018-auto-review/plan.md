# Plan: 二档自动模式
Author: bluezeamer
Status: accepted
Date: 2026-10-18

## Links
来源: [spec.md](spec.md)
下游: 实现后回填

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/permission/review.ts`（新）、`extension.ts` | 送审、解析、降级 |
| `packages/server/src/store/db.ts`、`store/sessions.ts`、`api/sessions.ts`、`server.ts` | 迁移 v5、`reviewPolicy`、`reviewerFactory` |
| `packages/web/src/**` | 档位与审核策略设置 |

## Order of work
1. 解析与降级的纯逻辑。2. 送审文本构造。3. 接入扩展，假审核方端到端。4. 迁移与 PATCH。5. WebUI。

## Rollback
revert 提交；v5 库用 `.bak-v4` 还原。只加可空列。

## Deviations
无
