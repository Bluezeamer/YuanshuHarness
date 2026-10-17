# ADR-0025: 数据目录布局、结构版本号与存储一致性（修订文件名约定）

状态：已定稿
日期：2026-10-17
可逆性：难逆
取代：[ADR-0023](0023-data-dir-layout-and-versioning.md)（仅文件名约定，其余原样保留）
被取代：——
引用入口：ARCHITECTURE「技术选型」存储一行与「边界与约定」；ROADMAP 第 3 条

## 背景
[ADR-0004](0004-state-storage-recovery.md) 定了对话沿用 JSONL、状态放 SQLite、所有状态在一个数据目录；[ADR-0012](0012-delivery-form.md) 要求数据目录带结构版本号并自动迁移，[ADR-0018](0018-startup-params-and-health-endpoint.md) 把版本号推迟到首份持久化数据。
文件名、目录结构、版本号位置一旦写进用户磁盘，改动就要迁移，所以难逆。
2026-10-17 实测（SDK 1.3.0）：`SessionManager.create(cwd, dir, { id })` 可指定会话 id，但文件名固定为 `<ISO 时间>_<id>.jsonl`，不可指定；文件在第一条助手消息之后才创建。ADR-0023 假设“文件名就是会话 id”，做不到，故取代。
SDK 已验证：`SessionManager.create(cwd, sessionDir)` 可指定会话目录，`SessionManager.open(path)` 可从 JSONL 重建，会话名称可经 `appendSessionInfo` 写入 JSONL。

## 候选方案
### 一致性口径
- A. SQLite 为准。代价：JSONL 与索引不一致时，对话内容与索引谁对说不清。
- B. JSONL 为准，SQLite 索引可重建。代价：启动要对账。

### 版本号
- A. SQLite 的 `PRAGMA user_version`。单一来源，随事务原子更新。
- B. 数据目录里单独的版本文件。代价：与数据库可能不同步。

## 决定
**布局**（相对数据目录）
- `yuanshu.db`：SQLite。
- `sessions/<ISO 时间>_<会话 id>.jsonl`：用户级会话，文件名由 SDK 生成。会话 id 沿用 UUIDv7（[ADR-0021](0021-session-wire-protocol.md)），经 SDK 的 id 选项传入；按文件名后缀 `_<会话 id>.jsonl` 定位会话，对账时同样从文件名取 id。子会话目录到 subagent 能力时再建。
- 没发过消息的会话没有 JSONL，重启后不会出现（索引有而文件没有，按下面的对账规则删除索引行）。

**一致性：JSONL 为准，索引可重建。**
- 会话名称存在 JSONL 里；SQLite 只缓存名称、创建时间、最近活动时间。
- 启动时对账：JSONL 有而索引没有，补建；索引有而 JSONL 没有，删除该索引行并记警告。
- 本期只有一张索引表 `sessions(id, name, created_at, updated_at)`；迁移机制必须能承载后续加表。

**结构版本号**
- 用 `PRAGMA user_version`，单一来源。
- 启动时比较：低于当前代码版本，按顺序逐版迁移；等于，直接用；**高于，拒绝启动**并说明，防止旧版本破坏新数据。
- 迁移前把 `yuanshu.db` 复制为 `yuanshu.db.bak-v<旧版本>`；每一步迁移在一个事务内。

## 理由
- 只用 SDK 公开接口（[ADR-0001](0001-pi-sdk-no-fork.md)）；自己预写 JSONL 头行会依赖其内部格式。
- 对话是用户最不可丢的数据，且 pi 的能力建立在 JSONL 上，以它为准最稳妥；索引丢了可以重建。
- 版本号放进数据库本身，随事务一起提交，不会与数据脱节。
- 拒绝启动比静默降级安全：旧版本对不认识的新结构没有任何保证。

## 影响
- 启动要扫描 `sessions/` 并与索引对账，会话很多时增加启动耗时；按需加载只影响会话进池，不影响对账。
- 迁移备份占用磁盘；备份的清理策略本期不做。
- 孤儿 JSONL（索引缺失）会被补建出现在列表里，不会被删除。
- 排除：以 SQLite 为对话的准；单独的版本文件。
