# 目标（goal）：自主续跑

Author: bluezeamer
Status: 现行
Date: 2026-11-17
Verified: 2026-11-19（对着代码核对：`session/{goal,goal-driver,goal-messages,goal-tools,tool-catalog,delivery}.ts` 与 `pool.ts` 的目标卡片接线、`store/session-state.ts`、`store/defaults.ts`、`api/defaults.ts`，以及 web 端 `chat/status/Blocks.tsx`、`chat/tab/goalNotice.ts`、`chat/model/commands.ts`、`settings/defaults/SessionTab.tsx`）

目标让 agent 能自己把长任务做下去：除非它主动声明「完成」或「受阻」，每轮交付后 harness 再把目标注入一次，继续驱动。目标不兼作 `/loop`：Claude Code 的 `/loop` 是定时重复，不是续跑。

## 1. 定位与取舍

- **采用 DeepSeek harness（dsh）的续跑方式**：由 harness 在 agent 完全空闲时注入下一轮，完成与受阻由模型自报（`update_goal`）；强度介于 Claude Code 的 `/goal`（每轮由小模型判定，更容易停）与 `/loop`（强制定时唤醒）之间。小模型常见的问题是「并没有交付却不再继续」，续跑由 harness 做，不靠模型自觉；不用独立小模型判定完成（只看对话的判定不是可信的完成证书，评估者的权限与隔离要单独设计）；Server 重启后不自动续跑，等人显式继续。
- **不做 `/loop`**（定时重复，见 §7）。
- **验收标准不单独成字段**：写在目标文本里。
- **模型可以自己发起目标，并修改自己发起的目标**：让 agent 自主做长任务。

## 2. 数据与状态

目标存在会话状态里（`store/session-state.ts`，变化经 `goal.updated` 事件广播），不进 pi 的会话文件。字段：

| 字段 | 含义 |
|---|---|
| `id`、`revision` | 每次新建换 id；每次变更（文本、状态、上限、原因、**续跑记一轮**）revision + 1（模型的工具调用带上，对不上就拒，防过期操作；卡片也靠 `goalId + event + revision` 去重） |
| `text` | 目标文本，≤ 4000 字符 |
| `attachments` | 可选。用户设 / 改目标时附的文件（引用：`name / mime / sizeText / path`，文件在会话附件区）；没有就缺省。**只有用户能改**（模型的 `update_goal` 不能），改了即整体替换，空数组 = 清空 |
| `by` | `user` / `model`；用户一编辑就归 `user` |
| `state` | `active` / `paused` / `blocked` / `complete` |
| `reason` | `paused` 与 `blocked` 时的原因：`{ code, detail? }`，code 取 `user-paused` / `user-stopped` / `request-failed` / `server-restart` / `no-tool-calls` / `round-limit` / `model-blocked`，`detail` 是出错信息或模型写的阻塞说明；界面按 code 配中文 |
| `maxRounds` | 本次启动的轮数上限；`null` = 不限 |
| `rounds` | 本次启动已用轮数；点「继续」时归零 |
| `since`、`updatedAt` | 时间 |

一个会话同一时刻只有一个目标；已有未完成的目标时再创建报错，要改用修改；`complete` 之后才能立新的。**子代理会话不提供目标工具**（它们本来就是做完交付）。

转移：

| 动作 | 谁 | 从 → 到 |
|---|---|---|
| 创建 | 用户（`/goal <文本>`、右栏）、模型（`create_goal`） | 无 / `complete` → `active`，rounds = 0 |
| 修改文本 | 用户（任何目标）；模型（只能改 `by = model` 的） | 状态不变；用户改了 `by` 变 `user` |
| 暂停 / 继续 | **只有用户** | `active` ↔ `paused`；`blocked` → `active`（rounds 归零） |
| 完成 / 受阻 | 模型（`update_goal`），受阻还可由 harness 判定（§4） | `active` → `complete` / `blocked` |
| 清除 | 用户 | 任意 → 无 |

## 3. 续跑

