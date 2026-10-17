# ARCHITECTURE: YuanshuHarness（元枢）

> 本文件只记录难逆的宏观决策，是当前有效决策的**快照**；记录边界与选型，不记录行为与"能力现状"——那些会过期，由各变更 spec 的 Requirements 和测试承担。
> 每个决策的完整论证与演化史在 adr/ 目录——本文件的每条选型必须链接到当前有效的 ADR，adr/ 不作扁平阅读入口。

## 系统组成

一个常驻的 Node 进程（Server），内嵌 pi SDK，由下列模块组成：

- **会话池**：持有所有会话，驱动 agent 循环，产生带序号的事件，管理排队。（[ADR-0001](adr/0001-pi-sdk-no-fork.md)、[ADR-0005](adr/0005-client-protocol.md)）
- **客户端网关**：对外提供统一协议，WebUI 与最小命令行先行，IM 网关与 TUI 其后；接入前认证。（[ADR-0005](adr/0005-client-protocol.md)、[ADR-0011](adr/0011-auth-and-im-routing.md)）
- **环境层**：环境与 workspace 的登记，Server 级 ssh 连接管理，环境原语，按环境类型的路径解析。（[ADR-0002](adr/0002-thin-environment-ssh.md)、[ADR-0003](adr/0003-concept-model.md)）
- **权限层**：规则引擎，三档，审核模型，审批队列。（[ADR-0006](adr/0006-permission-tiers.md)）
- **隐私变量库**：加密存储，占位符替换，输出回显替换。（[ADR-0007](adr/0007-private-variables.md)）
- **能力库**：skill、MCP、工具的登记与分配，向环境同步。（[ADR-0008](adr/0008-capability-sets.md)）
- **agent 定义与提示词装配**：提示词块、分组拼接，模式，会话中途注入。（[ADR-0003](adr/0003-concept-model.md)、[ADR-0009](adr/0009-prompt-assembly-injection.md)）
- **subagent 管理**：父子关系，spawn、wait、interrupt，拓扑。（[ADR-0010](adr/0010-subagent.md)）
- **模型配置**：协议、供应商、模型的登记与接入向导，审核模型的单独配置。（[ADR-0015](adr/0015-model-management.md)）
- **状态存储**：SQLite（Server 状态）加 JSONL（对话记录），同一数据目录。（[ADR-0004](adr/0004-state-storage-recovery.md)、[ADR-0012](adr/0012-delivery-form.md)）

## 技术选型

