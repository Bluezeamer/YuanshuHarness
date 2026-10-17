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

## 第 4 轮（2026-10-17）— 范围：ee9a04c7d398d363441ac457fdd100aba69d82c8..7b5bb46ffdce75b14aab6cc89d7621a935a9c23f；兼顾 06c93dbf85a10dd5941194559f85fc82929377fa..7b5bb46ffdce75b14aab6cc89d7621a935a9c23f — 执行：codex

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 重要 | `packages/server/src/api/sessions.ts:174`、`packages/server/src/api/sessions.ts:189` | 超限或背压调用 `socket.close()` 后，连接先进入 `CLOSING`，但队列只在最终 `close` 事件中清空；`drain()` 与 `message` 监听器没有检查连接状态。用 `injectWS` 暂停客户端读取，先排入一个等待中的 `stop` 和一个 `send_message`，再触发入站超限；服务端已是 `CLOSING`，释放 `stop` 后，排队消息仍调用 `SessionEntry.send()`，其 ack 无法写回。超限分支及后续关闭握手期间收到的消息还会增加 `pending`，却未入队、也没有对应扣减，直到最终 `close` 才归零。该路径会产生无 ack 的命令副作用，pending 也暂时不再代表待处理字节。 | 已修：drain 与 message 监听器都先检查连接是否 OPEN，非 OPEN 即丢弃队列并归零 pending。未单独加用例（需暂停读取的内存连接才能稳定复现），由评审探针与现有关闭用例覆盖，如实记录 |


复核：第 3 轮首帧失败路径现先安装 `close` 监听器再订阅，首帧写入异常被捕获；关闭处理执行 `unsubscribe()` 和 `sockets.delete()`，连续大快照连接后订阅及 WebSocket 客户端集合归零。强制终止定时器在 `close` 监听器中清除，未发现新的计时器残留路径。显式 drain 的 `draining` 门闩避免并发 drain，出队命令在 `finally` 中只回减一次 pending；但上述 CLOSING 竞态未被覆盖。

验证：`pnpm --filter yuanshu-harness-server typecheck` 通过；`events.test.ts` 6 项通过。`pool.test.ts` 与监听端口的 API 集成测试受沙箱限制，报 `listen EPERM`；`injectWS` 内存连接探针复现了表中竞态。检查范围包括最近提交相对第 3 轮的增量和指定全量基线差异。

本轮阻塞级：0 条。