**注入条件**（全部满足才注入，每个 agent 同一时刻最多一条待注入）：目标 `active`；agent 完全空闲；**没有在跑的后台任务和子代理**（它们结束的回调本身会触发下一轮，此时再注入只会让 agent 反复说「还在等」；dsh 只等子代理，我们不照抄）；没有排队的用户消息。**用户消息优先**：用户一发话就不排下一轮；**用户点停止 = 暂停目标**，不会被自动拉起来。每轮之间不加间隔，空闲就立刻续。

**注入的消息**是一条 `customType: "yuanshu.goal"` 的自定义消息（同 `yuanshu.subagent` 的做法：模型当用户消息看，不进对话投影的下标），`details` 带 `{ goal: GoalNotice }`（`event: "round"`，另有 `goalId`、`revision`、`round`、`maxRounds`）。正文是英文模板（`session/goal-messages.ts` 的 `roundMessage`）：开头 `[Goal round n/max]`（不限轮数时只写 `n`）、目标文本（放在 `<goal>…</goal>` 里，自身出现的闭合标签会转义，防多行文本撕开框架）、继续做、以当前工作区与工具结果为准而不是之前的叙述、**宣布完成前逐条取证**（把目标拆成要求，每条找证据；证据弱或间接就当没完成）、受阻的门槛、「完成或受阻必须调 `update_goal`」。目标文本只在注入消息里出现，不再追加进系统提示。**目标带附件时**，每轮的 `<goal>` 块里目标文本后面跟 `[attach_file]` 标记行（与用户消息同一格式）；图片字节**只在新建目标、或改了附件之后的第一轮**随消息带上（内存里记一份「待带图」，取走即清空，重启后丢，标记行还在、模型可以用 `read` 看），之后每轮只带标记行，免得每轮重复吃图片的 token。`get_goal` 的结果里多几行 `attachment: <名> (<路径>)`。

**一轮** = 从注入到 agent 再次空闲；用户亲手发起的那一轮（或模型创建目标的那一轮）算第 0 轮，不计数。

## 4. 模型工具与终止

模型工具：`get_goal`；`create_goal(objective)`；`update_goal(goal_id, revision, action, objective?, blocked_reason?)`，`action ∈ edit | complete | blocked`。`edit` 只对 `by = model` 的目标有效；`complete` / `blocked` 只能在目标轮次里（或创建它的那一轮）调用。模型**不能暂停、恢复、改轮数上限**。

| 终止 | 触发 | 结果 |
|---|---|---|
| 完成 | 模型 `complete` | `complete`；harness 追加一条收尾指令：写一段总结（做了什么、怎么验证的、你需要做什么），只许写会话里有证据的事，不许再调工具 |
| 受阻 | 模型 `blocked`：要求本次启动已满 3 轮且写明具体阻塞（「同一阻塞连续 3 轮」是模型判断，harness 只数轮数）；或 harness 判定：**连续 3 轮没有任何工具调用** | `blocked`，同样追加收尾指令 |
| 轮数用完 | `rounds ≥ maxRounds`（**默认 50，可设为不限**） | 先给一轮收尾（总结进展与剩余），目标变 `blocked`（`round-limit`）；点「继续」重新计数，不会无法恢复 |
| 请求出错 | pi 按重试设置重试后仍失败 | 目标 `paused`（`request-failed`），写明原因，等用户继续；**不自动重试**（否则压缩出错之类会无限续跑烧 token） |
| Server 重启 | 重启时目标 `active` | 保留，变 `paused`（`server-restart`），要用户点继续（打开会话是观察，不是授权花钱） |
| 用户停止 | 停止键 | `paused`（`user-stopped`） |

上限设置在「设置 · 默认值 · 会话与任务」（「限制续跑轮数」开关 + 数字，开关关闭 = 不限制）；每个目标上用户也能改（留空 = 不限）；模型发起的目标用默认值，**不能自己调高**。预算只用轮数；界面只显示已用轮数，不统计 token（各家口径不一）。

## 5. 界面

