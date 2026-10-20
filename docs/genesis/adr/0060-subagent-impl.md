# ADR-0060：Subagent 的数据形状、对外协议与权限边界

**作者**：bluezeamer
**状态**：Accepted
**日期**：2026-10-20

## 背景

ADR-0010 定下 subagent 的语义（子会话是普通会话加父子关系，异步派发，只收窄不放宽）。本条只记实现时落下的三处形状：存什么、对模型和 WebUI 暴露什么、权限怎么收窄。

## 决策

**数据形状**。父子关系放独立表 `subagents`（迁移 #13），不改 `sessions`：`child_id`（主键）、`parent_id`、`depth`、`task`、`spec`（JSON：agent、可用 workspace 子集、档位上限 `tierCap`、继承的工具名、模型）、`state`（running / done / failed / interrupted）、`result`、`told`（父是否已得知终态）、`denied` 与 `denied_reasons`、`created_at`、`finished_at`。不外键到 `sessions`：子会话的索引行要等第一次运行结束才有。删除会话只删它作为子的那一行，它的子会话行保留，恢复时靠 `spec` 重建约束。Server 启动时所有 `running` 行落成 `interrupted`，父下次发消息时收到一条中断提示。

**对外协议**。模型侧三个工具：

- `spawn_subagent`：参数 `task`（必填）、`agent`、`workspaces`、`inherit_capabilities`、`inherit_history`、`model`、`tier`；立即返回单行 JSON `{childId, agent, workspaces, tier}`。WebUI 的派发卡片靠它取 `childId`。
- `wait_subagent`：参数 `ids`（1 到 16 个，必须是自己派发的）、可选 `timeout_seconds`；返回人读文本，超时只是父停止等待，子继续跑。
- `interrupt_subagent`：参数 `id`；子孙一并中断。

子完成时最终回复以一条 `[系统通知]` 排队消息交给父（父空闲则被唤醒）；已被 `wait` 取走的不再重复投递。WebUI 侧 `GET /api/v1/topology` 返回 `{nodes}`，节点含 `id`、`name`、`parentId`、`depth`、`state`、`task`、`denied`、`deniedReasons`；只含有父子关系的会话。

**权限边界**。子会话以无人值守方式运行：没有弹窗通道，需要人工的动作（`sudo -s`、要密码的 sudo、占终端的命令）和拿不准的调用一律拒绝，且不产生新的记住规则。生效档位取 workspace 档位与 `tierCap` 中较严的一档，永远不到 `full`；父是 plan 模式则子也是；可用 workspace 只能是父可用的子集。被拒的次数与最近 3 条原因记入 `subagents`，在拓扑节点上展示。深度上限 2、单父并发 4，常量集中在 `subagent/limits.ts`。

## 后果

- 子会话没有人工通道，缺权限只能写进最终结果，由父决定怎么办；这是有意的，代价是需要审批的任务不适合派给子。
- `subagents` 表独立，`sessions` 迁移不受影响；多分支各自追加迁移时只需处理编号。
- 子会话的 `spec` 一经写入不改，档位或 workspace 要变就重新派发。
