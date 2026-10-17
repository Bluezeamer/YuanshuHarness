# Review: 会话池与带序号的事件流

Reviewer: 每轮由新开的空上下文 subagent 执行（见 references/review.md）；人在 MR 上做最终评审

> 每一轮评审追加一节。评审记录写在这里，不写进 spec。
> 连续三轮仍有阻塞级问题 → 暂停，回到 spec 澄清口径，必要时请人裁决或升档。

## 第 1 轮（2026-10-17）— 范围：06c93dbf85a10dd5941194559f85fc82929377fa..c26816e35e6970d75612984283e07f6eeb126e6d — 执行：codex

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 阻塞 | `packages/server/src/session/events.ts:96` | 违反 R5：`queue_update` 固定按 `steering`、`followUp` 分组拼接，不能保留两类消息的全局送达顺序。复现：先送达 follow-up `a`，再送达 steering `b` 时，事件仍输出 `["b", "a"]`；现有测试只覆盖了 steering 恰好先到的排列。 | 驳回：SDK 总是先送达 steering、后送达 follow-up（follow-up 仅在没有工具调用和 steering 时才取），分组拼接就是送达顺序；复现用的先 follow-up 后 steering 的次序在 SDK 里不会出现。spec R5 措辞已澄清；本期只用 steer |
| 阻塞 | `packages/server/src/api/sessions.ts:142` | 违反 R9/R10：每条消息都以 `void handle(...)` 并发执行，没有串行化同一连接的命令。运行中背靠背发送 `stop`、`send_message` 时，`stop` 在等待 `abort()`，后一命令会先被排入正在中止的 SDK run 并成功 ack；SDK 1.3.0 的 abort 不清 steering queue，该消息不会启动新运行，要等未来另一条 prompt 才可能被取走。现有测试都先等待前一 ack，未覆盖此路径。 | 已修：同一连接命令串行执行；新增用例 stop 与 send_message 背靠背，消息在中止后启动新运行 |
| 阻塞 | `packages/server/src/api/sessions.ts:106` | 违反 R14：只在写入前检查旧的 `bufferedAmount`，没有计入本帧或在写入后复查；一个快照/事件可把积压从阈值以下推到 4 MiB 以上，若之后没有事件就永远不会触发 1013。现有背压测试依靠后续多帧才触发检查，未覆盖最后一帧越线。 | 已修：写入后再查一次积压；新增用例（快照单帧越线）。取舍：单帧本身超过阈值的连接也会被断开，正常回复远小于阈值 |
| 重要（待确认） | `packages/server/src/api/sessions.ts:198`、`packages/server/src/session/pool.ts:212` | R15 关闭时序仍需真实运行验证：应用钩子调用 `socket.close()` 后立即释放会话，但没有显式等待连接 `close` 事件或 SDK 清理完成。`@fastify/websocket` 的默认 `preClose` 会关闭连接并调用 `wss.close(done)`，随后立即 `done()`；`ws` 的 noServer `close` 回调会等客户端关闭，Fastify 再关闭 HTTP 服务。仅凭静态源码尚不能证明 `stop()` 返回时仍有连接或定时器；缺少 Fastify、Node 与升级连接关闭时序的集成验证。 | 推迟：已有 R15 用例断言连接全部关闭且每个会话 dispose 一次（变异验证过）；`stop()` 返回时无遗留句柄的更强断言留给评审第 2 轮复核 |
| 阻塞 | `packages/server/src/api/sessions.ts:28` | 违反 R9：`parseImages` 只检查 `data` 是字符串，不验证它是 base64；如 `{ mimeType: "image/png", data: "!" }` 会被成功 ack 并交给 SDK，而 Node 的 base64 解码会宽松地产生错误/空内容。现有非法图片测试只覆盖非字符串。 | 已修：校验 base64（长度为 4 的倍数且字符集合法）；用例使用支持图片的模型，使该检查独立生效 |
| 重要（待确认） | `packages/server/src/session/pool.ts:83`、`packages/server/src/session/pool.ts:197` | 存在运行生命周期时序风险，但不是已确认的 R6 违约：R6 要求运行失败时发送 `run.failed`，没有规定它必须先于 `run.ended`。若 SDK 抛错路径先触发 `agent_settled`、再使 `prompt()` reject，当前 `.catch()` 可能在 `run.ended` 后发送 `run.failed`；若此前已记录错误助手消息，还需确认是否会重复发送。`/tmp` 最小模拟复现了 `run.started → run.ended → run.failed`，但缺少真实 SDK 运行证据确认该时序。 | 待第 2 轮复核：prompt() 在 provider 失败时 resolve 不抛错（探测已证），run.failed 由 agent_settled 路径发出；抛错路径仅用于 SDK 前置校验失败 |
| 建议 | `packages/server/src/session/pool.ts:174` | `dispose()` 后直接调用 `subscribe()` 仍可重新登记订阅者，`resync()` 也未检查 `disposed`；最小复现 `entry.dispose(); entry.subscribe(sub)` 会让 `subscriberCount` 从 0 回到 1。目前未发现生产路径会在 dispose 后调用这些内部 API，因此这是内部 API 终态约束建议，不据此认定违反 R15。 | 已修：dispose 后 subscribe/resync 抛 PoolError |
| 建议 | `packages/server/src/session/pool.ts:150` | 广播使用订阅集合快照；合成的 `Subscriber.send()` 若重入并退订后续订阅者，该订阅者仍会收到当前帧。生产 `writeRaw` 会检查 WebSocket `readyState`，退订则由异步 `close` 事件触发，尚无证据表明生产路径可触发该情形；可作为广播重入行为的测试建议，不认定违反 R13。 | 驳回：生产路径的 send 不会重入退订，合成场景无实际影响 |
| 建议 | `packages/server/src/api/sessions.ts:105` | 生产路径遗留逐帧 `console.error`，每个文本 delta 都会记录缓冲量与帧长度并绕过 Fastify logger。它是否会阻塞事件循环或拖慢同会话其他连接尚未证实，不据此认定违反 R14；建议移除临时日志。 | 已修：这是我调试时遗留的 console.error（sed 误删了 if 行），已删除 |
| 建议 | `packages/server/test/support/stub.ts:96` | 测试 stub 的 listen Promise 不监听 `error`；当前受限环境拒绝监听时，`pnpm --filter yuanshu-harness-server test` 报 `EPERM` 后永久悬挂而非失败退出，只能人工终止。应让监听错误 reject，保证测试结论可复现。 | 已修：listen 监听 error 并 reject |
| 建议 | `packages/server/src/session/pool.ts:3` | `toChatMessage` 导入后未使用，是本次新增的死代码。 | 已修：删除未用的导入 |

