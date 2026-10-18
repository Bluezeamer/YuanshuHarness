# Spec: WebUI（二）对话与停止
Author: bluezeamer
Status: draft
Date: 2026-10-17

> 写成 delta：只写本次变更相对 [skeleton](../261017-webui-skeleton/spec.md) 新增或改变了什么。
> 帧类型与载荷以 `packages/server/src/session/pool.ts` 的真实输出为准（ADR-0021 只定契约）。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0020](../../../genesis/adr/0020-transport-websocket.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)
下游: 定稿后回填

## Requirements
R1. 选中会话后，主区建立该会话的事件流连接（子协议 `yuanshu.v1` 与 `bearer.<token>`），首帧必须是快照；首帧不是快照视为协议错误，显示错误并关闭连接，不自动重连。切换会话或离开时关闭旧连接，旧连接的帧不得再改变界面。
R2. 对话区显示：历史 + 快照窗口 + 实时帧。
  - 快照带窗口第一条消息的序位 `startIndex`（与 REST 的 `index` 同一套，由服务端累计，见 ADR-0021）。每份快照到达后（首次、`resync`、重连），取最新一页（`limit=200`），窗口之前的历史就是页里 `index < startIndex` 的部分，窗口内的消息一律用快照文本，不比对内容。页没覆盖到 `startIndex - 1`（服务端落后或快照已过时）则重取，最多 3 次，仍失败则只显示快照窗口并提示"历史加载失败"（不得继续显示旧历史块）。快照没有 `startIndex` 时不猜起点，直接提示失败。
  - 已加载的历史必须累积合并（按 `index`），重新对齐不得丢弃或替换它。新页与已加载块首尾衔接或重叠时合并；中间出现缺口（断开期间新增超过一页）时才改用新页，更早的部分由 R13 补回。缺口时选替换而不是保留旧块，因为保留会在中间留下看不见的洞、顺序是错的（已由人确认）。
  - 不得出现重复或缺失的消息。无任何内容且连接正常时显示"还没有消息"。
R3. 实时帧按序号校验：序号不连续则发 `resync` 并丢弃其后的实时帧，直到新快照到达后以快照为准重置窗口。
R4. 流式显示：`message.delta`（`kind` 为 `text`）追加到进行中的助手消息并显示打字光标；`kind` 为其他值的忽略。`message.ended` 用其 `text` 校正最终文本并移除光标；用户消息只在 `message.ended` 渲染一次。
R5. 工具活动：`tool.started`（`toolCallId`、`toolName`）显示工具名与运行态，`tool.ended`（`toolCallId`、`isError`）按 `isError` 显示成功或失败；快照里的 `activeTools` 恢复进行中的工具。`run.failed` 显示其 `message`。
R6. 运行态来自快照的 `running` 与 `run.started` / `run.ended`。运行中显示"停止"，否则显示"发送"。队列（`string[]`，来自快照与 `queue.updated`）非空时显示"排队 N"并列出各项文本。
R7. 发送：输入去除首尾空白后为空则不发送；否则发出 `send_message` 并清空输入框。运行中也允许发送（服务端排队）。`Enter` 发送，`Shift+Enter` 换行，输入法组合中的 `Enter` 不发送。命令没有发出去（连接未就绪）时不得清空输入框。
R8. 输入不得因发送未被确认而丢失：`ack` 为 `ok: false` 时显示其 `error.message`；回执失败，或连接断开时仍未收到回执的发送，原文必须放回输入框（仅当输入框当前为空，避免覆盖新输入）。
R9. 停止：点击"停止"发出 `stop`，按钮在回执前禁用；回执 `ok: false` 显示错误。运行结束（`run.ended`）或连接断开后恢复可点击状态，不得一直禁用。
R10. 连接异常关闭时自动重连：显示"正在重连…"，等 3 秒后重试，连续失败 5 次后显示"连接已断开"与"重新连接"按钮；收到快照后计数清零。
  - 每次重试必须先发一个带令牌的 REST 请求探测：401 清除令牌并回到令牌页；429 显示"尝试过多"与等待秒数并停止重试；403 显示"当前来源不被允许"并停止重试；探测成功才建立 WebSocket。不得在令牌失效时反复握手（会计入 ADR-0026 的限流）。
  - 重连期间保留已显示的内容，新快照到达后按 R2 取历史。点击"重新连接"立即建立连接。连接未就绪或已关闭时，发送与停止不可用。
R11. 滚动：新内容到达时，仅当用户当前在底部才自动滚到底部；用户上滚后不被抢走位置。
R12. 样式遵循 [yuanshu-webui-style](../../../../.agents/skills/yuanshu-webui-style/SKILL.md)：`styles.css` 之外的源码不写色值，也不用 Tailwind 内置的 `white`/`black`，一律走调色板变量；构建产物里的十六进制色值只允许调色板变量声明和 Tailwind 自带的 `#0000`、`#fff`；`prefers-reduced-motion` 下动画近 0；对话区 `role="log"` 且 `aria-label="对话记录"`，输入框 `aria-label="输入消息"`，停止按钮 `aria-label="停止运行"`，打字光标 `role="img"` 且 `aria-label="正在输入"`。
R13. 加载更早：最新一页的 `nextBefore` 非空时，对话区顶部显示"加载更早"按钮；点击后用游标取下一页（`before=<游标>&limit=200`）并拼在已有历史之前，视口保持在点击前的消息位置。取数期间游标已变的结果丢弃；失败时提示并保留按钮可重试。加载期间到达的新消息不得让视口多移：位移只算历史块增加的高度。
R14. 输入框草稿按会话保留：切换到别的会话再切回，先前输入的内容原样还在；各会话的草稿互不出现在对方的输入框。切换时仍未收到回执的发送，原文放回它原来所在会话的草稿（同 R8，仅当该草稿为空），不得进入新选中的会话。

