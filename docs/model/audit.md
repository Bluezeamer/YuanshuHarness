# 审计

Author: bluezeamer
Status: 现行
Date: 2026-11-08
Verified: 2026-11-19（对着代码核对：`packages/server/src/` 下 `store/{audit,calls,baseline}.ts`、`api/{calls,audit}.ts`、`session/{call-capture,call-tokens}.ts`，与 `packages/web/src/` 下 `api/{calls,audit}.ts`、`features/chat/audit/`、`features/chat/tab/AuditToggle.tsx`；只读代码、未运行；未核实的项见 §5）

审计有**两套**，别混：**模型调用记录**（每次发给模型的请求，审计页看的就是它）与**执行审计**（谁在哪台主机上做了什么）。术语「目录」「工作区」见 [`workspace.md`](workspace.md)。

## 1. 原则

- **A1 审计是一等公民**：工具调用、审批、引用都要能回溯。
- **A2 记录单位是「一次模型请求」**：user 消息、assistant 消息、tool_use、tool_result 都在请求与响应里体现，不另开条目。凡是真正发给模型的请求都记，**子代理的请求也记**，记在子会话名下。
- **A3 不是一轮对话的请求不另开条目**：`/goal`、`/compact` 不走 `send_message`（`chat/model/commands.ts`），本身不产生一轮调用；「清空」等于新开会话，也不记。压缩只作为分段边界出现（§2）。`/compact` 生成摘要的那次模型请求是否进调用记录，见 §5。
- **A4 审批与执行是分开的独立事件**，带超时与审计，提问全端广播、先答先赢（`session/prompts.ts`）。

## 2. 模型调用记录

**存储形状**（`store/baseline.ts` 的 `calls` 与 `latest_request` 两张表）：不逐次存完整请求，`calls` 只存元数据加对话项数 `msg_count` 加压缩过的响应（`response_z`）；**每个会话只另存最新一次请求**（`latest_request`），供审计详情回放「当前段」。

| 接口 | 作用 |
|---|---|
| `GET /api/v1/sessions/:id/calls` | 调用摘要分页（`CallSummary`） |
| `GET /api/v1/sessions/:id/calls/:callId` | 单条详情：请求（`segment > 0` 时是压缩前快照）、响应、`range` |
| `GET /api/v1/sessions/:id/subagent-calls` | 该会话派发出的整棵子树的调用；单条详情仍按子会话 id 取 |
| `GET /api/v1/sessions/:id/compactions` | 压缩历史列表，`seq` 为 1..N，附这一段的调用序号范围 |
| `GET /api/v1/sessions/:id/usage` | 用量聚合 |

- **摘要字段**（`web/src/api/calls.ts` 的 `CallSummary`）：`seq`、`turn`、`trigger`（`user` / `tool_result` / `subagent`）、`toolName`、`durationMs`、一行摘要 `summary`、响应里发起的工具名 `calledTools`、`stopReason`、`model`、`window`、`tokens`、`msgCount`、`segment`。`segment` 为 0 是当前未压缩段，1..N 是第几段压缩历史。
- **token 拆成四段**：系统、工具、历史、本轮，另有出、缓存读、缓存写。**四段是按请求体字符数分摊的估算**，`estimated` 标记表示总量本身也是估算；估算公式在 `session/call-tokens.ts`（÷3）。
- 请求体是各供应商的原始 payload，形状随供应商变；响应是归一化后的助手消息。接管提示词（[`prompt-delivery.md`](prompt-delivery.md)）下，请求里的系统部分是冻结物渲染的开头系统消息，审计页读取方式不变。

## 3. 审计页

对话标签（`chat`）的第二个视图，**只读**，挂在 `chat/tab/ChatView.tsx`，代码在 `features/chat/audit/`（`AuditPane`、`Rail`、`Detail`、`StructView`、`model.ts`、`payload.ts`）。入口是标签条右端的「审计 N」（进去后换成「← 对话」），页脚两个视图共用。筛选、搜索、视图、宽度、折叠都存在**标签自己的 `afx`**，随布局落盘，不另存全局状态。版式用标准件：`ListRow`、`Select`、`SearchBox`、`HoverCard`、`Segmented`、`Chip`。

