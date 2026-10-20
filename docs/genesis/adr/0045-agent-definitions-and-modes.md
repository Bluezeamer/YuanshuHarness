# ADR-0045: agent 定义、提示词块、build / plan 模式

状态：已定稿
日期：2026-10-20
可逆性：可逆（原型期数据目录可重建）
取代：无
被取代：——
引用入口：ROADMAP 第 2 条

## 背景
[ADR-0003](0003-concept-model.md) 定了 agent 定义 / workspace / 会话三者关系，[ADR-0009](0009-prompt-assembly-injection.md) 定了提示词分组拼接与注入，[ADR-0008](0008-capability-sets.md) 定了能力集。本篇记录它们落地后的数据形状与 REST 协议。

## 决定
### 数据（迁移 v8）
- `prompt_blocks`：id、name、`grp`（分组）、dimension（可空）、content、version、时间戳。
- `agents`：id、name、description、`prompt_blocks`（有序块 id，JSON）、`capabilities`（JSON）、model（可空，空为 Server 默认）、`thinking_level`（可空）、`default_mode`（`build` / `plan`，可空视为 build）、时间戳。
- `capabilities` 是**能力引用列表**，元素为 `{ kind: "tool" | "skill" | "mcp", name }`。tool 对照内置工具目录校验；skill / mcp 只存名字，不校验是否存在，实际库由别处管理。
- `workspaces.inject_conventions`（默认 1）：是否注入该 workspace 的 `AGENTS.md`。
- `sessions` 增加 `agent_id`、`mode`、`prompt_text`（当前系统提示词）。
- 种子：6 个 agent 与对应块（coder-full、auditor、assistant-narrow、ops-ssh、researcher、plan-mode）。默认 agent 是固定 id 的 coder-full，不可删。

### 拼接
- 顺序：角色定义 → 全局约定 → 项目约定 → 其余分组（按首次出现）→ 运行模式。组内保持 agent 里块的顺序；约定组里文件内容排在该组块之后。
- 全局约定：数据目录下 `AGENTS.md`，经 REST 读写。项目约定：workspace 下 `AGENTS.md`，经环境原语读取（本机与 ssh 同路径）。
- 模式提示词放在最末尾，与压缩后重建基线时追加的位置一致。
- 会话创建时拼好并存入 `sessions.prompt_text`。块或 agent 修改不会自动改写已有会话：需调同步接口，仅空闲会话生效，运行中返回 `busy`；压缩后会自动重建。

### 模式
- 会话创建时由 agent 的 `default_mode` 决定 `sessions.mode`，之后固定。**本期不做运行时切换。**
- `plan`：模式提示词加执行层拦截。只读工具与 `ask_user` 放行，其余（含 MCP 等无法确认只读的工具）在 `tool_call` 被拒，原因为「当前模式下不可用」。
- 拦截扩展排在权限扩展之前：模式是上限，`full` 档位也越不过。
- agent 的 `capabilities` 不随模式裁剪，限制只在运行时生效。

### REST
- 块：`GET|POST /api/v1/prompt/blocks`，`PATCH|DELETE /api/v1/prompt/blocks/:id`。
- 约定：`GET|PUT /api/v1/prompt/conventions`。
- 预览：`POST /api/v1/prompt/preview`，入参为 `promptBlocks`（可带 `mode`）或 `agentId`，可选 `workspaceId`，返回 `{ text, parts, chars }`。
- 同步：`POST /api/v1/sessions/:id/prompt/sync`、`POST /api/v1/prompt/sync`。
- 工具目录：`GET /api/v1/tools`。
- agent：`GET|POST /api/v1/agents`，`GET|PATCH|DELETE /api/v1/agents/:id`。删除默认 agent 返回 400，被会话引用返回 409。
- 会话：`POST /api/v1/sessions` 增加可选 `agentId`，缺省用默认 agent。

## 理由
- 能力用引用列表，skill / MCP 的库独立演进时不需要再改 agent 的数据形状。
- 模式放在执行层而不是裁剪工具定义，工具集在会话内保持稳定（ADR-0009）。
- 提示词存快照加显式同步，避免编辑块时悄悄改动正在跑的会话。

## 影响
- 迁移 v8（见上）；`session/pool.ts` 创建会话时读 agent、拼提示词、挂模式扩展，`session/factory.ts` 按 agent 给 SDK 工具白名单与提示词回调。
- 排除：运行时模式切换；按模式裁剪能力清单；skill / MCP 库本身。
