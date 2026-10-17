# Spec: 持久化与恢复
Author: bluezeamer
Status: draft
Date: 2026-10-17

> 写成 delta：决策已在 ADR，此处只引用。存储与版本见 [ADR-0022](../../../genesis/adr/0022-sqlite-driver.md)、[ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md)（取代 0023），REST 契约见 [ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)，既有事件协议见 [ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0004](../../../genesis/adr/0004-state-storage-recovery.md)、[ADR-0022](../../../genesis/adr/0022-sqlite-driver.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)
下游: plan.md、PR 定稿后回填

## Requirements

**存储与版本**
R1. 启动时在数据目录打开 `yuanshu.db` 并迁移到当前结构版本（`PRAGMA user_version`）。全新数据库直接建到当前版本，不产生备份。旧版本数据库迁移前复制为 `yuanshu.db.bak-v<旧版本>`，每步迁移在一个事务内，任一步失败则回滚并启动失败，原库不变。
R2. 数据库版本高于代码支持的版本时必须拒绝启动，错误信息含两个版本号，且不得修改数据库与会话文件。
R3. 数据库打开后持有独占锁；同一数据目录上的第二个 Server 实例必须启动失败并说明原因，不得与第一个并发写入。Server 停止时关闭数据库并释放锁。
R4. 没有会话工厂的 `yuanshu serve` 同样打开并迁移数据库（版本契约与是否能创建会话无关）；`GET /api/v1/sessions` 返回索引中的会话。

**会话文件与索引**
R5. 会话 JSONL 位于 `sessions/` 下，文件名由 SDK 生成（`<时间>_<id>.jsonl`）。定位会话只按文件名后缀 `_<id>.jsonl` 在 `sessions/` 内精确匹配，不得用请求里的 id 拼接路径；`id` 不是 UUID 格式的请求一律按 404 处理，不得触碰文件系统之外的路径。
R6. 索引表 `sessions(id, name, created_at, updated_at)`。会话首次出现 JSONL 后写入索引；每次运行结束更新 `updated_at`；名称以 JSONL 为准，索引只是缓存。
R7. 启动对账：`sessions/` 中有而索引中没有的会话，补建索引行（`created_at` 取会话头时间，`updated_at` 取文件修改时间，名称取 JSONL 中最后一条会话名称）；索引中有而文件不存在的，删除该行并记一条警告。无法解析的文件（不符合命名或会话头损坏）跳过并记警告，不得使启动失败，也不得删除。对账不得修改任何 JSONL。
R8. 没发过消息的会话没有 JSONL，重启后不出现；运行期间它存在于池里，列表仍可见。

**恢复**
R9. 重启后，已持久化的会话在列表里；首次被访问（`GET :id`、stream 升级、历史拉取、改名）时才从 JSONL 加载进池，之后与新建会话行为一致，可继续对话，历史随请求发给模型。未被访问的会话不占用池内存。
R10. 恢复出的会话，快照的 `messages` 取 JSONL 当前分支上最近 50 条 user/assistant 消息（与既有窗口规则一致，文本截断规则同 R16 of 前一变更：每条 32 KiB）；`running` 为 false。事件序号对每个加载进池的会话从 0 重新开始（ADR-0005）。
R11. 同一会话被并发首次访问时只加载一次，所有访问方得到同一个池内会话；加载失败（文件损坏）返回 `500 { error: "session_load_failed" }`，该会话不进池，也不影响其他会话。
R12. 恢复时若 JSONL 末尾的助手消息含没有对应结果的工具调用，必须在该会话的下一次模型请求末尾携带一条明确的"上一次运行被中断，其中的工具调用没有得到结果，是否重做由你判断"的通知（[ADR-0004](../../../genesis/adr/0004-state-storage-recovery.md)）；通知只出现一次，且不得改写已有历史或前缀。

**会话管理 REST**（契约见 ADR-0024）
R13. `PATCH /api/v1/sessions/:id`：`name` 去掉首尾空白后为 1–200 字符，否则 400 `bad_request`；成功写入 JSONL 并更新索引，返回更新后的条目；对未加载的会话同样有效且不必加载进池。
R14. `DELETE /api/v1/sessions/:id`：运行中返回 409 `{ error: "session_running" }`，什么都不删；否则关闭池内会话（断开其全部连接，close 码 1001）、删除 JSONL、删除索引行，返回 204。删除后该 id 再访问为 404；对未加载的会话同样有效。JSONL 删除失败时返回 500 且保留索引行，不得出现"索引已删、文件还在"导致孤儿被对账补回的静默回弹。
R15. 会话条目与列表：`{ id, name, createdAt, updatedAt, running }`，`name` 未设置时为 `null`，列表按 `updatedAt` 倒序，包含池内尚未持久化的会话。
R16. `GET /api/v1/sessions/:id/messages?before=&limit=`：返回 JSONL 当前分支上 user/assistant 消息，`before` 为不透明游标、缺省表示从最新开始，`limit` 默认 50、上限 200，非法值 400；`{ messages: [{ index, role, text }], nextBefore }`，按时间正序，`nextBefore` 在没有更早消息时为 null；`text` 为完整文本，不截断。游标对新到达的消息稳定（不重复、不遗漏）。
R17. `GET /api/v1/sessions/:id/messages/:index`：返回该序位消息的完整文本 `{ index, role, text }`；越界 404，`index` 非非负整数 400。不要求会话已加载。