## 第 5 轮（2026-10-17）— 范围：6325f857eac241d3d73fa4d43e956284377625ad..fd874ccc721f9dead897668bd18365065dc5e83f — 执行：codex

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 阻塞 | `packages/server/src/session/events.ts:128`、`packages/server/src/session/events.ts:130`、`packages/server/src/session/pool.ts:174`、`packages/server/src/api/sessions.ts:121` | 违反 R14/R16：`boundStrings` 只限制单个值字符串和深度，不限制数组元素数、对象键数或键长；快照的 `queue` 也没有条目上限。因此 `tool.started.args`、`tool.updated.partialResult`、`tool.ended.result`、`queue.updated` 及重连快照仍可产生任意大的单帧。精简探针中，2 MiB 对象键、50 万个布尔数组元素、30 万字节 Buffer 分别序列化为约 2.0/3.0/3.2 MiB，三者均返回 `truncated:false`，继续放大时帧线性增长；Buffer 还会被 `Object.entries` 展开并膨胀。此时 `writeRaw` 在 `bufferedAmount === 0` 时无条件发送该帧，故 R14 声称的“阈值加一帧”仍没有有限上界。循环引用会在第 8 层被置为 null，不是本问题的绕过路径。 | 已修：boundStrings 增加数组/对象 200 项、键 256 字符上限，非普通对象（Buffer 等）置 null；再加整帧 1 MiB 兜底 capFrameData（宽度乘长度仍超限时只留短标量）。单测覆盖，兜底变异验证变红 |
| 重要 | `packages/server/src/session/events.ts:121` | 按 UTF-16 code unit 直接 `slice(0, max)` 会切断代理对。探针以 `max - 1` 个 ASCII 字符后接一个 emoji，截断结果末尾为孤立高代理项 `0xD83D`；`JSON.stringify` 会将它转义，所以 JSON 语法仍合法，但客户端解析后得到的仍是非法 Unicode 序列，展示或再次编码时会出现替换字符。事件和快照使用同一函数，`tool.*`、`message.*.text` 与 queue 条目均受影响。 | 已修：截断不留孤立高代理项；变异验证变红 |
| 重要 | `packages/server/src/session/pool.ts:129`、`packages/server/src/session/pool.ts:174` | 截断后的 `message.ended.data` 被整体强制转换成 `ChatMessage` 存入 `recent`，连事件级顶层的 `truncated:true` 也一并保存；重连快照随后输出 `{ role, text, truncated }`，不再是 R7 规定的 `{ role, text }`，也违反 R16“所在 `data` 顶层带 `truncated`”的层级约定。精简 SessionEntry 探针确认：300 KiB 消息的 seq=1 事件与 seq=1 快照中，快照顶层已有 `truncated:true`，但 `messages[0]` 仍额外残留同名字段。 | 已修：recent 只存 {role,text}，快照形状符合 R7；变异验证变红 |
| 重要 | `packages/server/src/api/sessions.test.ts:347`、`packages/server/src/session/events.test.ts:1`、`packages/server/src/session/pool.test.ts:124` | R16 测试只断言一个超长回复的 `message.ended` 和快照文本长度；没有直接测试 `boundStrings`，也未覆盖 `tool.started.args`/`tool.ended.result`、宽数组/对象及对象键、Buffer/循环引用、8 层深度边界、代理对、queue 条目数量，且未断言截断后快照消息的精确形状。因而上述 R16/R7 缺陷均不会使现有测试变红；对 `message.delta` 和 `message.started` 的截断标记也没有断言。 | 已修：新增 boundStrings/capFrameData 单测（宽度、长键、Buffer、深度、代理对、兜底）与快照形状用例。tool.* 端到端用例未单独加，由单测覆盖 mapEvent 之后的有界逻辑，如实记录 |

复核补充：`emit()` 先以实际广播的截断数据执行 `apply()`，再同步增加 seq 和广播；除上表中的快照字段形状外，未发现新的 R7 订阅窗口或序号缺口。`ws` 8.22.0 的 `bufferedAmount` 读取 socket 可写队列长度与 sender 缓冲，当前未启用压缩且 `send()` 同步入队；未找到“连续写入但 bufferedAmount 尚未更新”的独立绕过证据，真正破坏内存上界的是 R16 仍允许任意大单帧。

验证：`pnpm --filter yuanshu-harness-server typecheck` 通过；`events.test.ts` 6 项通过。定向 API 测试在套件初始化时因沙箱禁止监听端口报 `listen EPERM`，未执行用例；其余结论由源码核对和 `/tmp` 精简探针得到。

本轮阻塞级：1 条。

