# Plan: 权限规则与一档审批
Author: bluezeamer
Status: accepted
Date: 2026-10-18

## Links
来源: [spec.md](spec.md)
下游: 实现后回填

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/permission/*`（新） | 判定、bash 分词、路径解析、扩展 |
| `packages/server/src/store/db.ts`、`store/rules.ts`（新） | 迁移 v4、规则存取 |
| `packages/server/src/api/workspaces.ts`、`session/pool.ts` | 规则 REST、扩展接线 |
| `packages/server/test/contract/*` | SDK 工具字段与阻断时序 |
| `packages/web/src/**` | 审批弹窗内容、规则与档位设置 |

## Order of work
1. 契约测试确认 SDK 行为（失败先行）。2. 纯逻辑判定与分词（表驱动）。3. 扩展与池接线，stub 端到端。4. 规则 REST。5. WebUI。

## Rollback
revert 提交；v4 库会被旧程序拒绝启动，用 `.bak-v3` 还原。回退后工具调用不再被拦截，这是已知退路代价。

## Deviations
无
