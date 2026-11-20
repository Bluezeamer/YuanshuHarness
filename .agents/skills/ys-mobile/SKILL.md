---
name: ys-mobile
description: 元枢 Harness 手机端（`/m/` 入口、手机版导航与页面、PWA 壳、service worker、Web Push、设备令牌、软键盘与视口、回前台重连）的写法与踩坑。新增或修改 packages/web 的手机入口 / 手机页面、manifest / 图标 / sw.js、推送与设备相关的服务端代码，或写手机端验收脚本时加载。涉及观感时同时加载 ys-ui-design。
---

# 元枢手机端：写法与踩坑

手机端**只是同一个 Server 的访问通道**，不是第二个产品：不新增能力、不叠加复杂度，能复用就复用，不为手机写特例。视觉与组件仍走 `ys-ui-design` / `ys-ui-build`（令牌、字样角色、守卫都照常），本文只管手机特有的部分。

## 铁律

1. **复用而不重写**：对话视图（`features/chat` 的 `ChatView`，纯属性驱动）、chat 状态层、`api/`、`ui/`、markdown 渲染都直接用；手机只写外壳（导航栈、页面、手机版布局 store）。**不共用**桌面 Shell、平铺窗格、各标签的窗格外壳。
2. **手机版布局 store 实现 `LayoutStore` 里「打开某个东西」的意图级操作**（`openPreview` / `openFilePreview` / `openDiff` / `openTeamDiff` / `openInBrowser` / `openTab`…），语义是往导航栈推一页；标签渲染器拿到「单标签的假窗格」。需要新的跳转，先看 `LayoutStore` 有没有现成的意图，别在手机页里直接拼路由。
3. **核心功能不依赖安全上下文**：明文 `http://局域网IP` 是一等路径（项目约定：走非 HTTPS 的部署视为受信任网络）。分界用 `window.isSecureContext` 与特性检测，不看 UA 与「是不是手机」。明文下不注册 service worker、不请求通知权限、不要求安装。
4. **一个问题一种解法**：回前台重连、通知决策这类跨流的行为做在共享数据层 / 服务端一处，不在手机页里补特例。

## 安全上下文：明文下会坏的东西

明文 `http://192.168.x.x` 下不可用：service worker、Push / Notification、WebAPK 安装、`getUserMedia`、异步 Clipboard、`crypto.subtle`、**`crypto.randomUUID()`**（前端生成 id 时最容易踩，会直接抛 `is not a function`，要用 `getRandomValues` 自己拼）、Wake Lock、WebAuthn、`navigator.storage.persist()`、VirtualKeyboard API。仍可用：fetch、WebSocket、`localStorage`、IndexedDB、普通 Cookie（不能带 `Secure`）、`<input type=file accept=… capture>`、`visibilitychange` / `pageshow`、`history`。回环地址（`localhost`、`127.0.0.1`）**算**安全上下文，所以测明文档要用本机局域网 IP；自签证书点「继续访问」**不会**获得 PWA 能力。剪贴板已有退路（`ui/clipboard.ts`），新代码照用，别直接 `navigator.clipboard`。

## 视口、键盘与滚动

- 整页壳 `height: 100dvh`（不要 `100vh`）+ flex：消息区 `flex: 1; min-height: 0; overflow-y: auto`，**输入框是 flex 最后一个子项，不用 `position: fixed`**（Chrome 108 起默认只缩 visual viewport，`fixed` 元素会被软键盘遮住）。
- viewport meta 写 `width=device-width, initial-scale=1, interactive-widget=resizes-content`（明文下同样生效）；`visualViewport` 兜底：键盘高度 = `layoutHeight − vv.height − vv.offsetTop`，**同时监听 `resize` 和 `scroll`**，`vv.scale > 1.01`（用户在捏合）时按 0；键盘弹出后补一次滚到底。VirtualKeyboard API 只有 Chromium 且仅 HTTPS，不当主路径。不开 `viewport-fit=cover`，要沉浸式再同时处理安全区（Chrome 135 起 `safe-area-inset-bottom` 要用在 `bottom` 上，不要写成 `padding`）。
- 禁整页下拉刷新：壳 `html, body { overflow: hidden; overscroll-behavior: none }`，只有列表、消息区自己 `overflow-y: auto; overscroll-behavior: contain`（Chrome 144 前对没有可滚动溢出的容器无效，别只给 `body` 设）。**别用 `user-scalable=no`**；表单控件字号 ≥ 16px（iOS 聚焦会自动放大）。
- **版面要在 320–430 各档屏宽下都放得下**（常见症状：模型名把发送按钮挤出输入卡、弹窗伸出屏幕）。三条常见根因：①`display: grid` + `place-items: center` 的遮罩，隐式列按卡片的固定 `width` 撑开，`max-width: 100%` 是相对这一列算的，窄屏上整张卡伸出屏幕——列要写 `grid-template-columns: minmax(0, 1fr)`（`ui/styles/overlay.css` 的 `.u-modal`）；②桌面标签页工具条的窄窗格降级都写成 `@container pane (max-width: …)`，手机的 `.m-tabbody` 自己就是名为 `pane` 的容器，不然这些规则在手机上一条都不生效；③输入栏工具行里能让的是模型名（`min-width: 0` + 省略号），发送与停止永远不让；再窄（容器 ≤ 340）就连「审批 ·」前缀也收掉。新写的行内多控件（按钮 + 文字 + 图标）要想清楚哪个先让、怎么让，别指望屏够宽。
- 触控目标 ≥ 48×48 CSS px、相邻间距 ≥ 8px（同时满足 Android 与 iOS）；`touch-action` 只在需要自己处理手势的元素上设（它按祖先交集取值、手势开始后改无效）；`user-select: none` 只给按钮、图标这类非内容元素，聊天正文保持可选。

