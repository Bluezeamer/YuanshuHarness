# Intent: 部署骨架
Author: bluezeamer
Status: accepted
Date: 2026-10-16
Lane: decide
Why: 要选 Web 框架（新的外部依赖），要定下健康端点与启动参数（对外契约），要引入 Dockerfile 与 npm 打包（新的部署形态），均难逆，故为决策档；产物的真实运行行为（镜像能否起来、包装好后能否跑）只有实际运行才能证实，实现阶段按静默信号加固。

## Links
来源: ROADMAP 第 1 条
上游: ../../../ROADMAP.md、../../../genesis/adr/0012-delivery-form.md、../../../genesis/adr/0013-tech-stack.md、../../../genesis/adr/0014-hosting-and-ci.md
下游: 定稿后回填

## Problem
骨架只有占位模块和检查护栏，没有任何可运行的 Server，也没有交付物。ROADMAP 第 2 条起的所有能力既没有可挂载的进程，也没有"装得上、起得来"的交付路径。
[ADR-0013](../../../genesis/adr/0013-tech-stack.md) 把具体的 Web 框架与传输层留给了骨架 intent；上一份骨架 intent 把它们划到了 ROADMAP 第 1 条，所以在这里决定。

## Proposed outcome
一个什么业务都不做的 Server，加上两种能被构建出来、并实际跑起来的发布物：
- 一条命令启动 Node 服务，监听配置的地址与端口，提供健康端点；收到 SIGTERM/SIGINT 能正常退出。
- WebUI 打包进 Server，一个进程一个端口：能托管一个占位静态页，用来证明"打包进 Server"这条路是通的。
- npm 包：本地能 `pack`，装到干净目录后能启动并通过健康探测。**不发布**。
- Docker 镜像：本地能构建，起容器后健康探测通过，数据目录是挂载的卷。**不推送**。
- 两种发布物来自同一份构建产出。
- `scripts/check.sh` 与 CI 覆盖新增的构建与"实际跑起来"的验证；缺少前提（例如没有 Docker）按防假绿的原则必须失败，而不是跳过。

## Out of scope
- 任何业务能力：会话、事件流、认证与访问控制的落地、数据持久化。
- 传输层（WebSocket 或 SSE）：随 ROADMAP 第 3 条的事件流一起定（见 Decisions needed 5）。
- 数据目录的结构版本号与迁移机制：有第一份持久化数据时才有可迁移的东西，随第 3 条（见 Decisions needed 4）。
- WebUI 的真实前端工程（React、Tailwind、构建工具选型）：属第 4 条。
- 首次发布：推送 npm 与镜像仓库、打 tag 触发发布物构建，属 ROADMAP 末条。
- pi SDK 依赖与契约测试：第 2 条。

## Constraints
- 交付形态：npm 包加 Docker 镜像，所有状态放进单一数据目录，启动参数只有数据目录、监听地址、访问令牌、允许的来源网段（[ADR-0012](../../../genesis/adr/0012-delivery-form.md)）。
- TypeScript、Node ≥ 22.19；WebUI 由 Server 托管静态资源（[ADR-0013](../../../genesis/adr/0013-tech-stack.md)）。
- Server 以 Linux 为目标，镜像也只做 Linux（[ADR-0012](../../../genesis/adr/0012-delivery-form.md)）。
- CI 逻辑写进仓库脚本，工作流只做调用；托管 runner；开发期只在本地构建，不做 CD（[ADR-0012](../../../genesis/adr/0012-delivery-form.md)、[ADR-0014](../../../genesis/adr/0014-hosting-and-ci.md)）。
- 仓库公开：不得把凭据、个人信息写进镜像、文档、脚本。
- 单进程内要承载多会话，避免进程全局状态（[ADR-0013](../../../genesis/adr/0013-tech-stack.md)）；框架选型要看是否妨碍这一点。
- 启动参数里的访问令牌与来源网段，在认证落地（第 3 条）之前没有任何东西可保护。接受却不生效会让使用者以为已受保护，属静默错误，见 Decisions needed 2。

