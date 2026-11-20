# 总览与不变式

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`session/{prompts,delivery,pool,agent-settings}.ts`、`api/{sessions,terminals,browser,browser-stream,library-stream,workspaces,agent-settings}.ts`、`mcp/transport.ts`、`store/baseline.ts`、`chat/model/commands.ts`）

整套设计的入口页：产品的三条前提、跨主题的不变式、系统结构与状态归属。各主题的细节在对应文档里，这里只写**不属于任何单个主题**的东西，其余用链接。最上位的原则见 [`../philosophy.md`](../philosophy.md)。

## 1. 前提

- **会话是主体，客户端只是视窗。** 同一条会话流可以被多个客户端挂载。现状只有 WebUI（多个浏览器页签或窗口可同时挂载）；TUI 与 IM 未做。
- **审计是一等公民。** 工具调用、审批、引用都要可回溯，见 [`audit.md`](audit.md)。
- **能力越少越安全。** 白名单默认最小，见下面的 O3。

## 2. 不变式

编号稳定，只追加。工作区相关的不变式 W1–W5 在 [`workspace.md`](workspace.md) §2，不在这里重复。

| # | 不变式 |
|---|---|
| O1 | 审批与提问全端广播，**先答先赢**（`session/prompts.ts`：先到的回答结算，其余端收到已结算）。 |
| O2 | **审批与执行分离**：审批是独立事件，有超时（`outcome` 为 `answered` / `timeout` / `cancelled`）、有审计、跨端同步。 |
| O3 | **能力白名单默认最小**：模型能用的工具只有「启用集合」里的。创建会话时让 pi 注册并允许的工具名是一份定死的宽名单（`session/delivery.ts` 的 `allowlist()`：能力目录、框架工具、`mcp__*` 与 `*` 通配；pi 的白名单创建后改不了），真正的开关在运行时：每次运行前按能力求值（基线、会话增减、模式的操作，见 [`prompt.md`](prompt.md) §2）算出启用集合，把 pi 的启用工具设成它，并拦住集合外的调用（`deliveryExtension`）。不在集合里的工具调用会被拦下并给出原因，工具的增减靠状态通知告诉模型、不改前缀；框架工具必须显式并入、不受模式限制。送达机制见 [`prompt-delivery.md`](prompt-delivery.md) §3。 |
| O4 | **每个状态有唯一 owner**，不得两处写入。 |
| O5 | **库归 Server**：技能、MCP 登记、卡片、预设、供应商、密钥都存在 Server 的库里；技能经同步放进目标环境，见 [`skills.md`](skills.md)。MCP：http 型由 Server 直连，stdio 型的进程起在会话主目录（逻辑 local）所在的主机上（本机，或经 ssh 在远端），见 [`plugin.md`](plugin.md) §6。 |
| O6 | **隐私变量的值只在执行端出现一次**，名字与描述进上下文，值不进，见 [`variables.md`](variables.md)。 |

## 3. 系统结构

```
web（SPA；桌面入口 + 手机入口 /m/） ── REST + WebSocket ──→  server（所有持久化的唯一写者）
                                                              ├─ pi SDK（进程内，createAgentSession）
                                                              ├─ 执行环境：Server 本机，或经 ssh（每条连接一个持久会话）连到的目标主机
                                                              └─ 工作区浏览器（Server 持有的无头 Chromium，Playwright 驱动）
```

- **五条 WebSocket 流**：`/api/v1/sessions/:id/stream`（会话事件与命令）、`/api/v1/terminals/:id/stream`（终端）、`/api/v1/library/stream`（工作区与会话的列表级推送：状态、未读标记、改名与增删，见 [`workspace.md`](workspace.md) §5）、`/api/v1/workspaces/:id/browser/events`（工作区浏览器的页面表与引擎状态）、`/api/v1/workspaces/:id/browser/pages/:pid/stream`（单个页面的画面与输入）。其余都是 REST。
- web 不拼路径、不读密钥、不直连 SSH。
- 传输层是 WebSocket，没有 SSE 与 `Last-Event-ID` 续传：断线重连后以新快照恢复。

## 4. 状态归属

| 状态 | owner |
|---|---|
| 连接、密钥、供应商凭据、隐私变量 | Server 的库 |
| 会话配置 | Server 的 `session_configs` |
| 每个工作区的布局（窗口、窗格树、标签） | Server（`/workspaces/:id/layout`，带版本号与 revision 校验） |
| 标签的视图状态 `afx`（宽度、筛选、展开态） | 跟标签一起存进布局，不另存全局状态 |
| 「当前看哪个工作区」、侧栏折叠等纯显示偏好 | 浏览器本地（多窗口互不覆盖，见 `workspace.md` §6） |
| pi 的压缩与重试（`compaction.enabled / reserveTokens / keepRecentTokens`、`retry.enabled / maxRetries`） | Server 本机的 `<ysHome>/settings.json`（缺省 `~/.ys/settings.json`，与 `AGENTS.md`、`workflows/` 同一个根），**不碰 pi 的 `~/.pi/agent/settings.json`**：会话工厂在 `SettingsManager` 上覆盖这几个 getter（`session/agent-settings.ts` 的 `overlayAgentSettings`），每次读都看文件（按 mtime 缓存），所以改完对运行中的会话立即生效；文件里没写的键跟随 pi 自己的配置。文件是人和 agent 都能直接改的普通 JSON，我们只改自己管的键、别的原样保留；读到非法项只忽略那一项并在 `GET /api/v1/agent-settings` 的 `problems` 里写明，文件整体坏了拒绝写入、不覆盖。界面在「设置 · 默认值 · 会话与任务」：「pi 默认 / 节省上下文 / 保留更多细节」三档 + 展开改数字，改回 pi 的值写成 `null`（删键、继续跟随）。其余 pi 设置不暴露 |
| 输入框草稿 | 浏览器本地，只存文本，附件与引用只在内存 |
| 文件编辑草稿、标签的视图状态（选中、滚动、预览 / 编辑模式）、画布没保存的改动与树栏偏好 | 浏览器本地，统一走 `app/localState`（键 `ys.<命名空间>:…`），不进布局、不进服务端，换设备看不到；做法见 [`layout.md`](layout.md) §3、[`files.md`](files.md) §2 |

## 5. 术语的去向

「目录」「工作区」「会话」见 [`workspace.md`](workspace.md)；连接见 [`remote-connection.md`](remote-connection.md)；窗口、窗格、标签见 [`layout.md`](layout.md)；执行体（有独立上下文的运行实例，来源是子代理、团队、工作流）见 [`subagent.md`](subagent.md)。`afx` 是标签自己的视图状态（§4）。会话内的 `local` 就是工作区**主目录**所在的主机（[`workspace.md`](workspace.md) §3）。

## 6. 仍然成立的产品决定

- 内置斜杠命令有 `/goal`（含 `pause` / `resume` / `clear` / `edit`）、`/compact`、`/mcp`、`/reload`、`/plan`、`/review`（`chat/model/commands.ts`），**不含 `/new`、`/clear`**：会话级管理放在界面里，「清空」等于新开会话。`/goal`、`/compact` 走会话命令，`/mcp`、`/reload` 是界面自己的动作（状态弹窗、原地刷新上下文），其余以 `/` 开头的文本都当普通消息发给模型。
- 隐私变量占位符是 `{{@名称}}`，单个 `@` 留给文件 mention，见 [`variables.md`](variables.md)。
- 成本与计费（含峰谷计费）不在需求内：只统计 token 用量，见 [`audit.md`](audit.md) §2。
