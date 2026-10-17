# ADR-0020: 客户端传输层：每会话一条 WebSocket

状态：已定稿
日期：2026-10-17
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「技术选型」客户端协议一行；ROADMAP 第 3 条

## 背景
[ADR-0005](0005-client-protocol.md) 定了事件流的语义，[ADR-0013](0013-tech-stack.md) 与 [ADR-0017](0017-server-web-framework.md) 都把传输层（WebSocket 或 SSE）留到事件流落地时。
WebUI、命令行、IM 网关都要按这里的选择写客户端，选定后换传输层等于重写所有客户端，所以难逆。

2026-10-17 的核实（版本来自本人查 npm 注册表；其余来自 pi 的网络检索，未逐条独立复核）：

| | WebSocket | SSE 加 HTTP 命令 |
|---|---|---|
| Fastify 插件 | `@fastify/websocket` 11.3.4（依赖 `ws`、`duplexify`、`fastify-plugin`） | `@fastify/sse` 0.6.1，仍是 0.x；也可不用插件手写 |
| Node 内置客户端 | 全局 `WebSocket`，稳定 | `EventSource` 实验性，需开关；本机 Node 24 里不存在该全局 |
| 浏览器自定义请求头 | 不能 | 不能 |
| 反向代理 | 需透传 Upgrade 头，调大空闲超时 | 需关缓冲，调大空闲超时 |

## 候选方案
### 方案 A：WebSocket，每个会话一条连接
命令与事件在同一条连接上，先后顺序天然一致。
代价：要自己发心跳；代理要配 Upgrade；不能用 curl 直接调试命令。
### 方案 B：SSE 推事件，HTTP 请求发命令
HTTP 语义简单，curl 可调。
代价：每个会话两个通道，命令与事件的先后要自己对齐；官方 SSE 插件未到 1.0，Node 又无稳定的 `EventSource`，命令行客户端要自己解析流。

## 决定
方案 A。
- Server 用 `@fastify/websocket`，精确锁定版本，随 Fastify 升级时核对公告。
- 一个会话一条 WebSocket 连接；会话的创建、列表、查询走 REST（具体路径见 [ADR-0021](0021-session-wire-protocol.md)）。
- 跨会话的通知（例如环境状态）以后另开独立端点，不改本期协议。
- 心跳由 Server 发协议层 ping，客户端不应答则断开；间隔与超时留给 spec。
- 认证令牌如何随连接携带（浏览器 WebSocket 不能自定义请求头），由认证的 ADR（ROADMAP 第 3 条第三块）决定；本 ADR 不预设。

## 理由
- "停止"、排队消息、后续弹窗的答复都是客户端到 Server 的命令，且与事件流有先后关系，同一条连接上最不容易出错。
- 快照与实时流在同一条连接上衔接，不存在"拉快照"与"订阅"之间漏事件的窗口。
- 命令行客户端直接用 Node 内置 `WebSocket`，不增加依赖。
- `@fastify/websocket` 已是 11.x，比 0.x 的 SSE 插件成熟。

## 影响
- 部署在反向代理之后时必须透传 Upgrade 并调大空闲超时；写进部署文档。
- 排障不能只靠 curl，需要一个能说该协议的小工具；测试客户端与后续命令行客户端承担这一点。
- 令牌携带方式受浏览器限制，认证 ADR 要在 URL query 与子协议之间选择。
- 排除：SSE 加 HTTP 命令；每客户端一条多路复用连接（需要时另议）。