## Proof
假 WebSocket 与 `fetch` 桩的 fixture 取自 `pool.ts` 的真实帧形状；组件测试经 `Shell` 选中会话后断言界面。

| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | `stream.test.ts`（首帧、令牌不进 URL）；`conversation.test.tsx`：切换会话后旧连接的帧被忽略 | 变异：去掉关闭旧连接，必须变红 |
| R2 | `history.test.ts`：按 `startIndex` 截页、内容重复不影响、页接不上时重取与 3 次降级、累积合并（衔接 / 重叠 / 缺口）；`conversation.test.tsx`：`resync` 后新快照与已加载历史并存、无缺口无重复；空态；响应不是合法 JSON、快照没有 `startIndex` 都提示失败；服务端：`persist.test.ts` / `pool.test.ts` 断言 `startIndex` 与恢复、追加后一致 | 是（`resync` 后中间消息缺失）；变异：改成用新页替换已加载块，必须变红 |
| R3 | `stream.test.ts`；`conversation.test.tsx`：跳号后实时帧被丢弃，新快照后恢复 | 变异：不丢弃，必须变红 |
| R4 | `conversation.test.ts`（reducer） | 是 |
| R5 | `conversation.test.ts`；`conversation.test.tsx`：工具名与失败态显示；已有命令失败提示时 `run.failed` 仍然显示 | 是 |
| R6 | `conversation.test.ts`；`conversation.test.tsx`：按钮随 `running` 切换，"排队 N" | 是 |
| R7 | `conversation.test.tsx`：空白不发送、Enter / Shift+Enter、组合输入、运行中可发送、连接未就绪不清空 | 变异：去掉组合输入判断，必须变红 |
| R8 | `conversation.test.tsx`：回执失败还原输入；输入非空不覆盖；断线时未确认的发送还原 | 是（旧实现的失败回调是空函数） |
| R9 | `conversation.test.tsx`：回执前禁用、失败显示错误、断线后恢复 | 是 |
| R10 | `conversation.test.tsx`（假计时器）：3 秒后重试、5 次后停并出现按钮、快照后清零；探测 401 回令牌页且不再握手、429 / 403 停止、网络失败继续；手动重连；协议错误不重连 | 是（旧实现无自动重连）；变异：去掉探测直接握手，401 用例必须变红 |
| R11 | `conversation.test.tsx`：可控的 scroll 度量，底部时跟随、上滚后不跟随；排队文本出现后也跟随 | 是 |
| R12 | `tokens.test.ts` 静态检查（含不得用 `text-white` 等）；构建后对 `dist` 的 grep，除调色板与 `#0000`/`#fff` 外不得有其他色值（记入 review.md）；可访问名称在组件测试中断言 | 变异：写入 `#fff`，必须变红；停止按钮改回 `text-white`，必须变红（已实测） |
| R13 | `history.test.ts`：游标衔接、过期游标丢弃；`conversation.test.tsx`：按钮出现、点击拼接、失败可重试、响应不是合法 JSON 提示失败并解除加载中、视口锚定、加载期间新消息到达时位移不偏 | 是（按钮不存在；位移多算了新消息的高度） |
| R14 | `conversation.test.tsx`：切走再切回草稿还在、草稿不串会话、切换时未确认的发送回到原会话 | 是（旧实现草稿随视图卸载而丢）；变异：切换时不结算未确认的发送，必须变红 |

真实运行证明（静默出错信号要求）：起真实 Server 与一个会话，用脚本经真实 WebSocket 复核帧序列与本 spec 的假设一致（`message.started` 载荷、`tool.ended.isError`、`run.failed.message`、子协议鉴权），结果记入 review.md。

## Design
- `src/history.ts`：纯函数。`loadOlder` 用快照的 `startIndex` 从最新一页截出窗口之前的历史，`afterTail` / `afterEarlier` 做累积合并，不碰网络，便于测试竞态。
- `src/stream.ts`：封装 WebSocket。序号校验、`resync`、命令 id、回执回调。浏览器 WebSocket 无法设请求头，鉴权走子协议（ADR-0026）。
- `src/useConversation.ts`：hook，持有消息、历史、工具、队列、运行态、连接态；返回 `send` / `stop` / `reconnect` / `loadEarlier`。重连的计时与探测在 hook 内，与布局无关。
- `src/Conversation.tsx`：展示组件，滚动位置留在组件内，草稿由外部传入。`Shell.tsx` 按会话 id 保存草稿（会话视图随选中切换而重建，草稿不能放在视图里），选中会话后渲染它；`Gate.tsx` 向 `Shell` 传回令牌失效的回调。
- `src/api.ts`：`listMessages` 增加游标并返回 `{ messages, nextBefore }`。

## Risks
- `startIndex` 由服务端在内存里累计，依赖"序位只增不变"（ADR-0024），并假定每条实时 `message.ended` 对应 JSONL 里的一条 user/assistant 消息。会话被压缩或改写历史时，累计值与文件序位会错开，历史与窗口的交界处可能多或少几条，前端不再比对内容，所以不会自动发现；服务端重新加载该会话（重启后重新播种）才恢复。这是换掉文本比对的代价，已知并接受。
- 断线时未确认的发送可能其实已送达，放回输入框后用户再发会重复。选择可见的重复，而不是不可见的丢失。
- `Shell` 顶栏的"Server 在线"是写死的绿点，窗格化后各有各的连接，它不属于本 spec；留给 pane-layout 前先定。
