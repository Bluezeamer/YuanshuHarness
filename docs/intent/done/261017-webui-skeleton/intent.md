# Intent: WebUI（一）前端工程骨架与会话列表
Author: bluezeamer
Status: closed
Date: 2026-10-17
Lane: build
Why: 前端栈（React、Tailwind）与"Server 托管静态资源"已由 ADR-0012/0013 定稿；新增的 Vite、测试库只是 web 包的开发依赖，发布物形态不变，revert 一个提交可恢复，所以不是决策档。命中"静默"的只有令牌的保存位置（隐私边界的客户端一侧），已在 Decisions 里列出请人确认；其余出错当场可见。

## Links
来源: ROADMAP 第 4 条（WebUI 基础）的第一块
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0012](../../../genesis/adr/0012-delivery-form.md)、[ADR-0013](../../../genesis/adr/0013-tech-stack.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)
下游: 定稿后回填

## Problem
`packages/web` 只有一张占位页和一个返回包名的空测试，Server 托管它，但没有任何真实界面。后两块（对话、重连与弹窗）都需要先有可构建、可测试、带风格的前端工程，以及"拿到令牌、连上 Server、列出会话"这条最短路径。
风格已由 `yuanshu-webui-style` 技能固定（改良版瑞士国际主义），工程需要把它落成主题变量，而不是在组件里写死色值。

## Proposed outcome
- `packages/web` 是 Vite + React + Tailwind 工程，`pnpm build` 产出 `dist/`，`scripts/pack.sh` 照旧复制进 server 包，Server 托管后浏览器打开即看到界面。
- 风格令牌（颜色、字体、圆角）定义为 CSS 变量，Tailwind 主题映射到语义名；全站不出现写死的色值。
- 外壳：顶栏（品牌、tab、连接状态）；本期只有"对话"一个有内容的页面，其余 tab 不预留空壳。
- 令牌门：Server 要求令牌时（REST 返回 401），显示输入令牌的界面；通过后进入外壳。回环无认证时直接进入。
- 左栏会话列表：来自 `GET /api/v1/sessions`，按 `updatedAt` 倒序，显示名称、状态点；点击选中（对话区本期只显示"选择会话"占位，下一块接入）。
- 测试：组件与 API 层用 vitest + jsdom 覆盖令牌门、列表、错误态。

## Out of scope
- 对话内容、发送、停止、WebSocket（下一块）。
- 自动重连、同步条、统一弹窗（再下一块）。
- 新建、重命名、删除会话：真实 `yuanshu serve` 在 ROADMAP 第 7 条之前没有会话工厂，`POST` 返回 501，界面不放无法使用的按钮。
- 管理类页面（环境、Agent、权限等），暗色主题与主题切换器。
- 远程字体：不从任何第三方域名加载资源（见 Decisions 1）。

## Constraints
- 不改 `/api/v1` 协议，只增不改（[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)）。
- 令牌不得进入 URL、日志、`console` 输出（[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)）。
- 静态资源不需要认证，构建产物不得包含令牌或任何服务端配置（[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)）。

## Decisions needed
默认按建议实现，验收时可改。
1. **字体不走远程。** 参考稿用 Google Fonts，但元枢常部署在内网，远程字体会让界面在无外网时回退得不一致，也向第三方泄露访问行为。建议：只写本机字体栈，西文 `Inter`、等宽 `Cascadia Code`（均仅在本机已安装时生效），中文用系统默认；不打包字体文件。
2. **令牌存放位置。** 候选：仅内存（刷新就要重输）、`sessionStorage`（关标签页清除）、`localStorage`（长期保留）。建议：`sessionStorage`。单人使用时 `localStorage` 更省事，但令牌会在浏览器里长期以明文留存，页面一旦出现脚本注入就能读走；`sessionStorage` 把暴露窗口收到当前标签页。以后想要"记住我"再加。
3. **构建工具选 Vite。** ADR-0013 只定了 React 与 Tailwind，没定打包器。建议：Vite（Tailwind 4 有官方插件，vitest 同源）。仅开发依赖，随时可换。

## Open questions
- vitest 5 与 vite 8 的配合，实现时以安装结果为准（plan 第一步验证）。
