# Spec: 访问认证（令牌、来源网段、限流）
Author: bluezeamer
Status: draft
Date: 2026-10-17

> 写成 delta：参数名、携带方式、拒绝码、启动检查已在 [ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)，此处只链接，补的是 ADR 留给 spec 的细节（限流数值、回环判定、实现边界）。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0011](../../../genesis/adr/0011-auth-and-im-routing.md)、[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)
下游: plan.md、PR 定稿后回填

## Requirements

**参数与启动**
R1. `--token` / `YUANSHU_TOKEN`、`--allow-cidr` / `YUANSHU_ALLOW_CIDR` 按 ADR-0026 解析（命令行优先于环境变量；每个出现的来源都校验）。令牌空串、短于 32 字符或含 `A-Za-z0-9._~-` 以外字符，启动失败；CIDR 列表任一项格式非法（含空项）启动失败。**错误信息不得包含令牌的值**（现有错误格式会回显实际值，令牌要例外）。
R2. 监听地址不是回环且未配令牌，`start()` 拒绝启动，在创建数据目录、打开数据库之前失败，错误信息指明需要 `--token` 或 `YUANSHU_TOKEN`。回环 = `localhost`、`::1`、`127.0.0.0/8` 的 IPv4 字面量（沿用既有 `isLoopbackHost`）；`0.0.0.0`、`::`、`::ffff:127.0.0.1`、其他主机名一律按非回环。ADR-0018 的"非回环只警告"随之删除。
R3. 启动日志记一条：认证已启用（含是否配置了网段、网段条数），或"认证未启用（仅回环监听）"。日志、错误信息、`/healthz` 响应中不得出现令牌。

**认证范围**
R4. 认证启用（配了令牌）时，`/api/v1` 下所有已注册路由的 REST 请求与 WebSocket 升级必须通过检查；`/healthz` 与静态资源不检查。未配令牌（仅回环）时不检查令牌。
R5. 检查顺序固定：来源网段 → 限流 → 令牌。每一步失败即返回，不进入下一步。
R6. 来源 = TCP 对端地址（`req.socket.remoteAddress`），IPv4 映射的 IPv6 地址（`::ffff:a.b.c.d`）按其 IPv4 地址比对。不读取 `X-Forwarded-For` 等任何头，也不依赖 Fastify 的 `trustProxy`。
R7. 配置了网段且来源不在其中：403 `{ error: "forbidden_source" }`，不计入限流。网段独立于令牌：回环监听且只配网段、未配令牌时，网段仍然生效。

**令牌**
R8. 令牌取自 `Authorization: Bearer <令牌>`；WebSocket 升级请求另可取自 `Sec-WebSocket-Protocol` 里的 `bearer.<令牌>` 项。缺失、错误、形状不对一律 401 `{ error: "unauthorized" }`，带 `WWW-Authenticate: Bearer`；响应不区分"缺失"与"错误"。
R9. 令牌比较为常量时间：两侧先各取 SHA-256 再 `timingSafeEqual`，不因长度不同而提前返回。
R10. WebSocket 升级通过后，响应的 `Sec-WebSocket-Protocol` 只能是 `yuanshu.v1`（客户端提供了它时），否则不带该头；任何情况下不得回显 `bearer.*` 项。认证失败发生在升级之前，返回普通 HTTP 响应，不建立 WebSocket。

**限流**
R11. 按来源地址记录令牌失败（R8 的 401）：连续失败 10 次后，该来源被封 60 秒；封禁期内该来源对 `/api/v1` 的所有请求（含带正确令牌的）返回 429 `{ error: "too_many_attempts" }`，带 `Retry-After`（剩余整秒，向上取整）。成功认证清零连续失败计数；封禁期内的请求不计数、不延长封禁；封禁到期后计数从零开始。距上次失败超过 10 分钟的记录视为过期。
R12. 限流状态只在内存、进程内，重启清零。表容量上限 4096 条：满时先丢过期项，仍满则丢最早插入的一项。不使用定时器（过期惰性判断），所以 `stop()` 后无残留句柄。时钟与数值可由 `ServerOptions` 的测试专用项注入。

**既有行为**
R13. 认证通过后，REST 与 stream 的行为、状态码、事件格式与 [ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)/[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md) 完全一致；只多出 R7/R8/R11 三种拒绝。
R14. 容器镜像的运行必须同时提供 `YUANSHU_TOKEN`；README 与镜像冒烟脚本同步更新（无令牌时容器启动失败；有令牌时 `/healthz` 免认证、`/api/v1` 要求令牌）。

