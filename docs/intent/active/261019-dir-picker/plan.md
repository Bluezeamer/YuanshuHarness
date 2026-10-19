# Plan: 目录选择器
Author: bluezeamer
Status: accepted
Date: 2026-10-19

## Links
来源: [spec.md](spec.md)
下游: 实现后回填

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/api/fs.ts` + 测试 | 目录浏览路由 |
| `packages/server/src/server.ts` | 注册路由 |
| `packages/web/src/api.ts` | `listDirs` |
| `packages/web/src/settings/DirPicker.tsx` + 测试 | 选择器 |
| `packages/web/src/settings/NewSession.tsx`、`WorkspacesPanel.tsx` | 复用选择器 |

## Order of work
1. 服务端测试（先红）→ 路由
2. web `listDirs` → `DirPicker` 测试 → 组件
3. 接入 NewSession 与 WorkspacesPanel
4. `scripts/check.sh`，浏览器验证，独立评审

## Rollback
revert 提交即可：无迁移、无新持久化数据。

## Deviations
无