| 位置 | 选择 | 决策依据（当前有效 ADR） |
|---|---|---|
| agent 内核 | pi SDK，不 fork，精确锁定版本 | [ADR-0001](adr/0001-pi-sdk-no-fork.md) |
| 语言与运行时 | TypeScript，Node ≥ 22.19 | [ADR-0013](adr/0013-tech-stack.md) |
| HTTP 框架 | Fastify 5.x，精确锁定版本 | [ADR-0017](adr/0017-server-web-framework.md) |
| 前端 | React 加 Tailwind，由 Server 托管 | [ADR-0013](adr/0013-tech-stack.md) |
| 执行环境 | 薄环境，ssh 接入，Windows 经 Git Bash | [ADR-0002](adr/0002-thin-environment-ssh.md) |
| 概念模型 | agent 定义、环境、workspace、会话 | [ADR-0003](adr/0003-concept-model.md) |
| 对话记录与 Server 状态 | pi JSONL 加 SQLite，单写入者 | [ADR-0004](adr/0004-state-storage-recovery.md) |
| 客户端协议 | 带序号事件流，最近窗口，统一排队，先答先赢弹窗 | [ADR-0005](adr/0005-client-protocol.md) |
| 传输层 | 每会话一条 WebSocket，REST 管会话的创建与查询 | [ADR-0020](adr/0020-transport-websocket.md) |
| 会话线上协议 | `/api/v1` 路径版本化；Server 自定义薄事件类型；UUIDv7 会话标识；`send_message`/`stop`/`resync` 命令，缺口靠 `resync` 重发快照 | [ADR-0021](adr/0021-session-wire-protocol.md) |
| SQLite 驱动 | `better-sqlite3`，精确锁定版本，预编译随包携带 | [ADR-0022](adr/0022-sqlite-driver.md) |
| 数据目录布局与版本 | `yuanshu.db` 加 `sessions/<时间>_<id>.jsonl`；`PRAGMA user_version`，高于代码版本拒绝启动，迁移前备份；JSONL 为准，索引可重建 | [ADR-0025](adr/0025-data-dir-layout-and-versioning-revised.md) |
| 会话管理 REST | 改名、删除（运行中拒绝）、游标分页历史、单条全文 | [ADR-0024](adr/0024-session-rest-and-history.md) |
| 权限 | 三档，规则共用，模型审批，Codex 为蓝本 | [ADR-0006](adr/0006-permission-tiers.md) |
| 凭据 | 占位符引用，Server 持有并替换 | [ADR-0007](adr/0007-private-variables.md) |
| 能力集 | Server 集中管理 skill 与 MCP | [ADR-0008](adr/0008-capability-sets.md) |
| 提示词与注入 | 分组拼接，尾部通知，执行层拦截 | [ADR-0009](adr/0009-prompt-assembly-injection.md) |
| subagent | 独立会话加双向父子关系 | [ADR-0010](adr/0010-subagent.md) |
| 认证 | 受限网段加令牌，IM 白名单路由 | [ADR-0011](adr/0011-auth-and-im-routing.md) |
| 交付 | npm 包加 Docker 镜像，单一数据目录 | [ADR-0012](adr/0012-delivery-form.md) |
| 启动参数与健康端点 | host、port、数据目录三个参数，命令行优先于环境变量；`GET /healthz` 无需认证 | [ADR-0018](adr/0018-startup-params-and-health-endpoint.md) |
| 发布物形态 | 命令 `yuanshu serve`；只发布 server 一个 npm 包；镜像基于 `node:24-slim`，多阶段构建，镜像里装的就是该 npm 包 | [ADR-0019](adr/0019-release-artifacts.md) |
| 托管与 CI | GitHub 公开仓库，脚本化 CI | [ADR-0014](adr/0014-hosting-and-ci.md) |
| 许可 | MIT；移植的 Codex 部分保留 Apache-2.0 | [ADR-0016](adr/0016-license-mit.md) |
| 模型 | 跟随 agent 定义，会话内手动切换，向导 | [ADR-0015](adr/0015-model-management.md) |

## 数据流

用户消息经客户端网关认证后进入会话的队列，会话池按该会话的 agent 定义（装配好的提示词、能力清单、模型）驱动 pi 的 agent 循环。循环中的每次工具调用先经过权限层（规则，规则外交人或审核模型），通过后由 Server 替换隐私变量占位符，再经环境原语在当前生效 workspace 所在的环境里执行；结果替换回已知真值的占位符后，写入 JSONL 并作为带序号的事件推给所有接入的客户端。

关键实体与归属：
- agent 定义、能力库、隐私变量库、模型配置、规则：Server 级，不属于任何环境。（[ADR-0003](adr/0003-concept-model.md)、[ADR-0008](adr/0008-capability-sets.md)）
- 环境记录与 workspace：Server 登记；workspace 属于一个环境，带显式 cwd，权限档位挂在其上。（[ADR-0003](adr/0003-concept-model.md)、[ADR-0006](adr/0006-permission-tiers.md)）
- 会话：一个 agent 定义加若干 workspace；对话记录在 JSONL，会话索引与父子关系在 SQLite。（[ADR-0004](adr/0004-state-storage-recovery.md)、[ADR-0010](adr/0010-subagent.md)）

## 边界与约定

