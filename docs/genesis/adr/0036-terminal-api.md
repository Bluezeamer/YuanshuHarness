# ADR-0036: 终端接口与生命周期

状态：已定稿
日期：2026-10-20
可逆性：中
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」

## 背景
WebUI 要在任意已登记环境（本机或 ssh）里开交互 shell。本篇定对外接口、断线后终端的去留，以及它与 agent 权限档位的关系。传输与认证沿用 [ADR-0020](0020-transport-websocket.md)，后端选型见 [ADR-0035](0035-terminal-pty-backend.md)。

## 决定
- **接口**（都在 `/api/v1` 鉴权作用域内，WS 升级同样要认证，子协议 `yuanshu.v1` + `bearer.<token>`）：
  - `POST /api/v1/terminals`，body `{environmentId, cwd?, cols, rows}`，201 返回 `{id, environmentId, cwd, cols, rows}`。`cwd` 缺省为环境的 home，给了必须是该环境上存在的绝对目录。
  - `GET /api/v1/terminals/:id/stream`（WebSocket）。
  - `DELETE /api/v1/terminals/:id`，204。
- **WS 帧**：二进制帧是终端原始输出；文本帧是 JSON 控制消息。服务端发 `{type:"ready", id, cols, rows}`（先于回放）、`{type:"exit", exitCode}`、`{type:"error", message}`；客户端发 `{type:"input", data}` 与 `{type:"resize", cols, rows}`。终端结束时服务端先发 `exit`（仅 shell 自行退出）再关闭，关闭码 1000，Server 关闭为 1001，慢客户端为 1013，终端不存在在升级前就是 404。
- **断线保活**：WS 断开不杀终端。最近 256 KB 输出留作回放，重连时在 `ready` 之后一次性发出；无人连接 5 分钟回收。数量上限 8，超出 429。Server 关闭时全部回收。
- **权限边界**：终端是用户本人的交互 shell，不受 agent 权限档位约束（[ADR-0006](0006-permission-tiers.md) 管的是 agent 的工具调用）。开与关写审计（[ADR-0037](0037-execution-audit.md)），输入输出一律不记。
- **错误码**：400 `bad_request`/`invalid_path`、404 `env_not_found`/`not_found`、429 `too_many_terminals`、501 `pty_unavailable`、502 `spawn_failed`。

## 理由
- 终端进程绑在 Server 而不是 WS 连接上，刷新页面或网络抖动不丢现场，这是常驻 Server 的价值所在。
- 输出只留有界滚动缓冲，慢客户端被断开而不是让内存无界增长。

## 影响
- `packages/server/src/terminal/`、`api/terminals.ts`。
- 排除：多个客户端协同输入的冲突处理（允许多端同时附着，输入各自写入）；终端会话落盘。