## 第 6 轮（2026-10-17）— 范围：fd874ccc721f9dead897668bd18365065dc5e83f..0f27ff372b57ee0d437735822b8da3ba5f2d3ab5 — 执行：codex

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 阻塞 | `packages/server/src/session/events.ts:145`、`packages/server/src/session/events.ts:152`、`packages/server/src/session/events.ts:159`、`packages/server/src/session/events.ts:171`、`packages/server/src/session/events.ts:178`、`packages/server/src/session/pool.ts:72` | 违反 R5/R16：`boundStrings` 的“非普通对象置 null”检查本身会触发 Proxy 的 `getPrototypeOf` trap，数组映射及 `for...in` 取值会执行 getter；这些异常没有被兜底，会从 SDK 同步回调直接抛出，该次映射事件不广播。`for...in` 还会把 `Object.prototype` 上的可枚举属性复制进载荷。`/tmp/session-entry-r6-probe.mjs` 以 `tool_execution_start.args` 的抛错 getter 复现 `Error: getter boom`，只收到初始快照和之后的 `run.started(seq=1)`，没有 `tool.started`；`/tmp/session-pool-r6-probe.mjs` 同样复现两个 Proxy trap 抛出及原型链属性进入结果。`capFrameData` 的 catch 也不是闭合异常路径：`toJSON` 在抛错前给对象加入抛错 getter 后，catch 后的 `Object.entries(data)` 再次抛出。SDK 的 `_emit` 不捕获 listener 异常，故会把异常继续传回 SDK 执行链。 | 已修：改为一次 JSON.stringify（replacer 截断字符串、BigInt 转串）放在 try 里，不再手写遍历；onSdkEvent 整体 try/catch。getter/Proxy/toJSON/循环引用单测与 SessionEntry 级用例；去掉监听器兜底的变异变红 |
| 阻塞 | `packages/server/src/session/events.ts:135`、`packages/server/src/session/events.ts:166`、`packages/server/src/session/events.ts:172`、`packages/server/src/session/events.ts:176`、`packages/server/src/session/pool.ts:108`、`packages/server/src/session/pool.ts:112`、`packages/server/src/session/pool.ts:163` | 违反 R7/R16：1 MiB 兜底按 UTF-16 `JSON.stringify(...).length` 判断，且检查后在 `frame()` 中对原对象再次序列化，并不约束真正发出的 UTF-8 字节。探针中 80 万个汉字组成的合法有界数组为 800,612 code units、2,400,612 bytes，真实事件帧为 2,400,778 bytes且无 `truncated/omitted`；有状态 `toJSON` 在容量检查时返回短值、成帧时返回长值，真实帧为 2,097,315 bytes。300,000 位 BigInt 又在字符串分支之后转成 300,000 字符且不标截断。函数/Symbol 不会让 `JSON.stringify` 抛错，而会静默丢字段；`toJSON` 也会改写字段，故 `apply()` 使用的对象不一定等于线上 `data`：探针中事件的 `toolCallId` 为 `wire-id`，随后同一 seq 状态的快照却为 `[object Object]`，函数/Symbol ID 则在事件中消失、快照中分别出现函数字符串与 `Symbol(id)`。 | 已修：按 Buffer.byteLength 判断 1 MiB；事件与状态都用 sanitizeData 的返回值，线上形状与状态一致（toJSON id 用例）；BigInt 截断。字节/字符变异变红 |
| 阻塞 | `packages/server/src/session/pool.ts:139`、`packages/server/src/session/pool.ts:180`、`packages/server/src/session/pool.ts:195`、`packages/server/src/session/pool.ts:202` | 违反 R14/R16：快照逐级收紧会在三轮内终止，但不保证有界。`activeTools` 没有经过宽度、字符串或整帧兜底，最后 `limit === 0` 又无条件返回。真实 `SessionEntry` 探针只需两个仍处于活动状态、ID/名称各恰为允许上限 256 KiB 的工具，清空 messages 后的快照仍为 1,048,829 bytes；继续增加活动工具时可线性增长，数量也可超过 R16 的 200 项。因此空发送队列仍可写入无上界单帧，R14 的“64 MiB 加一帧”不是有限内存上界。 | 已修：activeTools 写入时限 200 个、id/name 各 256 字符，queue 限 100 条×1024 字符，快照逐级收紧终止于不含消息；大 id/name/queue 的快照字节断言，去掉工具数上限的变异变红 |
| 阻塞 | `packages/server/src/session/pool.ts:109`、`packages/server/src/session/pool.ts:145`、`packages/server/src/session/pool.ts:187`、`packages/server/src/session/pool.ts:200` | 违反 R7：整帧兜底会删除非标量字段，但 `apply("queue.updated", data)` 无条件把缺失的 `data.queue` 写入状态。以 200 个各 256 KiB 的合法字符串触发兜底时，实际事件 `data` 只有 `{ truncated: true, omitted: true }`，随后 resync 快照完全没有 R7 必需的 `queue: string[]` 字段。也就是说兜底虽让该事件变小，却把快照状态形状破坏了。 | 已修：queue 先在 mapEvent 里限条数与长度，最大约 300 KB，不会触发整帧兜底，因此 queue 字段不会缺失（原路径不可达） |
| 重要 | `packages/server/src/session/events.test.ts:95`、`packages/server/src/session/events.test.ts:123`、`packages/server/src/session/pool.test.ts:317`、`packages/server/src/api/sessions.test.ts:296`、`packages/server/src/api/sessions.test.ts:347` | 测试没有真正封住 R7/R14/R16：容量断言使用 `JSON.stringify(...).length` 而非线上的 UTF-8 字节，也没有对最终事件帧断言；缺少 getter/Proxy/原型链、typed array/Map/Set/Date/循环引用、BigInt/函数/Symbol、`toJSON` 与异常 fallback 用例；快照用例不断言帧大小、`activeTools`/`queue` 上限，且对 `messages ?? []` 循环，消息被错误清空也能通过。所有 R14 测试都注入小阈值，没有断言 `DEFAULTS.maxBufferedBytes === 64 MiB`，所以把 HEAD~1 的默认值改回 4 MiB 仍不会使测试变红。 | 已修：用例改按 UTF-8 字节断言、补 getter/Proxy/toJSON/循环引用/BigInt/queue/activeTools 用例；新增“默认背压阈值为 64 MiB”断言（改回 4 MiB 变红） |

