# ADR-0032: 目录浏览接口与按目录新建会话

状态：已定稿
日期：2026-10-19
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」；ROADMAP 第 5 条

## 背景
[ADR-0029](0029-minimal-workspace.md) 让用户在设置页手填绝对路径登记 workspace，选目录不直观，也看不出目录是否可用。希望改为：选主机、逐级展开目录、选定目标目录、确认可读写、创建会话。这要求 Server 把本机目录结构暴露给 WebUI，属于新增对外接口和新的授权面。

## 候选方案
- A. 新增只读目录浏览接口，前端选目录后沿用既有 workspace 与会话接口（本期选）。会话与 workspace 的契约不变。
- B. 创建会话时直接带 `path`，服务端隐式登记。代价：改会话契约，隐式授权不易审计。
- C. 维持手填路径。代价：体验差，路径写错到提交时才知道。

## 决定
选 A。`GET /api/v1/fs/dirs?path=<绝对路径>&hidden=0|1`，在认证作用域内：
- `path` 缺省取 Server 进程用户的 home；必须是存在的绝对目录，否则 400。
- 响应 `{ path, parent, dirs, readable, writable, truncated }`：`path` 为解析符号链接后的路径，`parent` 在根目录为 `null`，`dirs` 为子目录名（按名排序，指向目录的符号链接按目录算），**不返回文件名与任何文件内容**；`readable`、`writable` 为当前进程对该目录 `R_OK|X_OK`、`W_OK|X_OK` 的探测；`hidden` 缺省 0，不含以 `.` 开头的目录；`dirs` 最多 2000 项，超出 `truncated` 为 `true`。
- 目录不可读时 `dirs` 为空且 `readable=false`，不报错。
- 登记与建会话仍由既有接口完成：前端取选中目录的 `path`，`POST /api/v1/workspaces`（409 则按路径找到已有的），再 `POST /api/v1/sessions`。登记仍是用户经 REST 的授权动作，agent 不能调用（沿用 [ADR-0003](0003-concept-model.md)、[ADR-0029](0029-minimal-workspace.md)）。

## 理由
- 不改会话与 workspace 契约，新增面只有一个只读接口。
- 只给目录名，不给文件，限定暴露的信息量；调用方已是能让 agent 在主机上读写的已认证用户，该接口不扩大其能力。
- 可用性由 Server 探测，避免前端猜。

## 影响
- 新增一个认证内的 REST 接口；无新持久化数据，无迁移。
- 目录结构对已认证用户可见；认证未启用时仅回环监听（既有约束），不改变。
- 第 6 条扩展环境时，同一接口加 `environmentId` 参数，本期恒为本机。
- 排除：文件列表与预览；创建目录；非本机主机。