- 只依赖 pi SDK 的公开接口，不兼容 pi 命令行与第三方扩展，不读取机器上已有的 pi 配置。（[ADR-0001](adr/0001-pi-sdk-no-fork.md)）
- 工具逻辑与 agent 循环都在 Server；环境只提供最小原语，远程不安装 pi 与 Node；Server 不创建或管理环境。（[ADR-0002](adr/0002-thin-environment-ssh.md)）
- 命令原样在环境中执行，不被包装。（[ADR-0002](adr/0002-thin-environment-ssh.md)）
- 只有 Server 一个进程写会话文件；只保证对话历史不丢，不做任务级续跑。（[ADR-0004](adr/0004-state-storage-recovery.md)）
- 单进程内多会话：禁止进程全局状态（环境变量、工作目录、全局单例）。（[ADR-0013](adr/0013-tech-stack.md)）
- 序号仅用于快照与实时流的衔接和缺口检测，不保存事件，不用于回放。（[ADR-0005](adr/0005-client-protocol.md)）
- 会话池独立于 Web 框架，由注入的会话工厂创建会话（`src/session/`）；路由层只做协议编解码（`src/api/`）。快照由池从同一条事件流累积，保证快照与序号一致。模型不支持图片时拒绝带图消息，因为 SDK 会悄悄丢图。（[ADR-0020](adr/0020-transport-websocket.md)、[ADR-0021](adr/0021-session-wire-protocol.md)）
- 会话按需从 JSONL 加载进池，索引（SQLite）与文件不一致时以文件为准并在启动时对账；运行中的会话不可删除；被打断留下的悬挂工具调用，在下一轮以尾部通知告知模型。（[ADR-0004](adr/0004-state-storage-recovery.md)、[ADR-0024](adr/0024-session-rest-and-history.md)、[ADR-0025](adr/0025-data-dir-layout-and-versioning-revised.md)）
- 超时、出错、拿不准一律不默认放行；敏感路径不吃 cwd 放行；子进程不继承 Server 的环境。（[ADR-0006](adr/0006-permission-tiers.md)）
- 凭据真值只在启动进程时出现，不经环境变量；sudo 开 shell 类动作始终人工审批。（[ADR-0007](adr/0007-private-variables.md)）
- 输出脱敏不在基建内，只预留变换槽位。（[ADR-0006](adr/0006-permission-tiers.md)）
- 能力库归 Server；非全局 MCP 固定在 local-workspace 运行，全局 MCP 只放 SaaS 类。（[ADR-0008](adr/0008-capability-sets.md)）
- 保护前缀缓存：会话中途的变化在末尾附加；模式与能力限制在执行层拦截，不改工具定义。（[ADR-0009](adr/0009-prompt-assembly-injection.md)）
- subagent 的环境与权限只能收窄，不能放宽；子会话不弹窗。（[ADR-0010](adr/0010-subagent.md)）
- 只服务一个人，不面向公网。（[ADR-0011](adr/0011-auth-and-im-routing.md)）
- 所有状态在一个数据目录。（[ADR-0012](adr/0012-delivery-form.md)）
- CI 逻辑写进仓库脚本，工作流只做调用。（[ADR-0014](adr/0014-hosting-and-ci.md)）

## 演进记录
- 2026-10-16：创世初版，纳入 ADR-0001 至 ADR-0016。
- 2026-10-17：纳入 ADR-0017，选定 Server 的 HTTP 框架。
- 2026-10-17：纳入 ADR-0018，定启动参数与健康端点的契约；令牌与来源网段参数、数据目录结构版本号推迟到认证与首份持久化数据落地时。
- 2026-10-17：纳入 ADR-0019，定发布物形态：命令名与子命令、npm 包结构、镜像基础与构建方式。
- 2026-10-17：纳入 ADR-0020、ADR-0021，定传输层（WebSocket）与会话线上协议；认证的令牌携带方式、历史拉取路径分别推迟到认证与持久化。
- 2026-10-17：会话池与事件流落地（ROADMAP 第 3 条第一块），边界与约定补会话池的实现约束。
- 2026-10-17：纳入 ADR-0022 至 ADR-0024，定 SQLite 驱动、数据目录布局与结构版本号、会话管理与历史拉取的 REST 契约。
- 2026-10-17：ADR-0025 取代 ADR-0023，仅改会话文件名约定（SDK 固定生成 `<时间>_<id>.jsonl`）。
- 2026-10-17：持久化与恢复落地（ROADMAP 第 3 条第二块），边界与约定补按需加载与对账。
