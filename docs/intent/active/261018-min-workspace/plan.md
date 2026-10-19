# Plan: 最小 workspace
Author: bluezeamer
Status: accepted
Date: 2026-10-18

## Links
来源: [spec.md](spec.md)
下游: 实现后回填

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/store/db.ts` | 迁移 v3 |
| `packages/server/src/store/workspaces.ts`（新）、`store/sessions.ts` | workspace 存取、会话 `workspace_id` |
| `packages/server/src/api/workspaces.ts`（新）、`api/sessions.ts`、`server.ts` | REST 与默认登记接线 |
| `packages/server/src/session/pool.ts`、`test/support/stub.ts` | 工厂 `cwd` |
| `packages/web/src/sessions/*`、`Shell.tsx` 相关 | workspace 选择与设置 |

## Order of work
1. 迁移与存取（测试先行）。2. REST。3. 池与工厂 `cwd`。4. WebUI。

## Rollback
revert 该变更的提交；已迁移到 v3 的库会被旧程序拒绝启动，回退前用 `yuanshu.db.bak-v2` 还原。

## Deviations
无