第 5 轮核对：宽数组/普通宽对象/长键、Buffer、typed array、Map、Set、Date、循环引用、超深结构及代理对均已按预期收敛；普通重载的 `capFrameData` 兜底为 82 bytes，`recent` 也只保存 `role/text`。但第 5 轮第 1、4 条只部分消失，剩余与新增缺口见上表。

验证：`pnpm --filter yuanshu-harness-server typecheck` 通过；`events.test.ts` 9 项通过。定向 `pool.test.ts -t R16` 与 `sessions.test.ts -t 'R14|R16'` 均在收集阶段因沙箱禁止监听 `127.0.0.1` 报 `listen EPERM`，0 项执行；其余结论由源码、SDK 1.3.0 `_emit` 实现和 `/tmp/session-pool-r6-probe.mjs`、`/tmp/session-entry-r6-probe.mjs` 验证。

本轮阻塞级：4 条。

## 第 7 轮（2026-10-17）— 范围：0f27ff372b57ee0d437735822b8da3ba5f2d3ab5..2121c606048000ae780ad67b96c590efdb35edfd — 执行：codex

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 阻塞 | `packages/server/src/session/events.ts:147`、`packages/server/src/session/events.ts:149` | 违反 R16：1 MiB 判断没有计入随后追加的 `truncated`。`/tmp/session-pool-r7-probe.mjs` 构造替换后恰为 1,048,576 bytes 的四个字符串，`sanitizeData` 返回的最终 data 为 1,048,593 bytes，未走 `omitted` 兜底；因此 UTF-8 判断虽已改对，最终线上 data 的字节上限仍不成立。 | 已修：判断预留 1 KiB 余量（DATA_BUDGET）；边界用例，去掉余量变红 |
| 阻塞 | `packages/server/src/session/events.ts:139`、`packages/server/src/session/pool.ts:139`、`packages/server/src/session/pool.ts:150`、`packages/server/src/session/pool.ts:159` | 违反 R7/R16：`JSON.parse` 后没有验证状态字段类型，`apply` 又对 `text/toolCallId/toolName` 做 `String(...)` 或对 `queue` 强制断言。探针中函数/Symbol `toolCallId` 被线上事件丢弃，快照却出现 `"undefined"`；对象型 `toJSON` 返回值在线上是对象，快照变成 `"[object Object]"`；300 多字符的合法字符串 ID 在线上保持原值、快照只留 256 字符。`message.delta.text` 同理可在事件缺字段时向 partial 累积 `"undefined"`。第 6 轮“函数/Symbol 与事件/状态一致性”发现并未完全消失。 | 已修：apply 只取类型正确的字段，不再 String() 强转；工具 id 超长则不登记，事件与快照一致；函数/Symbol/对象 toJSON/超长 id 用例，去掉类型校验变红 |
| 重要 | `packages/server/src/session/pool.ts:196`、`packages/server/src/session/pool.ts:200`、`packages/server/src/session/pool.ts:227` | 违反 R16 的快照整帧 1 MiB 目标：条数与 UTF-16 字符数虽有界，JSON 转义最多会把一个 code unit 扩为 6 bytes；最终 `limit === 0` 又无条件返回。探针用 200 个 256 字符的活动工具与 100 条 1024 字符的队列（均为需 `\u0000` 转义的字符），得到不含历史消息但仍为 1,232,690 bytes 的快照。循环会终止、内存也已有有限上界，但现有约 1 MiB 的整帧断言不成立。 | 已修：活动工具上限 100、queue 条目 512 字符，转义最坏情况用例断言 <= 1 MiB |
| 重要 | `packages/server/src/session/events.ts:139`、`packages/server/src/session/events.ts:147` | `sanitizeData` 在判断上限前会完整遍历并生成 JSON 字符串，随后还要扫描 UTF-8 字节；1 MiB 兜底不限制处理过程的 CPU/峰值内存。Node 24 探针中，100 万/500 万个小整数分别同步阻塞约 95/455 ms，后者 RSS 短时增加约 151 MiB，零延迟定时器同量延后；成本近似线性，千万级输入约为秒级，继续放大可先造成长时间事件循环阻塞或 OOM，再得到 71-byte 兜底。未经前置宽度限制的工具参数/结果可触发。 | 接受：序列化成本不在本期防御，已写入 spec R16；留给 hook 与脱敏能力 |
| 建议 | `packages/server/src/session/pool.ts:121`、`packages/server/src/session/pool.ts:122`、`packages/server/src/session/pool.ts:141` | `emit` 先 `apply`、后递增 seq；若 `apply` 在部分写状态后抛错，SDK 外层 catch 只能阻止外抛，不能回滚状态。直接探针令 `message.ended.text` 的序列化结果在 `String` 转换时报错，确认 partial 已清空而 seq 与广播均未前进。当前 `mapEvent` 会把 `message.ended.text` 归一为字符串，尚未找到这个具体分支由正常 SDK 事件触发的路径；但它说明类型缺口扩大时会留下同 seq 的不同状态，宜让 apply 对已验证形状操作或原子提交。 | 已修：apply 现在只在字段类型校验通过后才写状态，不再有部分写入后抛错的路径 |
| 重要 | `packages/server/src/session/events.test.ts:107`、`packages/server/src/session/events.test.ts:142`、`packages/server/src/session/events.test.ts:177`、`packages/server/src/session/pool.test.ts:401`、`packages/server/src/session/pool.test.ts:418` | 测试没有真正封住上述需求：容量用例未覆盖“判断后追加标记”的精确边界；快照只用无需转义的 ASCII；函数只在 `sanitizeData` 用例中出现且未经过状态累积，Symbol 未覆盖；`toJSON` 一致性只测返回字符串，未测返回对象；长 ID 用例只断言快照数量/字节，不比较事件与状态。因此 `events.test.ts` 14 项全过，仍可由探针复现前述问题。 | 已修：补边界、转义最坏、函数/Symbol/对象 toJSON 与长 ID 的用例 |

第 6 轮复核：getter、Proxy、抛错 `toJSON`、循环引用均不会从 SDK 监听器外抛，后续事件仍可继续；BigInt 已转字符串并受截断，嵌套 `toJSON` 返回的长字符串也会经过 replacer 截断。`activeTools`/`queue` 的条数与字符数已有有限上界，快照收紧循环会终止；剩余的字节上限和事件/状态一致性缺口见上表。

验证：`pnpm --filter yuanshu-harness-server typecheck` 通过；`events.test.ts` 14 项通过。`pool.test.ts -t R16` 与 `sessions.test.ts -t 'R14|R16'` 均因沙箱禁止监听 `127.0.0.1`（`listen EPERM`）在收集阶段失败，0 项执行；边界结论由 `/tmp/session-pool-r7-probe.mjs` 在 Node 24.13.1 下复现。

本轮阻塞级：2 条。