- **左栏**（默认宽 248，分隔条可拖，容器窄于 620 时叠在详情上方）：汇总行 `N 次调用 · 入 X · 出 Y`（筛选或搜索后加「· 筛后」、没载完加「· 已载入」，估算值前加 `~`，右端是刷新图标）→ 类型下拉 + 搜索框 → 按轮次分组的调用行 → 压缩历史。行是「序号 · 摘要 · 触发 · 入 token · 耗时」，悬停出详情卡（时间、触发、发起的工具、模型、输入输出、耗时、结束原因）。子代理的调用按子会话分组，组头写子会话名。
- **类型下拉**五档（`model.ts` 的 `FILTERS`，数字写在选项里）：全部、用户、工具返回、工具调用（响应里发起了工具）、子代理。「工具调用」按响应判断、与触发类型无关，所以各档计数之和可以大于总数。
- **搜索**只匹配摘要、工具名与 `calledTools`，**不搜正文**：列表阶段只有点开过的调用才有正文，按正文匹配会让结果取决于看过哪些。
- **压缩历史**：列表下面默认折叠的一区，每段一行（时间 · 条数 · 压缩前 token，悬停看摘要）；展开某段才去补这一段的调用，点其中一条可绕开筛选，右栏显示压缩前快照。
- **右栏头**：`调用 NN` + 触发标签（子代理、压缩快照另有标签）+ 「结构 / JSON」切换 + 复制；下面一行事实（时间 · 模型 · 入 · 出 · 延迟 · stop_reason · 缓存，估算有「估算」标签）；再下面是四色有缝的组成条（系统 / 工具定义 / 历史 / 本轮，宽度 = 该段 token ÷ 总入 token，悬停出四段数值与分摊说明）。
- **右栏正文（结构视图）**：「这次请求的完整内容」，带「全部展开 / 全部收起」。五张可折叠卡片：**系统提示词**、**工具定义**、**历史**（范围之前的消息，按用户消息切成「第 N 轮」，每块一行摘要，点开全文）、**本轮新增**（服务端给的 `range` 里的消息块）、**响应**；范围之后还有消息时多一张折叠的**之后的消息**；请求认不出范围时只有一张**消息**。系统 / 工具 / 历史默认折叠，本轮新增与响应默认展开，折叠态存 `afx.fold`。JSON 视图显示完整的 `{request, response}`，本事件范围那一段是浅蓝底（`jsonRangeSpans`）；切到某次调用时 JSON 视图自动滚到范围起点。
- **交互**：分隔条拖拽宽度，下限 216、上限容器宽度减 320，值存 `afx.w`；左右方向键步长 16，按 Shift 为 48；双击复位。复制 `{request, response}` 的缩进 JSON，剪贴板接口不可用时降级为 `execCommand`，失败提示「复制失败」。

## 4. 执行审计

另一张表 `audit_log`（`store/audit.ts`）：谁（`user` / `agent` / `system`）、在哪台环境、做了什么。`kind` 有 `tool`、`permission`、`terminal`、`file`、`transfer`、`env`、`hook`、`ui`、`secret`；`summary` 是一行，`detail` 只放短的结构化事实，**不放文件内容、命令输出、密码值**。接口 `GET /api/v1/audit`（可按 `kind` 筛）、`POST /api/v1/audit/events`。前端只封装了上报（`web/src/api/audit.ts` 的 `reportAudit`，目前没有调用方），没有读执行审计的页面，也没有读取的封装（要做页面时再写）。

## 5. 未实现与未决

- 执行审计没有界面；要不要做、放在哪，未定。
- 子代理、团队、工作流的运行视图如何与审计页联动：未定；审计页目前只提供「子代理」档（读整棵子树，§2、§3）。运行视图的现行设计见 [`subagent.md`](subagent.md) §9。
- 四段组成条的「系统」段是否按冻结物的各段重新分摊：未定。
- `/compact`（含分支摘要）生成摘要的模型请求是否进调用记录：调用记录靠 pi 的 `before_provider_request` 事件采集（`session/call-capture.ts`），读 pi 的压缩实现，摘要请求不经这个事件，因此应当不会被记录；未实测。
