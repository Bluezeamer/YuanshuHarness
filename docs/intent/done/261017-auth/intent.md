# Intent: 主干（三）认证
Author: bluezeamer
Status: closed
Date: 2026-10-17
Lane: decide
Why: 命中"难逆"——触及鉴权边界，并新增对外启动参数（令牌、来源网段），名字与行为一旦被脚本和容器配置引用就难改；同时命中"静默"（来源判定、失败限流、WebSocket 升级路径漏检），实现阶段按加固处理。

## Links
来源: ROADMAP 第 3 条（主干）的第三块
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0011](../../../genesis/adr/0011-auth-and-im-routing.md)、[ADR-0012](../../../genesis/adr/0012-delivery-form.md)、[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)、[ADR-0020](../../../genesis/adr/0020-transport-websocket.md)
下游: 定稿后回填

## Problem
Server 已有会话、事件流、持久化，且 `/api/v1` 端点不设防，只靠默认监听回环地址。ADR-0018 明确把令牌与来源网段两个参数推迟到本步骤，
并要求本步骤重新评估"监听非回环地址只打警告"的行为。ADR-0011 定了方向（受限网段加令牌，失败多次后限制），但没有定参数名、令牌的形态与存放、携带方式（尤其 WebSocket 升级）、限流细节。

## Proposed outcome
- 启动参数增加访问令牌与允许的来源网段，命令行与环境变量两种给法，名字与优先级沿用 ADR-0018 的规则。
- `/api/v1` 下所有 REST 与 WebSocket 升级都要求有效令牌；来源不在允许网段内的请求直接拒绝。`/healthz` 与静态资源保持无需认证。
- 同一来源多次令牌错误后被限制访问一段时间。
- 监听非回环地址而未配置令牌时，行为按本步骤的决定处理（拒绝启动或保留警告），不再沉默。
- 测试客户端与既有测试改为带令牌访问；缺令牌、错令牌、网段外、被限流各有用例。

## Out of scope
- IM 白名单与"平台用户 → agent"路由表（ADR-0011 的后半，随 IM 接入）。
- 账号口令、多用户、OAuth。
- TLS 与证书：部署在受信内网，由反向代理或组网层负责。
- 令牌的轮换与吊销界面。
- WebUI 的登录页面。

## Constraints
- 不做多用户与账号体系（[ADR-0011](../../../genesis/adr/0011-auth-and-im-routing.md)）。
- 启动参数只有数据目录、监听地址、访问令牌、允许的来源网段四类（[ADR-0012](../../../genesis/adr/0012-delivery-form.md)）。
- 未知参数与非法值启动即失败，不静默回退（[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)）。
- 令牌不得写入日志、错误响应或健康端点。
- 测试对着本地 stub provider，CI 不调用真实模型。

## Decisions needed
难逆（出 ADR）：
1. **令牌形态与来源**：由用户在启动参数里给定，还是 Server 首次启动生成并存进数据目录；是否允许多个令牌。建议：用户给定单个令牌，未给则拒绝在非回环地址启动；回环地址未给令牌时是否放行见第 3 条。
2. **携带方式**：REST 用 `Authorization: Bearer`；WebSocket 升级无法在浏览器里加自定义头，需在头、子协议、查询参数中选。查询参数会进访问日志，需评估。建议：评估后给候选，等你拍板。
3. **默认策略**：回环地址且未配置令牌时，是放行（本机开发方便）还是一律要求令牌。建议：回环未配置放行，非回环未配置拒绝启动，取代 ADR-0018 的警告。
4. **参数名与来源网段语法**：如 `--token` / `YUANSHU_TOKEN`、`--allow-cidr` / `YUANSHU_ALLOW_CIDR`（逗号分隔的 CIDR）；是否支持反向代理后的真实来源头（默认不信任）。

决定（2026-10-17，bluezeamer 确认方向，细节由 ADR 与 spec 落定）：
1. 令牌由用户给定，单个；Server 不生成、不落盘。
2. REST 用 `Authorization: Bearer`；WebSocket 升级用子协议携带令牌，不进 URL。
3. 监听非回环地址而未配令牌，拒绝启动（取代 ADR-0018 的"只警告"）；回环地址未配令牌放行。
4. 来源网段未配时不限制，只校验令牌；配置后只取 TCP 对端地址，不信任转发头。

易逆（推迟到 spec）：限流的次数与窗口、拒绝时的错误码细目、令牌比较的实现（常量时间）。

## Open questions
- 来源判定取 TCP 对端地址还是信任代理头：建议只取 TCP 对端，不信任任何转发头（spec 阶段确认）。
- 被限流时是整个来源被拒，还是只拒认证接口（spec 阶段）。
