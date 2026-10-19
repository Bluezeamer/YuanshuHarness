# Spec: 目录选择器
Author: bluezeamer
Status: accepted
Date: 2026-10-19

> 决策见 [ADR-0032](../../../genesis/adr/0032-directory-browse-api.md)，此处只写需求。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0032](../../../genesis/adr/0032-directory-browse-api.md)、[ADR-0029](../../../genesis/adr/0029-minimal-workspace.md)
下游: [plan.md](plan.md)

## Requirements
R1. `GET /api/v1/fs/dirs` 在认证作用域内；`path` 缺省为 home；相对路径、不存在、非目录返回 400。
R2. 响应只含子目录名，不得含文件名；`path` 为解析符号链接后的路径；根目录 `parent` 为 `null`；指向目录的符号链接算目录，悬空链接与文件不出现。
R3. 默认不含以 `.` 开头的目录，`hidden=1` 才含；按名排序；超过 2000 项截断并 `truncated=true`。
R4. `readable`/`writable` 反映当前进程对该目录的真实权限；不可读目录返回空 `dirs` 与 `readable=false`，不报 500。
R5. 不得因调用该接口登记 workspace 或改变任何持久化数据。
R6. WebUI 新建会话：本机 → 逐级展开选目录 → 显示可用性 → 选档位 → 创建；目录不可读写时不能创建；未登记目录先登记再建会话，已登记则复用；登记与建会话任一步失败不得留下半成品会话。
R7. 设置页「新增工作区」使用同一选择器，不再手填路径。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | 未带令牌 401；缺省为 home；相对/不存在/文件 400 | 是（路由不存在） |
| R2 | 临时目录含文件、子目录、符号链接、悬空链接，断言只有目录名；根 parent 为 null | 变异：把文件也列出，必须变红 |
| R3 | 点目录默认隐藏，`hidden=1` 出现；2001 项截断 | 变异：不过滤点目录，必须变红 |
| R4 | chmod 000 目录 `readable=false` 且 200；只读目录 `writable=false` | 变异：writable 恒真，必须变红 |
| R5 | 调用前后 workspaces 表不变 | 是 |
| R6 | web 组件测试：不可读写时创建禁用；已登记复用（409 后匹配）；建会话失败不留残留；浏览器验证 | 不适用 |
| R7 | web 组件测试；浏览器验证 | 不适用 |

## Design
- 服务端：`src/api/fs.ts` 一个路由；`readdir(withFileTypes)` 加对符号链接的 `stat`。
- Web：`DirPicker` 组件（面包屑 + 子目录列表 + 可用性 + 点目录开关），被 `NewSession` 与 `WorkspacesPanel` 复用。登记 409 时按 `path` 在 `listWorkspaces` 里找已有的。

## Risks
目录结构对已认证用户可见（ADR-0032 已说明）；不可读写的判断是调用时刻的快照，创建时仍由既有 `workspaceProblem` 校验兜底。
