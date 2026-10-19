# ADR-0028: 统一弹窗的线上协议：prompt.* 事件、答复命令、超时与撤销

状态：已定稿
日期：2026-10-18
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」；ROADMAP 第 5 条

## 背景
[ADR-0005](0005-client-protocol.md) 定了语义（发给所有接入的客户端、先答先赢、无人在线时留待上线补发、超时按拒绝），[ADR-0021](0021-session-wire-protocol.md) 预留了 `prompt.*` 命名空间并规定客户端必须忽略未知类型。
弹窗的触发方有两个：权限审批（[ADR-0006](0006-permission-tiers.md)）与 agent 提问。帧的字段名与命令一旦发布，所有客户端都依赖，所以难逆。

## 候选方案
### 弹窗走哪条通道
- A. 事件流内：`prompt.requested` / `prompt.resolved` 占 `seq`，快照带待处理弹窗。复用重连与缺口恢复，代价：快照形状加字段（只增不改）。
- B. 独立 REST 轮询待处理弹窗。代价：多一条恢复路径、延迟高，两处状态要对齐。

### agent 如何提问
- A. Server 注册一个自有工具 `ask_user`，执行时发弹窗并等待答复。
- B. 用 pi 的扩展 UI 单槽位（`ui.select/input`）。需要在 Server 层分发，ADR-0005 的 S0 假设尚未单独验证，且审批并不经过该槽位。

## 决定
通道选 A，提问选 A。

**事件**（Server 到客户端，占 `seq`）
- `prompt.requested`：`data = { promptId, source: "approval" | "question", kind: "choice" | "input", title, body?, options: [{ id, label }], detail?, expiresAt }`。`kind: "input"` 时 `options` 为空，客户端给出自由文本。`detail` 是供展示的结构化摘要（审批为 `{ tool, summary }`），客户端当作不透明展示数据。
- `prompt.resolved`：`data = { promptId, outcome: "answered" | "timeout" | "cancelled", optionId? }`。输入类答复的文本不出现在事件里。
- 快照新增 `prompts`：当前待处理弹窗的 `prompt.requested.data` 数组。旧客户端忽略该字段。

**命令**（客户端到 Server）
- `answer_prompt`：`{ id, type: "answer_prompt", promptId, optionId? , text? }`，`choice` 用 `optionId`，`input` 用 `text`（1–8000 字符）。
- 先答先赢：第一个有效答复生效并广播 `prompt.resolved`；之后的答复得到失败 ack，`error` 为 `prompt_resolved`（已被他人答复、超时或撤销）或 `prompt_unknown`（从未存在）。选项 id 不在 `options` 内为 `bad_request`。

**生命周期**
- 超时 30 分钟，Server 常量，不可由客户端设置。到期发 `prompt.resolved(outcome: "timeout")`，审批按拒绝、提问回给 agent“用户未回答”。
- `stop` 命令或会话被删除时，所有待处理弹窗撤销（`cancelled`），其触发方按拒绝/未回答收场。
- 无客户端在线时弹窗留在池内，重连的快照补发；弹窗只存内存，Server 重启即消失（重启本来就中断了运行中的工具调用，见 [ADR-0004](0004-state-storage-recovery.md)）。
- 输入类中的保密输入（密码）本期不做，待第 8 条随 [ADR-0007](0007-private-variables.md) 定；届时以新增字段声明，并只允许 WebUI 答复。

## 理由
- 同一事件流让重连、缺口恢复、多端同步只有一套行为，延续 ADR-0021 的“`resync` 复用快照”。
- 审批与提问同一套帧，客户端只实现一个弹窗组件。
- 自有工具不依赖未验证的单槽位分发，也不把 SDK 的 UI 接口变化暴露给客户端。
- 内存态避免把短暂状态写进用户数据，没有迁移负担。

## 影响
- 新增事件类型与命令只增不改；未实现弹窗的客户端会看不到审批，运行中的工具调用会等到超时按拒绝收场，因此命令行客户端同步支持答复。
- 超时时长是 Server 常量；若日后要可配，只增配置不改帧。
- 排除：独立轮询通道；弹窗持久化；指定答复设备。