## 返回栈

- 路由即栈：列表 → 对话 → 详情；**由用户点击触发 `pushState`**（没有用户激活产生的历史条目会被 Chromium 的历史操纵干预跳过，返回键会直接退出）；弹层（审批、附件抽屉、预览）各占一条历史，关闭走 `history.back()`；UI 上的返回按钮也调 `history.back()`；`popstate` 里以 URL / `history.state` 为唯一真相重新渲染，不另存「当前页」。
- 从通知进入时保证栈底是列表（先 `replaceState` 列表，再 push 对话）。界面里**始终带返回按钮**，不能只靠手势；`CloseWatcher` 只能当增强（Safari 刚加入）。

## 回前台与重连

- 后台就是断线：Chrome 冻结页面时会让 WebSocket 失败，Doze / 国产 ROM 省电会掐网络，`onclose` 不一定触发，**连接可能「看着开着其实已死」**（浏览器脚本观察不到协议层心跳）。
- 会话流连上先发有上限的快照，之后是带序号的增量，对不上就 `resync`：**重连就是拿新快照**，不需要事件日志与游标补发。
- 回前台（`visibilitychange` 变可见、`pageshow`、`online`）已经做在 `api/foreground.ts`：`onForeground(cb)` 合并信号，`createProbe(ping, onDead)` 做探活（发 `ping`、3 秒内收到**任何**消息就算活，否则判死；单飞）。每条流订阅后的规矩：已断（退避中或已放弃）**立即**重连并清零失败计数；连着就探，判死就关旧连接、立即重连；首次连接还在路上的不打断；重连期间不清屏；探针要在连接自己断开、释放时取消。四条流（会话、列表、浏览器事件、浏览器画面）都这样接，服务端各认 `ping`（会话流回 ack，其余回 `pong`）；**新增推送流照这个接，别各写一份，也别用 `resync` 当探针**（会让会话流每次回前台重拉历史）。服务端另有协议层心跳（`api/lib/ws.ts` 的 `startHeartbeat`，会话、列表、终端、浏览器两条流都接；间隔与超时取 `api/sessions.ts` 的 `DEFAULTS`：30 秒一次 Ping、10 秒内没有 Pong 就掐断），后台里被掐断的连接靠上面的回前台重连兜底。
- Background Sync / Periodic Sync 不用（Firefox、Safari 没有，且不能接收服务端事件）；Wake Lock 只给「正在看浏览器画面」，仅 HTTPS，特性检测失败静默忽略。

## service worker（共用 `/sw.js`）与 Web Push

- 只管外壳：导航请求 network-first、失败回退缓存的壳；带哈希的静态资源 cache-first；**绝不拦 `/api` 与 WebSocket，不缓存带 `Authorization` 的请求**；更新由 sw 通知页面、用户点「刷新」才生效。别抄「cache-first 一切 + Workbox + 从第三方域名 `importScripts`」的示例（会破坏流式，也违反不引第三方域名资源的守卫）。
- **每条 `push` 必须显示通知**（Chrome 有静默推送预算，违反会弹通用通知；iOS 会撤销订阅）；撤回已发的通知用同 `tag` 替换成低调文案，不要静默关闭。`notificationclick` 里自己 `close()`，已有同源窗口就 `focus()` 并 `postMessage` 导航，否则 `openWindow('/m/…')`。通知上**不放 actions**（Safari 不支持，且批准前要先看命令）。service worker 里读不到 `localStorage` / `sessionStorage`。
- 订阅一律走 `registration.pushManager`（子作用域下 `window.pushManager` 在 iOS 取不到）；请求权限必须在用户手势里，设置页放按钮，不要在加载时弹。
- 服务端：VAPID 密钥**生成一次持久化、不轮换**（浏览器每个源只认一个公钥，换了用户要手动清权限）；`subject` 用 `mailto:`（`https://localhost` 在 Safari 返回 `BadJwtToken`）；载荷只放事件 id、类型与几十字文字，**≤ 2 KB**（FCM 桥接的 Firefox 上限约 2744 字节）、不要补零；返回 404 / 410 立即删订阅；`Urgency: high`、TTL 取小时级（审批在服务端会一直挂着）；**不硬编码推送服务白名单**（会挡掉 UnifiedPush 用户）；订阅表按设备令牌绑定，撤销设备即删订阅。
- Web Push 经 Google 的 FCM：无 Google 服务的设备、服务端连不上 FCM 的部署收不到，这是接受的边界，不为它加别的通道。

