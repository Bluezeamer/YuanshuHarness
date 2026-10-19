# ADR-0029: 最小 workspace：本机登记、档位字段与会话绑定

状态：已定稿
日期：2026-10-18
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」；ROADMAP 第 5 条

## 背景
[ADR-0006](0006-permission-tiers.md) 的档位与“记住的规则”都挂在 workspace 上，“在 cwd 内还是 cwd 外”以它的 cwd 为基准；[ADR-0003](0003-concept-model.md) 定义了 workspace 是环境内带显式 cwd 的目录。完整的环境与 workspace 属于 ROADMAP 第 6 条，但第 5 条需要它作挂靠点。
2026-10-18 决定把 workspace 的最小形态（仅本机）提前到第 5 条，避免先挂在会话上、之后再迁移。表结构与 REST 一经发布就是契约，所以难逆。

## 候选方案
### 档位和规则先挂哪
- A. 挂会话。代价：第 6 条要把存量会话的数据迁到 workspace。
- B. 提前引入最小 workspace（本期选）。代价：第 5 条多一块登记与 REST；第 6 条扩展而非迁移。

### 默认 workspace 的来源
- A. 首次启动把 Server 的启动目录登记为默认；WebUI 可再新增本机目录。
- B. 只能手工登记。代价：第一次使用必须先配置才能对话。

## 决定
**表**（迁移 v3）
- `workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, environment_id TEXT NOT NULL DEFAULT 'local', tier TEXT NOT NULL DEFAULT 'rules', created_at TEXT NOT NULL)`。`id` 为 UUIDv7；`path` 为绝对、已解析符号链接的目录；`tier` 取 `rules`（规则审批）、`auto`（自动模式）、`full`（完全允许）。`environment_id` 本期恒为 `local`，为第 6 条预留，不引入环境表。
- `sessions` 增加 `workspace_id TEXT`（可空，向后兼容）。启动对账补建的孤儿会话与旧会话取默认 workspace。

**默认 workspace**：数据库中没有任何 workspace 时，启动将 Server 的启动目录登记为默认（`name` 取目录名）；之后不再自动登记：首次登记（或发现已有 workspace）时在 `meta` 表写入持久化标记（并入迁移 v3，不新增版本号），删光所有 workspace 后重启也不补登记。

**REST**（均在认证作用域内）
- `GET /api/v1/workspaces`、`POST /api/v1/workspaces`（`{ path, name? }`，路径须为存在的绝对目录，否则 400；已登记的路径 409）、`PATCH /api/v1/workspaces/:id`（`{ name?, tier? }`）、`DELETE /api/v1/workspaces/:id`（有会话引用时 409，默认 workspace 允许删除只要无会话引用）。
- `POST /api/v1/sessions` 增加可选 `workspaceId`，缺省取最早登记的 workspace；会话与 workspace 的绑定在本期不可更改（切换是第 6 条）。会话条目增加 `workspaceId`。
- 档位修改即时生效，对运行中的会话也是；每次权限判定都读当前值。

## 理由
- 登记一个目录等于授予 agent 在该目录下的默认读写范围，这是授权动作，所以只有已认证的用户经 REST 能做，agent 不能（符合 ADR-0003“只有用户可以新增 workspace”）。
- 保留 `environment_id` 比以后加列更省事，且不影响现有语义。
- 默认 workspace 让首次使用无需配置。

## 影响
- 迁移 v3：建 `workspaces`，`sessions` 加列；旧库迁移前按 [ADR-0025](0025-data-dir-layout-and-versioning-revised.md) 备份。
- 路径在登记时解析符号链接；之后目录被移走则该 workspace 下新建会话失败（400），不静默回退。
- 排除：环境表；会话中途切换 workspace；agent 自行登记。
