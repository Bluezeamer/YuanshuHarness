# Spec: 统一弹窗
Author: bluezeamer
Status: accepted
Date: 2026-10-18

> 决策见 [ADR-0028](../../../genesis/adr/0028-prompt-wire-protocol.md)，帧形状以其为准，此处只写需求。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0028](../../../genesis/adr/0028-prompt-wire-protocol.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)
下游: [plan.md](plan.md)

## Requirements
R1. 池提供 `ask(sessionId, spec)`：发出 `prompt.requested`（占 `seq`），返回在答复/超时/撤销时落定的 Promise，结果含 outcome 与答复内容。
R2. `answer_prompt` 先答先赢：首个有效答复广播 `prompt.resolved(answered)`；之后的答复得失败 ack（`prompt_resolved` 或 `prompt_unknown`）；`optionId` 不在选项内或 `text` 不合规为 `bad_request`，且弹窗仍保持待处理。
R3. 超时 30 分钟（构造参数可调，测试用）：广播 `prompt.resolved(timeout)`，调用方按拒绝/未回答处理。
R4. `stop`、会话删除、池关闭时所有待处理弹窗撤销为 `cancelled`。
R5. 快照含 `prompts`（待处理弹窗）；重连与 `resync` 都能拿到；无客户端在线时弹窗保持待处理，不因无人在线而超时提前。
R6. 同一弹窗落定后再次落定无效（超时与答复竞争只有一个赢家）。
R7. `ask_user` 工具：入参 `question`（必填）与可选 `options`（字符串数组，2–8 项）；有 `options` 为 choice，无则 input；答复作为工具结果；超时返回“用户未回答”，撤销返回“已取消”。
R8. 工厂收到池提供的 `extensions`（含 `ask_user`），由工厂交给资源加载器。
R9. WebUI：弹窗出现在对应会话的 chat pane，可点选/输入作答；落定后消失；多端先答先赢后另一端自动关闭；可访问（焦点管理、Esc 不等于拒绝）。
R10. 命令行客户端：收到 `prompt.requested` 显示问题与编号选项，输入 `/answer <编号或文本>` 作答；已落定的提示给出说明。
R11. 既有协议行为不变，既有测试通过；未知类型仍被旧客户端忽略。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1、R2 | 池单测：双客户端并发答复只有一个成功；非法 optionId 仍待处理 | 变异：允许重复落定，必须变红 |
| R3、R6 | 假定时器：到期超时；答复后再到期无二次落定 | 变异：超时不清理答复，必须变红 |
| R4 | stop/删除/关闭后 Promise 以 cancelled 落定 | 变异：stop 不撤销，必须变红 |
| R5 | 断线重连的快照含待处理弹窗；resync 同 | 变异：快照不带，必须变红 |
| R7、R8 | 对着 stub 模型：模型调用 `ask_user`，答复后进入下一轮请求（工具结果含答复） | 是 |
| R9 | web 组件测试；浏览器验证（`browser-verify.md`） | 不适用 |
| R10 | client 测试：渲染与 `/answer` | 是 |
| R11 | 全量测试与 `scripts/check.sh` | 不适用 |

## Design
`src/session/prompts.ts`（弹窗表：创建、答复、超时、撤销，纯逻辑 + 注入计时器）；`pool.ts` 暴露 `ask` 并把弹窗并入快照与广播；`src/session/tools.ts` 定义 `ask_user` 扩展；`api/sessions.ts` 解析 `answer_prompt`。协议增量只增不改，无存量数据迁移。

## Risks
弹窗只存内存：重启丢失，与运行中被中断的工具调用一致。
