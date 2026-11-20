# 终端生命周期

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`terminal/manager.ts`、`api/terminals.ts`、`config.ts`、`cli.ts`、`features/workspace/tabs/terminal/{StatePanel,close}.tsx`、`scripts/verify-terminal.mjs`）

**终端的生命周期 = Server 进程的生命周期。** 只有用户显式关闭、shell 自己退出、Server 停止这三种情形会结束一个终端；**不因为「暂时没有客户端」而回收**：用户关浏览器或电脑休眠后回来，应接回原来的 shell 而不是一个新 shell，这与「会话是主体、客户端只是视窗」一致（`terminal/manager.ts` 里没有空闲计时）。代码在 `packages/server/src/terminal/`、`api/terminals.ts`，前端在 `features/workspace/tabs/terminal/`。

## 1. 规则

| | 规则 | 现状 |
|---|---|---|
| R1 | 无客户端不回收 | 已实现 |
| R2 | 同一终端允许多个客户端附着，输入各自写入；关闭其中一个连接只 detach | 已实现 |
| R3 | 无客户端或客户端消费跟不上时，未消费输出达到阈值就**暂停 PTY**，接回并消费后恢复；暂停不杀 shell | 已实现：`backend.pause()` / `resume()`；WS 侧按 `bufferedAmount` 的高低水位判断（`api/terminals.ts`） |
| R4 | 终端 id 随布局持久化；刷新、换标签页、重开浏览器后接回同一 id 并回放最近输出。Server 重启后 id 失效，走 R6 | 已实现：id 存在标签的 `termId` 里，进布局持久化 |
| R5 | 提供终端列表与显式关闭，失去布局引用的终端也能被看到、被关掉 | 已实现：`GET /api/v1/terminals`、`DELETE /api/v1/terminals/:id`；条目含 id、环境、cwd、尺寸、创建时间、归属工作区、附着数、是否暂停、是否有前台进程（ssh 上为 `null`） |
| R6 | 旧 id 不存在时显示「终端已结束」和「重新打开」，**不静默新建** | 已实现（`StatePanel.tsx`） |
| R7 | 数量上限保留为安全阀，可配置；到达上限返回 429 并给出可操作的提示 | 已实现：默认 **32**（`TERMINAL_DEFAULTS.max`），`--max-terminals` 或环境变量可改；错误码 `too_many_terminals` |
| R8 | 关闭有前台进程的终端前确认；ssh 终端无法判断时也确认 | 已实现（`close.tsx`），**关闭终端标签 = 杀服务端终端**（已定决策），先探测再统一确认一次；关不掉的标签保留，免得留下孤儿 |
| R9 | 认证、WS 协议（`ready` / `exit` / `error`）、回放缓冲、慢客户端断开策略不退化 | 回放缓冲 256KB（`scrollbackBytes`） |

## 2. 不做

- Server 重启后保留 PTY（tmux、abduco、独立 PTY daemon）；只要求生命周期等于 Server 运行期。重启后恢复的是标签与显示状态，不是旧进程。
- 跨 Server 迁移终端、多人共享、配额与计费；通用输出脱敏、终端会话落盘；终端 UI 大改版。
- 单用户、默认回环、非回环必须令牌的现状不变。

## 3. 与工作区模型的关系

终端属于**工作区**，不属于会话（[`workspace.md`](workspace.md) W1）：切会话不改变工作区的布局、终端与目录；工作区归档是纯显示属性，不动其下的终端；布局每个工作区各存一份（[`workspace.md`](workspace.md) §6）。上面的规则与此无关：终端 id 存在该工作区的布局里（标签的 `termId`）。删除工作区时连带关闭它的终端（[`workspace.md`](workspace.md) §4）。

## 4. 未实现与未决

- **设想**：工作区布局模板；套用模板时复用 terminal id 还是新开，到时再定。
- **设想**：孤儿清理策略。目前完全靠显式关闭，没有「长期无引用且无客户端才清理」。
- 终端关闭的探测在 ssh 上只能给出「无法判断」（R8 因此一律确认）。

**依据**：参考 Tabby 的做法（PTY 放主进程、`PTYDataQueue` 用 100KB 分块与 500KB 未确认阈值暂停而不是杀会话、关闭有前台进程时确认）。真机验收脚本：`scripts/verify-terminal.mjs`（R1–R9）。
