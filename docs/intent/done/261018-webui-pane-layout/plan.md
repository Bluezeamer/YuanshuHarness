# Plan: WebUI 多 pane 布局
Author: bluezeamer
Status: closed
Date: 2026-10-18

> 补写：实现先于本文件进行，G4（代码生成前审 plan）当时被跳过；本文按已发生的顺序如实记录，请人补确认。

## Links
来源: [spec.md](spec.md)
下游: 实现后回填：合并 PR 链接

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/store/workbench.ts`、`api/workbench.ts`、`server.ts`、`store/db.ts` | workbench 与 saved-layouts 存储和路由，迁移加一版（R18、R19） |
| `packages/web/src/layout/*` | 树、文档、注册表、pane 层、Workbench、拖动、侧栏、已存布局（R1–R10、R13、R14、R16、R17、R20–R24） |
| `packages/web/src/sessions/*`、`useConversation.ts` | 按会话共享的 store 与引用计数（R11、R12） |
| `packages/web/src/api.ts`、`fakes.ts`、`Shell.tsx`、`ChatView.tsx` | 请求函数、测试假件、会话选中进布局、锚点上报 |

## Order of work
1. Server：迁移、存储、路由与集成测试。
2. 纯函数：`tree.ts`、`doc.ts`、注册表，先写测试。
3. pane 层与 Workbench（平铺定位、window 栏、分割线）；R3 的挂载计数测试。
4. 会话 store 与镜像（R11、R12），保留 conversation 既有用例。
5. 持久化：防抖、`pagehide`、409、高版本只读（R17、R20、R21）。
6. 输入导航与响应式侧栏、`Alt+方向键`、pointer 拖动、已存布局。
7. 真实浏览器验证（[browser-verify.md](browser-verify.md)），再独立评审。

## Rollback
- 迁移前若库里已有数据，会复制数据库文件作备份，每步一个事务，失败回滚（`store/db.ts`，R19）。`user_version` 加一后旧版本服务端会因版本过新拒绝打开，所以回退服务端需要恢复备份文件，这一点未实测。
- Web 回退：布局存在服务端 `workbench` 文档里，旧版 Web 不读它；回退后会话选中退回 `Shell` 的 `useState`，不丢会话数据。
- 布局文档带 `version`，高版本文档只读展示、不覆盖（R20），所以新旧 Web 共用同一服务端时不会互相写坏。

## Deviations
- 2026-10-18：plan 补写于实现之后（见开头说明）。
- 2026-10-18：R6 不再承诺 DOM 顺序与视觉顺序一致，改记为已知限制，见 review.md；已同步删去 spec 对应条文。
