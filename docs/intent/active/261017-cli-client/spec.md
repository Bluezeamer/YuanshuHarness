# Spec: 最小命令行客户端
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> 写成 delta：协议、端点、认证都已在 [ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)，此处只写客户端新增的行为。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0019](../../../genesis/adr/0019-release-artifacts.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)
下游: plan.md、PR 定稿后回填

## Requirements

**命令与配置**
R1. `yuanshu sessions`、`yuanshu new`、`yuanshu attach <id>` 可用；`serve` 的参数、输出、退出码不变。未知子命令与缺参数退出码 2 并打印用法。
R2. 服务地址取 `--url`，其次 `YUANSHU_URL`，默认 `http://127.0.0.1:7420`；格式非法退出码 2。令牌只取环境变量 `YUANSHU_TOKEN`，客户端不接受 `--token`。令牌不得出现在 stdout、stderr 与任何错误信息里，包括服务端回显和连接错误。
R3. 服务端返回 401、403、429、501、404 时，客户端打印一行可读原因（不含令牌）并以退出码 1 结束，不重试；429 的原因带 `Retry-After` 秒数。

**列出与创建**
R4. `sessions` 每行打印一个会话：`id`、`running` 或 `idle`、名称（无则空）；无会话时打印一行提示。`new` 成功时只向 stdout 打印会话 `id` 一行，便于脚本捕获。

**接入与显示**
R5. `attach` 通过 `Sec-WebSocket-Protocol: yuanshu.v1, bearer.<令牌>` 接入（未设令牌则只带 `yuanshu.v1`）。第一帧必须是 `snapshot`，否则报错退出 1。收到快照后先打印其中的最近消息，若有 `partial` 则接着打印并保持"正在生成"状态，然后接上实时帧。
R6. 实时显示：`message.delta` 的文本类增量直接追加到 stdout，不换行；`message.ended` 收尾换行；`tool.started`/`tool.ended` 各打印一行（含工具名，`isError` 时标明失败）；`run.failed` 打印到 stderr；`queue.updated` 在队列变化时打印一行排队条数。思考增量（`kind: "thinking"`）不显示。未识别的事件类型忽略，不报错（信封要能容纳新类型，[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)）。

**序号与恢复**
R7. 客户端校验每一帧的 `seq`：快照之后必须恰好为上一帧加 1。出现缺口或回退时，丢弃该帧，发一次 `resync`，在新快照到达前不处理实时帧，新快照到达后从其 `seq` + 1 续上。等待新快照期间不得重复发出多个 `resync`。
R8. 连接被服务端关闭（含 1009、1013、1001）或出错时，客户端打印关闭码与原因，以退出码 1 结束，不自动重连。用户主动退出的退出码为 0。

**输入**
R9. 输入按行处理：`/stop` 发 `stop`，`/quit` 退出（码 0），空白行忽略，其余发 `send_message`（`text` 为该行）。每个命令都带唯一 `id`，收到失败的 `ack` 时打印其 `error.message` 到 stderr，连接保持。
R10. 标准输入结束时，等到最近一次 `snapshot` 或事件显示 `running` 为 false 且队列为空后以 0 退出；等待期间连接被关闭仍按 R8 处理。Ctrl-C 立即退出（码 0），不发 `stop`，会话继续运行。

## Proof
| 需求 | 证明 | 变异验证 |
|---|---|---|
| R1 | `cli.test.ts`：三个子命令分派、未知子命令与缺参数得 2；既有 `serve` 用例不改全绿 | 变异：分派吞掉 `serve`，既有用例必须变红 |
| R2 | 单测：地址优先级与非法格式；对着开启认证的 stub Server，令牌经环境变量通过、`--token` 被当未知参数；断言 stdout/stderr 全文不含令牌（含 401 与连接失败两条路径） | 变异：错误信息回显令牌，必须变红 |
| R3 | 集成：401、403（网段外）、429、501（无工厂）、404 各一条，断言消息与退出码，429 含秒数 | 是 |
| R4、R5、R6 | 集成：对 stub Server `new` → `sessions` → `attach`，发一条消息，断言 stdout 的文本、工具行、排队行；中途接入断言先出 `partial` 再续上实时流且文本不重不漏 | 变异：先接实时流再打印快照，文本必须错位 |
| R7 | 集成：用中间代理（测试内的 WebSocket 转发）丢掉一帧、重复一帧、乱序一帧，各断言恰好一个 `resync`、最终显示文本连续 | 变异：去掉缺口检测 / 缺口后继续处理旧帧，必须变红 |
| R8 | 集成：服务端关连接（1013、1001）与 Server `stop()`，断言码、原因与退出码 1；无自动重连（服务端连接数不回升） | 是 |
| R9 | 集成：消息被执行；`/stop` 中止运行；空白行不发；`ack` 失败（超长内容之类）打印后连接仍可用 | 是 |
| R10 | 集成：管道输入一条消息后 EOF，等运行结束才退出 0；运行中关闭连接得 1；Ctrl-C 路径用注入的 `AbortSignal` | 变异：EOF 立即退出，必须变红 |
| 全部 | 并入 `scripts/check.sh`；测试只对着 stub provider；包冒烟 `smoke-package.sh` 增加 `yuanshu sessions` 对着一个启动的包做一次 | 不适用 |

## Design
- **模块**：`src/client/`（新）：`http.ts`（`fetch` 封装与错误归一）、`stream.ts`（WebSocket、序号校验、`resync`、命令与 `ack` 配对）、`render.ts`（帧到文本，纯函数）、`attach.ts`（把输入行、流、渲染接起来）。`cli.ts` 只做分派，`serve` 分支不动。
- **依赖**：Node 内置 `fetch`、`WebSocket`、`readline`，不新增依赖。帧与快照的类型从服务端模块导入，客户端与服务端在同一个包内，不复制类型。
- **可测性**：`Deps` 增加可注入的 `stdin`，并复用已有 `signal`；测试里的 Server 用 `createServer` 加 `sessionFactory` 起在临时端口，不依赖真实模型。
- **缺口策略**：客户端只在收到 `snapshot` 时重置期望序号；发出 `resync` 后置"等待快照"标志，期间到达的实时帧一律丢弃。
- **迁移与兼容**：无存量数据，无协议变化；`yuanshu` 之前只有 `serve`，新增子命令是追加。

## Risks
- 对着真实 `serve` 无法创建会话（第 7 条前没有工厂），所以真实环境下的"创建、对话"只靠 stub Server 的测试证明；第 7 条落地后需要补一次真实模型下的手动验证。
- Node 全局 `WebSocket` 是否暴露子协议握手结果与关闭码，依赖运行时行为；plan 步骤 1 探测，若不满足再评估是否改用 `ws`（会新增依赖，须回头改本 spec 与 intent）。
- 不自动重连：网络抖动会让接入中断，需用户手动再接入；已知取舍，留给后续。
- 令牌来自环境变量，可能被同机其他进程从 `/proc/<pid>/environ` 读到（同用户），与服务端的受信本机前提一致。
