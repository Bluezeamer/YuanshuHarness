# Plan: 持久化与恢复
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> plan 是活的：实现中偏离计划，写进 Deviations，与对应代码同一次提交，无需重新审批。
> 只有偏离触及 spec 的 Requirements 时才回头改 spec。

## Links
来源: [spec.md](spec.md)
下游: 实现后回填 PR

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/package.json`、`pnpm-lock.yaml` | 新增 `better-sqlite3`（精确版本，13.0.3），及其类型包（如需，精确锁定） |
| `packages/server/src/store/db.ts`（新） | 打开 `yuanshu.db`、独占锁、`user_version` 比较、备份、事务迁移、迁移表 |
| `packages/server/src/store/sessions.ts`（新） | 索引读写、启动对账（文件名后缀解析、会话头与名称读取） |
| `packages/server/src/store/history.ts`（新） | 经 SDK 公开接口读 JSONL：当前分支 user/assistant 消息、分页、单条、末尾悬挂工具调用检测 |
| `packages/server/src/session/pool.ts` | 工厂签名改为 `{id, sessionDir, file?}`；`acquire(id)` 异步去重加载；窗口播种；索引写入与 `updated_at`；改名、删除；中断通知；`dispose` |
| `packages/server/src/api/sessions.ts` | `PATCH`、`DELETE`、`messages` 两个端点；stream 升级与 GET 改用 `acquire`；id 格式校验；列表字段 |
| `packages/server/src/server.ts` | 启动顺序加入打开数据库与对账；停止时关闭数据库；把 store 传给池 |
| `packages/server/test/support/stub.ts` | 工厂适配新签名（按传入的 id 与目录建 `SessionManager`） |
| `packages/server/src/**/*.test.ts`（新） | 对应 spec 的 Proof 表，含变异验证 |
| `Dockerfile`、`scripts/smoke-*.sh`（如需） | 确认镜像与装包冒烟里 better-sqlite3 的预编译可加载；不需要则不动 |
| `docs/genesis/ARCHITECTURE.md` | 「数据流」「边界与约定」补持久化实现位置与不变量，演进记录一条 |

## Order of work
每步结束 `typecheck` 与相关测试全绿再进下一步；先写会失败的测试，再实现。

1. **读源码并探测，不写生产代码**（结论写进 Deviations，与 spec 假设不符先停下改 spec）：
   (a) 对未加载的会话，用 SDK 公开接口追加会话名称条目的方式与是否立即落盘；
   (b) `SessionManager.open` 后取当前分支消息的接口，以及 getEntries/getBranch 对 user/assistant 文本的结构；
   (c) 悬挂工具调用在重放时的 SDK 行为与"下一轮附加通知"的公开接口（`sendCustomMessage` 的 `nextTurn` 之类）；
   (d) better-sqlite3 在本仓库 CI 的 Node 22.19 与镜像 Node 24 下可加载（本地已验证 Node 24）。
2. **依赖与迁移骨架** `store/db.ts`：独占锁、版本比较、备份、事务迁移；单测覆盖 R1–R3，附变异验证。
3. **索引与对账** `store/sessions.ts`：R5–R8；构造 JSONL 夹具（含坏文件、孤儿、缺失），断言对账前后 JSONL 字节不变。
4. **历史读取** `store/history.ts`：R16、R17 的读取与分页逻辑，单测含中途追加。
5. **池改造**：工厂签名、`acquire` 去重、窗口播种、索引写入、改名、删除、中断通知；R9–R15 的池级用例，变异验证。
6. **路由与服务接线**：新端点、id 校验、启动与停止顺序；API 集成用例（含重启场景：同数据目录起第二个 Server）。
7. **整体回归**：既有全量测试；`scripts/check.sh`（含装包与镜像冒烟）；手动用 Node 全局 `WebSocket` 与 `fetch` 跑一遍：建会话、对话、停 Server、重启、列表、重连、改名、历史分页、删除。
8. **文档**：ARCHITECTURE；本 plan 的 Deviations 补全。
9. **评审**：新开空上下文评审，命中静默信号，至少两轮：一轮盯迁移、对账、删除的数据安全与崩溃一致性，一轮盯按需加载的并发、路径安全与协议不变量。协议沿用 aisdlc 的收敛规则：连续三轮仍有阻塞则暂停请你裁决。

## Rollback
- **首份持久化数据**：此前没有任何落盘数据，v1 是首个形状。revert 本 PR 后，已产生的 `yuanshu.db` 与 `sessions/` 留在用户磁盘上但不会被旧代码读取，也不会被破坏；因为旧版本不认识该数据，用户应在回退前备份数据目录。
- **前向兼容**：由 R2 保证——比代码新的数据库拒绝启动，旧代码不会在新数据上写入。
- **迁移失败**：R1 的备份加事务；失败后原库不变，可从 `yuanshu.db.bak-v<旧版本>` 手动还原。本期只有 v1，实际的迁移风险在后续变更。
- **API**：`/api/v1` 既有字段只增不改；新增端点出问题时 revert 整个 PR 即可，没有已发布客户端依赖这些新端点。
- **依赖**：`better-sqlite3` 随 revert 一并移除，锁文件同步回退。
- **提交粒度**：步骤 2–4（store 层，不接入池）与步骤 5–6（接入）分开提交，store 层问题可独立撤回。

## Deviations
- 2026-10-17 步骤 1 探测结论（SDK 1.3.0，一次性探针，已删除）：
  - (a) 对未加载的会话：`SessionManager.open(file, dir)` 后 `appendSessionInfo(name)` 立即追加写入 JSONL，重新打开能读回名称；不需要创建 AgentSession。
  - (b) `getBranch()` 返回当前分支的条目，包含 `role:"system"` 的 message 条目，需过滤；user 消息 content 为字符串，assistant 为内容块数组，`messageText` 已能处理两种形状。`session_info` 条目不在 message 之内。
  - (c) 悬挂工具调用重放时 SDK 自己补 `"No result provided"` 的 tool 结果；`sendCustomMessage({customType, content, display:false}, {deliverAs:"nextTurn"})` 在空闲会话上可用：通知在下一次 prompt 时作为 custom_message 条目写入 JSONL，并随历史进入此后所有请求。因此 R12 的“只出现一次”由“只发送一次”保证，不会重复追加；通知位于历史末尾、本次用户消息之前（不是请求的最后一条），语义仍是“历史末尾的附加通知”，spec 的“末尾”按此理解，不改 Requirements。custom_message 不是 message 条目，不会出现在历史分页里。
  - (d) better-sqlite3 13.0.3 在 Node 22.19.0（SQLite 3.53.4）与 Node 24.13.1 下均可加载。

- 2026-10-17 步骤 3 探测：`SessionManager.open` 对**空文件**会重写该文件并生成新的会话 id（字节改变、id 与文件名不一致）；对无头文件或乱码抛错、文件不变。因此对账与恢复在调用 SDK 之前，先用只读的文件头校验（首行是 JSON 对象、`type:"session"`、`id` 等于文件名里的 id、带时间戳），校验不过就跳过并警告，绝不把文件交给 SDK。对账时的创建时间与名称由我们只读解析（头行与 `session_info` 条目，二者是 SDK 导出的类型），不经 SDK 的 open。
- 2026-10-17 步骤 3 变异验证：去掉 UUID 格式校验不会使用例变红——定位只用“列目录加文件名后缀精确相等”，从不拼接 id，所以格式校验是纵深防御而非唯一屏障；穿越类 id 用例仍断言结果为 null。其余变异（不校验文件头、不补建、孤儿索引不删、名称取第一条）均变红。

- 2026-10-17 步骤 6 回归：既有测试里三处断言随新行为更新——数据目录启动后含 `sessions` 与 `yuanshu.db`（原为空）；会话列表按创建时间升序（与 spec R13 一致）。新增 `src/api/persist.test.ts` 覆盖 R2、R3、R11–R17 与重启恢复端到端。
- 2026-10-17 步骤 6 补充：`scripts/smoke-package.sh` 原断言“数据目录启动后为空”，随持久化改为只含 `sessions` 与 `yuanshu.db`；同时清掉 lint 警告。`scripts/check.sh` 全量通过（server 270 项、web 1 项）。