## Proof
| 需求 | 证明 | 变异验证 |
|---|---|---|
| R1 | 配置单测：各非法形状逐项失败；错误信息断言不含令牌值；命令行与环境变量冲突时取命令行且两者都被校验 | 变异：错误信息回显实际值，必须变红 |
| R2、R3 | `start()` 单测：非回环无令牌失败且数据目录未被创建；回环无令牌放行；`0.0.0.0`、`::`、`::ffff:127.0.0.1` 均拒绝；日志捕获断言不含令牌 | 变异：把非回环无令牌改回警告，必须变红 |
| R4 | 集成测试：配令牌后，每个已注册 `/api/v1` 路由（含 WS 升级）无令牌均 401，`/healthz`、静态资源仍 200；用路由表遍历，新增路由忘记覆盖时测试失败 | 变异：hook 只挂在部分路由，必须变红 |
| R5、R7 | 网段外 + 错令牌得 403 而非 401；网段外的请求不推进失败计数；仅回环 + 仅网段时网段生效 | 变异：先查令牌后查网段，必须变红 |
| R6 | 带伪造 `X-Forwarded-For` 的请求按真实对端判定；IPv4 映射地址按 IPv4 规则比对 | 变异：改用 `req.ip` 且 trustProxy 开启，必须变红 |
| R8、R10 | 头与子协议两种携带都通过；缺失/错误/空 Bearer 得相同 401 体；响应的子协议头为 `yuanshu.v1` 且不含 `bearer.`（原始 HTTP 读取，不经 ws 库归一）；只给 bearer 项的客户端也能连上 | 变异：不设 handleProtocols（ws 默认回显首项），必须变红 |
| R9 | 单测：不同长度、同长度不同内容均拒绝，通过路径用同一比较函数；代码检查无 `===` 比较令牌 | 变异：改成 `===`，评审可见（时序无法稳定断言，靠代码检查） |
| R11、R12 | 注入假时钟：9 次失败仍 401，第 10 次后 429 且 `Retry-After` 正确；封禁期内正确令牌也 429 且不延长；到期后恢复；成功清零；表满时有界；`stop()` 后无活动句柄 | 变异：封禁期内放行正确令牌 / 成功不清零 / 请求延长封禁，各自必须变红 |
| R13 | 既有 `sessions.test.ts`、`persist.test.ts` 在带令牌配置下全量重跑通过 | 不适用 |
| R14 | `scripts/smoke-image.sh`：无令牌启动失败（非零退出且日志指明原因）、有令牌后三项探测；`smoke-package.sh` 仍走回环无令牌 | 不适用 |
| 全部 | 并入 `scripts/check.sh` | 不适用 |

## Design
- **模块**：`src/auth.ts`（新）：令牌与 CIDR 的纯函数（解析、比较）、限流表、一个 Fastify `onRequest` hook 工厂。hook 挂在一个只包住 `/api/v1` 路由的封装作用域里（`server.ts` 中先注册作用域，再在其中注册 `sessionsApi`），`/healthz` 与静态资源在作用域之外。认证不进会话池，池保持与框架解耦（[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)）。
- **CIDR**：用 `node:net` 的 `BlockList` 与 `SocketAddress`，不新增依赖；解析时拆 `地址/前缀`，校验前缀范围。映射地址的比对行为在 plan 步骤 1 实测确认，不符则在 `auth.ts` 里先归一化。
- **子协议**：`@fastify/websocket` 透传 `ws` 的 `handleProtocols`，在其中只选 `yuanshu.v1`；令牌的提取在 hook 里解析 `Sec-WebSocket-Protocol` 请求头（逗号分隔，去空白）。
- **配置**：`Config` 增加 `token?: string` 与 `allowCidrs: string[]`。令牌这个字段进入配置对象，凡是打印或序列化配置的地方都要排除它；现有代码不打印配置，评审时检查。`KNOWN_ENV` 加两个新名字。
- **启动检查位置**：放在 `start()` 开头，因为 `isLoopbackHost` 在 `server.ts`，而 `config.ts` 引用它会成环；检查在任何副作用之前。
- **限流判定无定时器**：每次请求按当前时间惰性判断封禁与过期。
- **迁移与兼容**：无存量数据。已按 ADR-0018 部署的非回环实例升级后会因缺令牌而启动失败，这是 ADR-0026 有意的行为，README 的升级说明里写明。

## Risks
- 无 TLS：令牌在网络上明文传输，依赖 ADR-0011 的受信网络前提；子协议里的令牌与 Bearer 头同样明文。
- 反向代理后所有请求的 TCP 对端都是代理本身：网段与限流都按代理地址判定，限流可能把全部用户一起封，网段形同虚设。本期不识别转发头，部署在代理后需要自行在代理层限制；留待有需求时另出 ADR。
- 限流表满时丢最早项，攻击者轮换大量来源地址（如同一 IPv6 /64 内）可冲掉被封条目；单用户受信网络内接受。
- 令牌无轮换，换令牌需改配置重启；命令行给令牌会出现在进程列表，文档推荐环境变量。
- 常量时间比较的效果无法在测试里稳定断言，靠代码检查；Node 事件循环下的整体时序侧信道不在威胁模型内。
- 浏览器端客户端要把令牌存在页面可读的位置才能放进子协议，WebUI 如何保存令牌留给 WebUI 的 intent。
- 无 Origin/Host 校验仍是已知缺口（见持久化 spec 的 Risks）；认证落地后跨站 WebSocket 劫持因需要令牌而不可用，但令牌泄露的路径（页面脚本）由 WebUI 负责。
