# Spec: 最小 workspace
Author: bluezeamer
Status: accepted
Date: 2026-10-18

> 决策见 [ADR-0029](../../../genesis/adr/0029-minimal-workspace.md)，此处只写需求。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0029](../../../genesis/adr/0029-minimal-workspace.md)、[ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md)
下游: [plan.md](plan.md)

## Requirements
R1. 迁移 v3 建 `workspaces` 并给 `sessions` 加 `workspace_id`；旧库迁移前按既有规则备份，存量会话数据保留。
R2. 数据库里没有 workspace 时，启动登记 Server 启动目录为默认；已有 workspace 时不得再自动登记。
R3. `POST /api/v1/workspaces`：`path` 必须是存在的绝对目录，登记其解析符号链接后的路径；非目录/不存在/相对路径 400；同一解析后路径重复 409。`name` 缺省取目录名，去空白后 1–100 字符。
R4. `PATCH` 可改 `name` 与 `tier`（`rules|auto|full`），非法值 400；`DELETE` 有会话引用时 409 且什么都不删。
R5. `POST /api/v1/sessions` 的 `workspaceId` 缺省取最早登记的 workspace；未知 id 400；目录已不存在 400；会话的工厂收到 `cwd` 为该 workspace 路径。会话条目含 `workspaceId`。
R6. 孤儿会话（对账补建）与迁移前的会话 `workspace_id` 视为默认（最早登记）workspace，恢复时同样把其路径作为 `cwd`。
R7. WebUI：新建会话可选 workspace；设置中可新增 workspace、改名、改档位、删除。
R8. 不得改变既有会话协议行为，既有测试继续通过。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | 构造 v2 库含会话，迁移后有 .bak-v2、会话保留、列存在 | 变异：迁移不备份，必须变红 |
| R2 | 空库启动登记一次；重启不重复；删除默认后重启不自动补登记 | 变异：每次启动都登记，必须变红 |
| R3 | 相对路径、文件、不存在、符号链接重复、重名 name 边界 | 变异：不解析符号链接，重复用例必须变红 |
| R4 | 改档位生效；非法 tier 400；有会话引用删除 409 | 是 |
| R5 | 指定 workspace 创建后工厂 cwd 正确；未知 400；目录被移走 400 | 是 |
| R6 | v2 旧会话与孤儿会话恢复后 cwd 为默认 workspace | 是 |
| R7 | web 组件测试；浏览器验证记录 | 不适用 |
| R8 | 全量既有测试与 `scripts/check.sh` | 不适用 |

## Design
- `src/store/workspaces.ts`（读写、默认登记）、`src/api/workspaces.ts`（REST）；`FactoryOptions` 增加 `cwd: string`；池 `create({ workspaceId })` 取路径传给工厂；`SessionStore` 增 `workspaceId` 读写。
- 迁移与兼容：读侧兼容旧会话（`workspace_id` 空即默认），写侧新建会话都带 id；回退到旧版本程序时 v3 库因版本更高被拒绝启动（既有保护）。

## Risks
登记目录等于授权 agent 在其下默认读写；只有已认证用户的 REST 可登记。