## Decisions needed
难逆 / 易逆标注在每条后面；易逆的推迟到 spec，不在 ADR 里定。

1. **Server 的 Web 框架**（难逆；产出一份 ADR）。候选：
   - Fastify：成熟，插件生态完整（静态托管、WebSocket、SSE 均有官方插件），自带日志；依赖较多。
   - Hono：轻，Web 标准 API，适配器切换运行时方便；Node 下要借助 `@hono/node-server`，WebSocket 需要额外适配。
   - 原生 `node:http`：零依赖，健康端点够用；到第 3 条要自己做路由、静态托管、WebSocket 握手，等于自己写框架。
   - 建议：Fastify。理由是后面要托管静态资源、做事件流，成熟插件省下自己造轮子，且多会话隔离靠自己的代码，与框架无关。需要你确认。
2. **启动参数与健康端点的契约**（难逆；产出一份 ADR）。待定内容：
   - 参数名与环境变量名、优先级（命令行 > 环境变量 > 默认值）、默认监听地址（建议 `127.0.0.1`，镜像里显式设为 `0.0.0.0`）、默认端口、数据目录的默认位置。
   - 令牌与来源网段两个参数：建议**本 intent 不引入**，第 3 条和认证一起加。ADR-0012 的"四个参数"是目标形态，不是第 1 条就要全部生效。
   - 健康端点：路径、返回内容。建议无需认证，只返回状态与版本，不暴露任何路径、配置或会话信息。
   - 监听非回环地址时，因为认证尚未落地，行为是拒绝、警告后放行还是放行：建议警告后放行。当前 Server 除健康端点外没有任何功能，暴露面等于零；Docker 里也必须能监听 `0.0.0.0`。
3. **发布物的构建与形态**（难逆；产出一份 ADR）：
   - npm 包的形态：server 与 web 如何合成"一个包"（建议保持两个 workspace 包，构建时把 web 产物复制进 server 的发布目录，发布单个包，不引入打包器）。
   - 命令名与包名：npm 一旦发布难以更改，本条只定命令名用于 Docker 入口与文档，包名到首次发布时定；上一份骨架 intent 把命令名划出了范围。需要你提供，或我给候选。
   - Docker 基础镜像：建议 `node:22-slim`（glibc）而不是 alpine（musl），后面 SQLite 与 pi SDK 的原生依赖在 glibc 下更稳；以非 root 用户运行，数据目录固定为 `/data`，不在镜像内放任何配置。
   - 镜像构建方式：多阶段，复用同一份构建产出。
4. **数据目录的结构版本号推到第 3 条**（难逆；记录在本 intent，不单独出 ADR）。建议：本 intent 的 Server 只校验数据目录存在且可写，不写任何版本标记。[ADR-0012](../../../genesis/adr/0012-delivery-form.md) 的"影响"一节要求数据目录带版本号，但现在没有数据，设计出来的版本格式无法被验证。
5. **传输层（WebSocket 或 SSE）推到第 3 条**（难逆；记录在本 intent）。[ADR-0013](../../../genesis/adr/0013-tech-stack.md) 说留给骨架 intent，本条明确改为留给第 3 条，因为选择取决于 [ADR-0005](../../../genesis/adr/0005-client-protocol.md) 事件流的具体形态（双向与否、重连方式）。第 1 条的框架选型要保证两种都支持。
6. **CI 里是否构建镜像**（易逆，推迟到 spec）。倾向每个 PR 都构建并起容器做健康探测；托管 runner 自带 Docker。

## Open questions
- Fastify 当前主版本与 Node 22.19 的兼容、锁定版本：spec 阶段核实。
- 镜像里 `HEALTHCHECK` 用什么探测（镜像内不一定有 curl）：spec 阶段核实。
- 用 `pnpm deploy` 还是复制构建产出来生成 npm 包的内容，才能保证"装到干净目录能跑"：plan 阶段用实验定。
