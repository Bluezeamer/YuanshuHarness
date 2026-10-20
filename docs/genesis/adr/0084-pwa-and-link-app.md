# ADR-0084：PWA 最小集与「链接应用」独立窗口

**作者**：bluezeamer
**状态**：Accepted
**日期**：2026-10-20

## 背景

ROADMAP 第 12 条要求「常驻链接应用形态」：WebUI 可安装、可常驻，并能把某个 pane 以独立窗口打开（例如把侧边浏览器单独放到副屏）。

## 决策

### PWA：只做可安装与离线壳

- `public/manifest.webmanifest`：`display: standalone`，`start_url` 与 `scope` 都是 `/`。`theme_color` 取主题强调色，`background_color` 取页面底色，两个 hex 由主题的 oklch 值换算，保持一致。
- 图标是两个手写 SVG（`icon.svg`、`icon-maskable.svg`），珊瑚底加三条奶油纸色横线。maskable 版内容收在中心 80% 安全区内。不引入图片生成工具。
- `public/sw.js` 只缓存应用外壳：
  - 页面导航：网络优先，成功就更新缓存的 `/`，离线才回落到缓存。部署新版后立刻生效。
  - 带内容哈希的静态资源：缓存优先，未命中再取网络并写入。
- **不缓存的请求**：非 GET、跨源、路径以 `/api/` 开头（含 WebSocket 升级）、带 `Authorization` 头。令牌只走 `Authorization` 头和 WebSocket 子协议，代码里没有把令牌放进 URL 的地方，所以不会有「带令牌的 URL 被存进缓存」的路径。如果以后有人把令牌放进查询串，这条判断需要同步改。
- 注册只在生产构建进行：开发模式下 service worker 会拦住 Vite 的热更新。
- 缓存名带版本（`yuanshu-shell-v1`），激活时清掉旧名缓存。

### 链接应用：hash 路由的无 chrome 视图

地址形如 `/#/app/<pane类型>?s=<会话id>&c=<配置JSON的base64url>`。

- 放在 hash 里：不发给服务端，会话 id 与配置不进访问日志；也不改动现有 pathname 路由。
- `main.tsx` 按 hash 分流：命中 `#/app/` 渲染 `AppView`，否则渲染完整外壳。两者共用同一道令牌门（`Gate`），链接应用不绕过认证。
- `AppView` 从 pane 注册表取类型，按 `configVersion` 解析配置，把单个 pane 铺满窗口。类型未知、配置无法解析、配置版本比当前 WebUI 新，都显示明确提示而不是白屏。
- 绑定：链接带 `s` 就固定到该会话，否则跟随。
- 入口：pane 头的「↗」按钮，用 `window.open(..., "noopener,noreferrer")` 开新窗口，切断与当前窗口的引用。

### 已知限制

- 令牌存在 `sessionStorage`，每个窗口独立。链接应用新窗口不会继承登录，第一次要重新输入令牌，之后在该窗口内保持。这是现有令牌存储策略的结果，本条不改，换成 `localStorage` 会让令牌在所有标签页和 PWA 之间共享，是另一个安全取舍。
- 链接应用窗口里没有会话列表的实时更新之外的外壳功能（审批弹窗、顶栏连接状态不在该视图内）。需要审批时仍要回主窗口，所以它适合放「看」的 pane（侧边浏览器、预览、终端输出），不适合放需要答复审批的场景。
- 离线只保证能打开壳，不保证能用：所有数据都走 API，离线时连接状态会如实显示断开。