本轮阻塞级：4 条。

## 第 2 轮（2026-10-17）— 范围：06c93dbf85a10dd5941194559f85fc82929377fa..d60854131b4e604f458409a57d6a3c79d1e9b44d — 执行：codex

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 阻塞 | `packages/server/src/api/sessions.ts:206`、`packages/server/src/api/sessions.test.ts:395` | 违反 R15：`preClose` 只发起 `socket.close()` 就立即返回，未等待各连接的 `close`；`@fastify/websocket` 11.3.4 的默认 `preClose` 同样在调用 `websocketServer.close(done)` 后立即调用 `done()`。用插件自带的内存 WebSocket（无需监听端口）暂停客户端读取后实测：`await app.close()` 已返回、池已 dispose，但服务端仍为 `CLOSING`、客户端仍为 `OPEN`，连接及 `serve()` 创建的心跳定时器要等关闭握手或 `ws` 的关闭超时才释放。现有测试在 `await server.stop()` 之后才调用 `waitClosed()`，因此没有断言“stop 返回时已关闭”。 | 已修：preClose 等待每个连接真正关闭（对端不配合 1 秒后 terminate）再返回；R15 用例改为断言 stop() 返回时连接已关闭，变异验证（去掉等待）变红 |
| 重要 | `packages/server/src/api/sessions.ts:107` | R14 的“内存增长有界”没有被 4 MiB 阈值真正约束：代码先把已完整序列化的任意大小帧交给 `socket.send()`，再检查 `bufferedAmount` 并关闭；一个大快照或工具事件可在关闭前一次性排入远超阈值的数据，关闭帧还会排在数据之后，内存持续到排空或关闭超时。`packages/server/src/api/sessions.test.ts:345` 用 1 MiB 阈值发送 8 MiB 快照，只断言最终 1013，实际固化了“先超额入队、后关闭”，没有证明内存有界。上轮“最后一帧越线也会关闭”已修，但背压预算仍不是硬上限。 | 已修：改为硬上限——已排队字节加本帧超过阈值就不写入、直接断开；spec R14 改写，明确单帧超 4 MiB 的连接会被断开。快照越线用例在改回软检查时变红 |
| 重要 | `packages/server/src/api/sessions.ts:30`、`packages/server/src/api/sessions.ts:149` | 入站只有“单条消息 50 MiB”限制，没有每连接待处理条数或总字节上限。每个 `message` 都把 `RawData` 捕获进 Promise 串行链；当前 `stop` 等待 `abort()` 时，客户端仍可持续提交接近上限的消息，原始 Buffer 会无界滞留，连接关闭也不取消已排队任务。处理时又同时保留 `raw.toString()`、`JSON.parse` 结果；`images` 不限数量且 `parseImages` 为每项再建对象，随后 `SessionEntry.send()` 还会再次 `map`，所以 50 MiB 线长不能形成可靠的内存/CPU 上限。现有背靠背测试只有两条小消息且等待很短，未覆盖积压。 | 已修：每连接待处理字节上限 50 MiB（超限 1013），images 最多 20 项；两条用例，变异验证均变红 |
| 建议 | `packages/server/test/support/ws-client.ts:49`、`packages/server/src/api/sessions.test.ts:188` | R11 要求每条命令“恰好一个 ack”，但测试助手只等待“存在一个同 id ack”，非法输入助手也只等待 ack 数量增加；若实现对同一命令发送两个相同 ack，现有用例仍可能通过。应按命令 id 断言最终计数恰为 1。 | 已修：R11 用例增加“带 id 的 ack 各只出现一次”的断言 |

