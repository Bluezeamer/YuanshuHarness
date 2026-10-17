# Intent: 主干（二）持久化与恢复
Author: bluezeamer
Status: accepted
Date: 2026-10-17
Lane: decide
Why: 命中"难逆"——首份持久化数据（SQLite 表结构、数据目录结构版本号、JSONL 目录布局）一旦写进用户磁盘就要迁移，且引入新依赖（SQLite 驱动）；同时命中"静默"（写入、重启恢复、双存储一致性），实现阶段按加固处理。

## Links
来源: ROADMAP 第 3 条（主干）的第二块
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0004](../../../genesis/adr/0004-state-storage-recovery.md)、[ADR-0012](../../../genesis/adr/0012-delivery-form.md)、[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0003](../../../genesis/adr/0003-concept-model.md)
下游: 定稿后回填

## Problem
会话池目前只在内存里，重启即失。ADR-0004 定了方向（对话沿用 pi 的 JSONL，Server 状态放 SQLite，只有 Server 一个写入者，重启时被打断的工具调用由 agent 自行感知），但没有定：SQLite 用哪个驱动、表结构、数据目录的结构版本号与迁移机制、JSONL 放哪、会话怎样在重启后重新出现。
上一块遗留了三件事要在这里补：会话的增删改查（ADR-0021 的端点只增不改）、被截断内容的全文按需拉取（R16）、窗口之外历史的 REST 拉取（ADR-0021 推迟到此）。

## Proposed outcome
- 数据目录里有 SQLite 文件（会话索引）与会话 JSONL；带结构版本号，启动时检查并在需要时迁移。
- Server 重启后，已有会话仍在列表里，可重新连上：快照里有历史窗口，可继续对话。
- 重启时仍处于运行中的会话，按 ADR-0004 恢复：被打断的工具调用，agent 收到"上次被中断"的提示。
- 会话可创建、列表、查询、改名、删除；删除同时清理 JSONL。
- 被截断的消息 / 工具结果可按需拉取全文；窗口之外的历史可分页拉取。

## Out of scope
- 其余 Server 状态的表（环境、workspace、规则、密码库、能力清单）：随各自能力一起建，本期只建会话索引，但迁移机制要能承载后续加表。
- 父子关系（subagent，第 9 条）：表里不预留列，需要时迁移。
- 认证（下一个 intent）、命令行客户端。
- agent 定义与真实模型接入：会话创建仍由注入的工厂提供（第 7 条）。
- 会话的搜索与归档（全文检索等）：本期"查"指列表与按 id 取。

## Constraints
- 对话记录沿用 pi 的 JSONL，Server 状态放 SQLite；只有 Server 一个进程写会话文件，不允许同时用 pi 命令行操作同一会话（[ADR-0004](../../../genesis/adr/0004-state-storage-recovery.md)）。
- 所有状态在一个数据目录；结构版本号与迁移机制在此落地（[ADR-0012](../../../genesis/adr/0012-delivery-form.md)、[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md) 已推迟到首份持久化数据）。
- 只依赖 SDK 公开接口，不读取机器上已有的 pi 配置目录（[ADR-0001](../../../genesis/adr/0001-pi-sdk-no-fork.md)）。契约测试已验证"从 JSONL 加载会话"可行。
- 序号仍是每个会话的内存计数器，不保存事件，重启后从快照重新开始（[ADR-0005](../../../genesis/adr/0005-client-protocol.md)）。
- 测试对着 stub provider，CI 不调用真实模型。

## Decisions needed
难逆（各出 ADR）：
1. **SQLite 驱动**：Node 内置 `node:sqlite`（零依赖，但在 Node 22 仍标实验性）、`better-sqlite3`（成熟，但有原生模块，影响 npm 包与 `node:24-slim` 镜像）、其他。需实测：在 Node 22.19 与 24 上的可用性与警告、镜像里的构建。建议：评估后给候选，等你拍板。
2. **数据目录布局与结构版本号**：SQLite 文件名、JSONL 目录（用户级与子会话分开，ADR-0004）、结构版本号放哪（SQLite 的 `user_version` 还是单独文件）、迁移的执行方式与失败回退（迁移前备份？）。
3. **会话 REST 的增删改查与历史拉取契约**：`PATCH`/`DELETE` 的形状、全文拉取与分页历史的端点与字段（`/api/v1` 内只增不改，ADR-0021）。
4. **崩溃一致性口径**：SQLite 索引与 JSONL 两处存储，崩溃时谁为准、孤儿文件与缺失文件怎么处理（建议：JSONL 为准，索引可重建；需你确认）。

易逆（推迟到 spec）：表的具体列、分页大小、删除的软硬策略细节、启动时的校验日志格式。

决定（2026-10-17，bluezeamer 确认）：
- 档位与范围同意。
- 会话管理的最小原子单位是整条会话（建、列、查、改名、删），会话内部的状态调整（回退对话、fork 等 pi 本身支持的能力）后续另议，不在本期。
- 重启后会话按需加载（首次访问时从 JSONL 恢复），不在启动时全部加载。
- 崩溃一致性：JSONL 为准，SQLite 索引可重建。

## Open questions
- pi 会话 JSONL 的路径由 SDK 决定还是我们指定？实现前读源码与契约测试确认（spec 阶段）。