**不变量**
R18. 持久化不得改变既有协议行为：事件序号、快照形状、背压、截断规则保持不变；所有既有测试必须继续通过。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | 临时数据目录：全新库 version=当前且无 .bak；构造 v0 旧库迁移后有 .bak-v0 且数据保留；迁移中途抛错，库与版本不变 | 变异：迁移不放事务 / 不备份，必须变红 |
| R2 | 构造 user_version=999 的库，启动失败，信息含两个版本号，库文件字节不变 | 变异：忽略版本比较，必须变红 |
| R3 | 同一数据目录起两个 Server，第二个启动失败；第一个停止后第二个可启动 | 变异：不加独占锁，必须变红 |
| R4 | 无工厂的 Server 启动后数据库存在且已迁移，列表来自索引 | 是 |
| R5 | 路径穿越类 id（`../x`、`%2e%2e`、超长、含 NUL）→ 404 且不触碰目录外文件；用后缀匹配定位 | 变异：用 id 拼路径，穿越用例必须变红 |
| R6、R7 | 对账用例：缺索引补建（含名称、时间）、缺文件删行并有警告、坏文件跳过且不删、对账前后所有 JSONL 字节不变 | 变异：对账时删除孤儿文件 / 不补建，必须变红 |
| R8 | 创建空会话，列表可见；重启（新 Server 同数据目录）后消失 | 是 |
| R9、R10 | 对着 stub 对话两轮 → 停止 Server → 新 Server 同目录：列表在；未访问时池为空；访问后快照含最近消息、继续发消息时 stub 收到的请求含历史 | 变异：启动时全部加载 / 不播种窗口，必须变红 |
| R11 | 并发 20 次首次访问同一会话，工厂只被调用一次；损坏 JSONL 返回 500 且其他会话正常 | 变异：不做并发去重，必须变红 |
| R12 | 构造末尾带悬挂 toolCall 的 JSONL，恢复后发一条消息：stub 收到的请求末尾含通知；再发一条不再含通知 | 变异：不加通知，必须变红 |
| R13 | 改名（已加载与未加载各一）→ 重启后仍在；空白、过长、缺字段 → 400 | 变异：只改索引不写 JSONL，重启后名称丢失，必须变红 |
| R14 | 运行中 409 且文件与索引都在；空闲删除后文件、索引、池内会话都消失，连接被关闭；删除文件失败（目录只读）→ 500 且索引保留；重启不回弹 | 变异：先删索引后删文件且不处理失败，回弹用例必须变红 |
| R15 | 列表字段、排序、包含未持久化会话 | 是 |
| R16 | 120 条消息分页遍历：无重复无遗漏、顺序正确；遍历中途追加新消息，已取页不变；limit 边界与非法游标 | 变异：用偏移量分页，中途追加用例必须变红 |
| R17 | 取被截断消息的全文，与 JSONL 一致；越界与非法 index | 是 |
| R18 | 全量既有测试；`scripts/check.sh` | 不适用 |

## Design
- **新增模块**：`src/store/db.ts`（打开、锁、迁移、备份）、`src/store/sessions.ts`（索引读写、对账）、`src/store/history.ts`（从 JSONL 读消息、分页）。池依赖这三者，路由层只做协议编解码。
- **会话工厂签名变化**：`(opts: { id: string; sessionDir: string; file?: string }) => Promise<AgentSession>`。池传入 id 与 `sessions/` 目录；恢复时多传 `file`。工厂负责 `SessionManager.create(cwd, sessionDir, { id })` 或 `SessionManager.open(file, sessionDir)`，cwd 的来源（workspace）属于第 6 条，本期由工厂决定（测试用临时目录）。
- **池**：`create()` 生成 id 后调用工厂；`acquire(id)`（异步、去重）负责按需加载；`get` 仅查池内。索引行在会话首次出现 JSONL 后写入（运行结束时检查文件是否存在），`updated_at` 同时更新。
- **改名与删除对未加载的会话**：只读写 JSONL 与索引，不进池。改名用 SDK 公开接口追加会话名称条目（实现时用契约测试确认对未加载会话的写入方式与持久化时机）。
- **历史读取**：用 SDK 公开接口打开 JSONL，取当前分支上 user/assistant 消息；序位（`index`）是该序列中的位置。
- **中断通知**：恢复时检测悬挂工具调用，加载后标记；下一次 `send` 时以 SDK 支持的"下一轮附加"方式追加通知（实现时读源码确认接口，首选不改历史的方式）。
- **迁移机制**：版本表驱动，`migrations[n]` 把版本 n-1 升到 n；本期只有 v1（建 `sessions`）。
- **依赖**：`better-sqlite3`（[ADR-0022](../../../genesis/adr/0022-sqlite-driver.md)），精确锁定。
- **迁移与兼容**：此前没有任何持久化数据，v1 是首个形状；`/api/v1` 既有端点与字段只增不改（`GET sessions` 条目新增 `name`、`updatedAt`）。

## Risks
- 对账随会话数量线性增加启动时间；单用户规模可接受。需要时改为只比较目录与索引的文件名集合（本期已是如此，只在补建时才读文件）。
- 会话 JSONL 由 SDK 写入，其内部格式随 SDK 版本变化；我们只经公开接口读，升级 SDK 时契约测试覆盖加载与改名。
- 独占锁依赖 SQLite 的文件锁语义，在网络文件系统上不可靠；数据目录应在本机磁盘，文档注明。
- 对账补建的孤儿会话会"复活"出现在列表里；这是"JSONL 为准"的直接后果（ADR-0025）。
- 迁移备份文件不会自动清理。