本轮阻塞级：1 条。

验证：补齐仓库 Node 24 工具链 PATH 后执行 `cd packages/server && npx vitest run`，结果为 8 个测试文件通过、10 个失败，149 项中 106 通过、43 失败，另有 5 个未处理错误；失败根因均为沙箱禁止监听端口（`listen EPERM`），因此不能据此确认网络集成用例。无需端口的 `src/session/events.test.ts` 6 项全过；另用 `/tmp` 内存 WebSocket 探针确认了上述 R15 时序。

上轮核对：同连接命令串行、写后背压复查、base64 字符与长度校验、dispose 后拒绝订阅，以及调试日志、stub 监听错误和未用导入的清理均已在当前代码中确认；R5 队列顺序的驳回理由与澄清后的 spec 一致。上轮 R15 待确认项未消失，已在本轮升级为阻塞。

## 第 3 轮（2026-10-17）— 范围：06c93dbf85a10dd5941194559f85fc82929377fa..ee9a04c7d398d363441ac457fdd100aba69d82c8 — 执行：codex

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 阻塞 | `packages/server/src/api/sessions.ts:113`、`packages/server/src/api/sessions.ts:130`、`packages/server/src/api/sessions.ts:151` | 违反 R14：`serve()` 先把连接加入 `sockets`，随后 `entry.subscribe()` 同步发送首帧，最后才安装 `close` 清理。大快照触发硬上限时，`writeRaw()` 会先 `close(1013)` 再抛错，控制流因此在安装清理监听器之前退出；这个已关闭连接永远不会从 `sockets` 删除。客户端反复重连到同一个大快照会线性积累 WebSocket 对象。新增的“快照单帧越线”用例只断言关闭码，没有断言连接资源释放。 | 已修：close 监听器改为先于 subscribe 安装，首帧失败不再中断流程；新增用例（连续 3 次连到大快照，订阅与 ws 客户端集合均归零）。注：该用例观测不到内部 sockets 集合本身，第 4 轮请复核 |
| 阻塞 | `packages/server/src/api/sessions.ts:236`、`packages/server/src/api/sessions.ts:239` | 违反 R15：1 秒强制终止定时器只调用了 `unref()`，连接正常关闭时没有 `clearTimeout()`；`close` 监听器只解析 Promise，所以 `stop()` 可在定时器仍排队时返回。用编译后的 HEAD 配合 `injectWS` 做无端口探针并模拟对端 10 ms 内完成关闭，`app.close()` 在 11 ms 返回，此时捕获的 1 秒定时器仍为 `_destroyed: false`。`unref()` 不等于取消，且定时器闭包在到期前仍持有 socket。默认 `@fastify/websocket` 的 `preClose` 与本钩子并存未造成永久等待：不配合关闭的内存连接在约 1 秒后由 `terminate()` 收敛。 | 已修：强制终止定时器在连接 close 时 clearTimeout，不再依赖 unref |
| 重要 | `packages/server/src/api/sessions.ts:151`、`packages/server/src/api/sessions.ts:169`、`packages/server/src/session/pool.ts:211` | 连接关闭只清理心跳、订阅和 `sockets`，不取消或拆除串行 `chain`。若当前 `stop` 正在等待 SDK `abort()` 变为空闲，后续已计入上限的消息仍由 `.then()` 闭包捕获；即使连接已经关闭，它们也只能等前一 Promise 完成后才跳过处理并在 `finally` 回减。一个长期不收敛的工具/运行可让已关闭连接继续保留接近 50 MiB 原始帧，重复连接可叠加。超限的触发帧在 `packages/server/src/api/sessions.ts:165` 确实没有回减 `pending`，但该分支没有把该帧加入 chain；实质风险是此前已入链帧在关闭后无法释放。 | 已修：串行链改为显式队列，连接关闭时清空队列并归零 pending，已收未处理的帧立即释放 |

本轮阻塞级：2 条。

复核补充：硬背压现已在 `send()` 前按 `bufferedAmount + frame bytes` 拒绝写入，`images` 上限为 20；正常及已知错误命令路径各调用一次 `ack`，未发现重复发送。当前 `handle()` 会吸收已知异常，单个已执行任务由 `finally` 回减一次，未确认减两次或常规异常导致 chain 拒绝的路径。类型检查通过；`events.test.ts` 6 项通过，`sessions.test.ts` 与 `pool.test.ts` 因沙箱禁止监听 `127.0.0.1`（`listen EPERM`）无法运行其网络用例，关闭时序改用 `injectWS` 探针验证。