## PWA 壳

- 手机 manifest 单独一份（`id` / `scope` / `start_url` 都是 `/m/`）；图标要 192 / 512 PNG + 512 maskable PNG（`purpose` 分开写，不合并成 `"any maskable"`）；SVG 加 `sizes: "any"` 能过可安装判定但别只靠它。真 WebAPK 只发生在有 Google 服务的 Chrome 与三星设备的 Samsung Internet，其余（含国产 ROM 浏览器）都是浏览器标签页里的快捷方式——布局要同时适配标签页与独立窗口。
- `beforeinstallprompt` 只触发一次、只有 Chromium 有：入口页早期捕获，没有就显示图文步骤；`@media (display-mode: standalone)` 与 `navigator.standalone` 一起判「已安装」。
- **文件**：`public/sw.js`（桌面与手机共用）、`public/m/manifest.webmanifest`、`public/m/` 下的 PNG 图标（入库的产物，改品牌图后跑 `node scripts/brand/png.mjs`，用 Chromium 把 `icon.svg` / `icon-maskable.svg` 渲染成 192 / 512 / maskable 512 / apple-touch-icon 180）。**`m/index.html` 里不写 `theme-color` meta**：构建产物守卫不让 HTML 里出现色值，主题色只放 manifest。`sw.js` 的测试在 `mobile/push/sw.test.ts`：用 node `vm` 跑真文件，喂假的 `self` / `caches` / `clients`，别另写一份「等价逻辑」。
- 改了 manifest 里 `name` / `icons` / `scope` / `start_url` / `theme_color` 等会让已装的 WebAPK 重新打包，手机上很难立刻看到，开发期最快的办法是卸载重装。
- 给 iOS 留的（成本很低，现在就写）：`/m/index.html` 里 `apple-touch-icon`（180 PNG）与 `apple-mobile-web-app-title`；输入框字号 ≥ 16px（目前输入框沿用桌面 13px，是已知差距：iOS 聚焦会缩放页面；字号只能改在 `ui/type.css`，受设计守卫约束）；订阅走 `registration.pushManager`；不依赖 `beforeinstallprompt`、`interactive-widget`（Safari 才刚加入）、Background Sync、`freeze` / `resume`、`CloseWatcher`；iOS 推送要求先添加到主屏幕且权限请求来自用户手势。

## 代码布局（`packages/web/src/mobile/`）

页面、导航栈、布局、通知与安装各个文件的分工，以及 `?layer=` 弹层等路由约定：改 `packages/web/src/mobile/` 下的代码前读 `references/layout.md`。

## 设备令牌（服务端）

令牌随机 32 位以上、库里只存哈希；校验认两种凭据（全局令牌、设备令牌），沿用 `Authorization` 与 WebSocket 子协议；配对码一次性、5 分钟有效、校验走现有失败限流；**只有全局令牌能创建配对码**；撤销要同时断开该设备已开的连接并删订阅。手机端沿用 `app/Gate` 落的会话 Cookie（HTML 预览的 iframe 子请求只能靠它带凭据）；Cookie 不按端口隔离，设备令牌会随它发到同一 IP 上别的端口的服务，这与桌面的全局令牌一样，撤销设备即失效。

实现在 `packages/server`：`store/devices.ts`（表与哈希）、`devices/pairing.ts`（内存里的配对码）、`devices/connections.ts`（按设备记底层 socket，撤销时掐断）、`api/devices.ts`；写法见 skill `ys-server` 的「设备与手机入口」。

## 验证

jsdom 测不出布局、键盘、滚动、安全上下文：手机端用真浏览器脚本验（Chromium 手机设备描述 + 触控 + 2 倍屏），模拟**测不到**软键盘、安全区、地址栏收起、安装流程、真实推送。各脚本验什么、明文 / HTTPS 两档怎么模拟、哪些只能真机验证，见 `references/verification.md`；脚本通用写法见 `ys-delivery/references/verify-scripts.md`。