- **右栏「目标」块**：目标全文（高度有上限，超出可滚动；双击正文进入编辑），下面一行小字：「模型设定 / 你设定」、起始时间、状态、轮数（`12 / 50`，不限时只写 `12`），暂停 / 受阻时带原因详情；操作：暂停 / 继续、编辑（多一个「轮数上限」输入，留空 = 不限）、删除（两步确认，对应 §2 的「清除」）。**完成后块里不再显示**（结果看对话流里的卡片，同后台任务）；暂停与受阻一直显示，因为等用户处理。窄窗格收成竖排标签，进行中带脉动点（现有）。
- **对话流**：每次自动续轮一行很淡的「目标 · 第 n 轮」（不是用户气泡）；事件卡片沿用盾牌回执样式——模型设了目标、完成、受阻（写明原因）、暂停（因为你停止 / 请求出错 / 服务重启）、轮数用完；收尾总结是普通助手消息，跟在卡片后。卡片的锚定与后台任务的回调卡片共用一套机制（`afterIndex`，通用的 `notice` 带 `kind`，见 [`subagent.md`](subagent.md) §9）。
- **目标可以附文件**：`/goal` 与 `/goal edit` 用掉输入卡里已就绪的附件（只带路径，与普通消息同一条上传链路）；右栏编辑目标时是 `RichInput`（附件条预载原附件，可增删，保存时附件与文字一起整体替换），正文下方列出附件；设 / 改目标的卡片注明附件名（`GoalNotice.files`）。
- **输入框命令**：`/goal <文本>` 设定；`/goal pause | resume | clear`；`/goal edit <文本>`。`clear` / `pause` / `resume` 只有独占整行才当控制词，其余一律当新目标文本。右栏有按钮，命令是备用。
- **设置页**：见 §4 末；设置 · 默认值 · 会话与任务里，「限制续跑轮数」开关关闭 = 不限制，打开后填「轮数上限」。

## 6. 实现在哪

- **服务端**（`packages/server/src/session/`）：`goal.ts`（纯转移函数与 `GoalNotice`，不读时钟）、`goal-driver.ts`（`GoalDriver`：用户侧操作、模型侧三个工具的实现、续跑判定、`runStarted / toolStarted / runEnded / userStopped / restore` 钩子；每个 `SessionEntry` 一个，池里只有接线）、`goal-tools.ts`（`get_goal / create_goal / update_goal`，框架工具，子代理会话不挂）、`goal-messages.ts`（模型看的英文）；持久化沿用 `session_state` 表里目标的 JSON（`store/session-state.ts` 的 `Goal`）。卡片落成会话文件里的条目：注入消息是 `custom_message`（`yuanshu.goal`，进模型上下文），其余是只出卡片的 `custom` 条目（不进模型上下文）；实时走 `notice` 事件，历史由 `store/history.ts` 的 `projectNotices` 给。
- **前端**（`packages/web/src/features/chat/`）：`model/goal.ts`（状态与原因文案）、`tab/GoalNotice.tsx` + `tab/goalNotice.ts`（卡片）、`tab/notices.ts`（任务卡与目标卡合并落点）、`status/Blocks.tsx` 的 `GoalBody`、`model/commands.ts` 的 `/goal`；设置页在「会话与任务」。
- **验收**：`scripts/verify-goal.mjs`（假模型驱动真 Server）。
- **实现要点**：「空闲」取 `SessionEntry.busy`（含 send 已接受但 SDK 还没开始的窗口）；每次运行结束与每次 send / notify 收尾都检查一次续跑（后者管 `run.ended` 到来时发送调用还没返回的窗口）；「本轮有没有工具调用」数的是 `onToolStart`，`get_goal` 之类也算一次；「请求出错」取运行结束时最后一条助手消息是错误（pi 重试用尽后）；用户 `/goal <文本>` 没有自己的一轮，设定后立刻注入第 1 轮，模型 `create_goal` 的那一轮才是第 0 轮。

## 7. 未实现与未决

- **不做**：独立小模型判定（以后可接辅助模型做可选核验，留口子不实现）、token 上限。
- **cron 模块**（设想，未做）：定时任务交给以后专门的 cron 模块，分两种：纯 cron job（到点只跑命令）、唤起模型的 cron job（到点给会话注入一条 prompt）。`/loop` 这个名字留给它。
- **验收标准的扩展**（设想）：现在验收标准写在目标文本里；不够时再加「可选验收文本 + 宣布完成时附证据」。命令型验收（退出码为 0 才算过）留到 cron 模块一起考虑。
