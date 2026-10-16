# ADR-0013: 技术栈：TypeScript、Node，React 加 Tailwind

状态：已定稿
日期：2026-10-16
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「技术选型」；VISION「约束」

## 背景
内核是 pi SDK（ADR-0001），它是 TypeScript 库。Server 要与 SDK 在同一进程内交互：
订阅事件、创建与恢复会话、挂载 hook。客户端首先是 WebUI，其次是最小命令行，TUI 最后。

## 候选方案
### 方案 A：Python（FastAPI）后端，pi 作为子进程
Python 是个人项目的默认后端栈。代价：失去进程内集成，事件、hook、会话都要经进程间协议转译，
pi 没有现成的服务化外壳（ADR-0001 背景），这层转译要自己做且脆弱。
### 方案 B：TypeScript 加 Node，与 SDK 同进程
直接使用 SDK 的类型与事件。代价：后端不用熟悉的 Python 栈；单进程内多会话要注意全局状态隔离。
### 方案 C：Rust 或 Go 后端
性能好。代价：同样无法进程内使用 SDK，且生态与 pi 脱节。

## 决定
方案 B。
- Server：TypeScript，Node ≥ 22.19（SDK 的最低要求），`@earendil-works/*` 精确锁定版本。
- WebUI：React 加 Tailwind，由 Server 托管静态资源（ADR-0012）。
- 客户端顺序：WebUI 与最小命令行先行，TUI 最后；TUI 可大量参考 pi 的设计，不重复造轮子。
- 具体的 Web 框架、传输层（WebSocket 或 SSE）、包管理、仓库结构，不在此定，留给骨架 intent。

## 理由
- SDK 是 TypeScript 库，同进程集成省掉整层协议转译，也能直接用 hook。
- 有 WebUI 的情况下 TUI 不是刚需，放最后。
- 易逆的实现选择留给后续，避免在创世期过度决策。

## 影响
- 单进程内同时运行多会话，凡进程全局状态（环境变量、工作目录、全局单例）都必须避免或隔离，
  这也是 pi-subagents 不能直接套用的原因（ADR-0010）。
- Node 版本下限随 SDK 变化，升级 SDK 时同步检查。
- 排除：Python 后端加子进程；非 TypeScript 的服务端。
