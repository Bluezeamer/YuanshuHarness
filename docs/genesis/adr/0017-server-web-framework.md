# ADR-0017: Server 的 Web 框架：Fastify 5.x

状态：已定稿
日期：2026-10-17
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「技术选型」HTTP 框架一行；ROADMAP 第 1 条

## 背景
[ADR-0013](0013-tech-stack.md) 选定 TypeScript 加 Node，并把具体的 Web 框架留给骨架 intent；
部署骨架（ROADMAP 第 1 条）需要一个能托管静态资源、提供健康端点的 HTTP 服务，
后续还要承载事件流（[ADR-0005](0005-client-protocol.md)）与认证（[ADR-0011](0011-auth-and-im-routing.md)）。
路由、插件与生命周期钩子会绑在框架上，换框架要改所有路由，所以难逆。

下表数据来自 2026-10-17 由 pi 现场查询 npm 注册表与 GitHub 安全公告的结果，未经本人独立复核：

| | Fastify | Hono（加 `@hono/node-server`） |
|---|---|---|
| 当前稳定版 | 5.12.7 | 4.13.13 加 2.1.5 |
| 下一个大版本 | 6.0，alpha 阶段 | 5.0，RC 阶段，要求 Node ≥ 22.12 |
| 直接依赖 | 15 个 | 0 个（WebSocket 需自装 `ws`） |
| `engines.node` | 未声明 | `>=16.9.0` 与 `>=20` |
| 近 12 个月安全公告 | 11 条，6 条高危，均已修复 | 两个包合计约 2 条高危、约 19 条中危，均已修复 |
| WebSocket | 官方插件，基于 `ws` | Node 端 2026 年 3 月起才有，早期版本出过内存泄漏 DoS，已修复 |
| SSE | 官方插件 `@fastify/sse` 0.6.1，未到 1.0 | 内置 |

## 候选方案
### 方案 A：Fastify
为 Node 服务器设计，静态托管、WebSocket 都有官方插件，插件封装与生命周期钩子完整。
代价：直接依赖较多，供应链面更大；近一年请求校验与 Content-Type 解析类高危公告较密。
### 方案 B：Hono
零依赖，SSE 与静态托管内置，多运行时通用。
代价：多运行时通用的卖点这里用不上；Node 端 WebSocket 支持较新。
### 方案 C：原生 `node:http`
零依赖。代价：路由、静态托管、WebSocket 握手都要自己写，等于自造框架。

## 决定
方案 A。
- Server 使用 Fastify 5.x，精确锁定版本，下限为 5.12.2（此前披露的认证绕过与请求校验绕过类公告均已在该版本修复）。具体锁定版本在 spec 阶段核实后确定。
- 静态资源托管用官方插件 `@fastify/static`。
- 本 ADR 不决定传输层（WebSocket 或 SSE）。该选择随 ROADMAP 第 3 条的事件流一起定；
  届时 Fastify 的 WebSocket 插件较成熟，SSE 插件尚在 0.x，需要一并评估。
- 6.x 稳定之前留在 5.x；升级到 6.x 作为单独变更评估。

## 理由
- Server 只跑在 Node 上、长期运行，还要做事件流；Fastify 正是为这类场景设计的，Hono 多运行时通用的优势用不上。
- Fastify 的 WebSocket 插件比 Hono 的 Node 端实现成熟得多。
- 两个框架的安全公告数量级相当，这一项不构成取舍依据。
- 依赖多是真实代价，用精确锁定版本与升级时核对公告来控制。

## 影响
- 第 3 条做认证时，对照近期公告的类别（畸形 URL、Content-Type 解析、校验绕过）设计负向测试，不只依赖框架自身的校验与封装。
- 单进程多会话（[ADR-0013](0013-tech-stack.md)）：Fastify 实例与插件不承载会话状态，会话池独立于框架，避免把状态挂到框架全局。
- 升级 Fastify 时核对安全公告，并随升级调整锁定版本。
- 排除：Hono；原生 `node:http`。
