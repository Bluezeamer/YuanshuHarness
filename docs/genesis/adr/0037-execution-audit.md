# ADR-0037: 执行审计

状态：已定稿
日期：2026-10-20
可逆性：中
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」

## 背景
agent 的工具调用、权限裁决，以及用户经 WebUI 的终端、文件、环境传输操作，都需要事后可查。本篇定记什么、记多少、怎么查。

## 决定
- **表**：迁移追加 `audit_log(id, ts, session_id, actor, kind, environment_id, summary, detail)`，`id` 自增，索引 `(session_id, id)` 与 `(kind, id)`。
- **字段取值**：`actor` 为 `user`、`agent`、`system`；`kind` 为 `tool`、`permission`、`terminal`、`file`、`transfer`、`env`。
- **有界且不记隐私**：`summary` 截到 300 字符；`detail` 是 JSON，字符串逐个截到 200 字符，整体超 2048 字节就只留 `{"truncated":true}`。工具调用开始只记命令或路径，`write.content` 等大字段与工具输出、终端输入输出、文件内容、密码值都不进审计。
- **记录点**：会话池里工具调用开始与结束（含 `isError`、`durationMs`）；权限裁决（用户批准或拒绝、自动审核、超时、取消，规则内自动放行不记）；终端开与关；文件写类操作；环境连接与传输。
- **旁路**：写入失败不得改变被审计操作的结果，尤其权限裁决是 fail-closed 路径，审计抛错不能变成拒绝。
- **查询**：`GET /api/v1/audit?session=&kind=&environment=&limit=&before=`，按 `id` 倒序，`limit` 缺省 100、最大 500，返回 `{entries, nextBefore}`，`nextBefore` 非空时用作下一页的 `before`。

## 理由
- 只存摘要和少量结构化事实，审计表不会随内容增长，也不会成为第二份泄密面。
- 游标用自增 `id` 而不是时间戳，同一毫秒内的多条也不会漏页。

## 影响
- 新增 `store/audit.ts`（表与查询类）、`api/audit.ts`（查询入口）、`session/audit.ts`（工具调用的记录助手）、`env/transfer-jobs.ts`（后台任务进度与审计）；`pool.ts` 工具开始/结束、`permission/extension.ts` 权限决定、`api/environments.ts` 传输与连接、`terminal/manager.ts` 终端开关、`api/files.ts` 文件写类操作，各加记录调用。
- `detail` 约定键，供时间线展示：`op`（动作）、`target`（路径或摘要）、`result`（`ok`/`error`，权限决定为 `allow`/`deny`/`remember`）、`durationMs`。各记录点按有无填写：工具开始只有 `op`/`target`，工具结束有 `result`/`durationMs`，权限决定无耗时，终端关闭的耗时是终端存活时长。
- 排除：审计的保留期与清理；审计内容的完整性保护（单用户可信内网，原型期不做）。
