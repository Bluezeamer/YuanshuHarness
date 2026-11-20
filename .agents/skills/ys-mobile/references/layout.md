# 手机端的代码布局

何时读：新增或改动 `packages/web/src/mobile/` 下的页面、导航、布局、通知与安装相关代码前，先看现有文件各管什么，沿用已有的落点。

入口是 `m/index.html`（Vite 第二个入口，`vite.config.ts` 的 `rollupOptions.input`）→ `mobile/main.tsx`：先 `setTokenStorage(localStorage)`（装成独立应用后冷启动要还在；桌面按页签放 `sessionStorage`）。

- `nav/`：`createNav()` 是**URL 即栈**的唯一实现（`push` / `back` / `replace`，`history.state` 记深度；深链接进来时列表垫在下面，深度 0 且不在列表时 `back()` 换成列表）；`route.ts` 是路由与 URL 的互转（`/m/`、`/m/s/<会话>`、`/m/t/<类型>?…`、`/m/settings`，弹层是 `?layer=new|status|tools|pages|row`，取值以 `route.ts` 的 `Layer` 为准），标签页的字段全靠 URL 查询串还原，新增标签字段要同时改 `TAB_FIELDS` 与 `route.test.ts`。
- `layout/mobileLayout.ts`：`createMobileLayout(nav)` 实现 `LayoutStore` 的意图级操作（见铁律 2）；窗口类操作一律 `no`，`viewing()` 在对话页返回当前会话。
- `pages/`：`ListPage`（工作区与会话、「需要你」区、工作区头的「工具」入口、长按行出置顶 / 归档）、`ChatPage`（顶栏 + `ChatView`，状态抽屉装 `StatusPanel`，`?audit=1` 是审计视图）、`TabPage`（把桌面各标签渲染器放进「单标签的假窗格」，按类型经 `tabDefs.ts` 懒加载并注册，浏览器标签例外走 `BrowserPage`）、`ToolsSheet`（新建文件 / 终端 / 浏览器 / 画布，对话页多一个审计；选中后 `replace` 掉这一层，返回一次回到发起页）、`BrowserPage`（只读画面：`browser/` 里 `viewTransform.ts` 是缩放平移的纯函数、`useViewer` 是手势、`useWakeLock`）、`SettingsPage`；`MobileGate` 是配对页（`/m/?pair=码`），其余走桌面的 `app/Gate`。抽屉是共用的 `packages/web/src/ui/Sheet`（不是手机私有件）。
- **复用桌面代码时留的口子**：`ChatView` 的 `nav={false}`（不带左缘导航线与右栏）、`ChatTabEnv.enterSends`（手机 `false`：回车换行，发送靠按钮；`MobileApp` 里覆盖）、`app/shell/useChatMeta`（从桌面 Shell 抽出来两边共用）、`useFilePicker` 的 `photo` / `image` 两个入口（`capture` 拍照与相册，隐藏 input 桌面也渲染，选文件的脚本要用 `[data-file-input=""]` 取任意文件那个）。
- **打开标签带会话锚点**：`mobileLayout` 里打开的标签都带上当前页的会话（`sid`）——工作区级标签（文件、终端）靠它借一条会话流、深链接靠它找回所属工作区；`ToolsSheet`、`ListPage` 的工具入口同理。标签自己的字段全在 URL 里，`patchTab` 就是 `nav.replace`。
- **长按**用 `mobile/ui/useLongPress`：触屏按住 500 毫秒触发，**抬手的 `touchend` 要 `preventDefault`**，否则浏览器补发的鼠标事件会落在刚升起的抽屉遮罩上把它关掉（真浏览器里才暴露，jsdom 测不出）。
- 提示（toast）在手机上放顶栏下面撑满宽度，按钮 ≥ 48；浏览器画面的 canvas 固有尺寸写在内联 style（刻度守卫不认 800px 这种值）。
- `pwa/`：`install.ts`（`captureInstallPrompt` 在入口早期捕获 `beforeinstallprompt`，`useInstall` 给设置页）、`register.ts`（只在安全上下文且生产构建注册 `/sw.js`；点通知时 sw 发来 `open-session`，这里转成 `nav.push`）、`pushClient.ts`（浏览器侧订阅的薄封装，换过 VAPID 公钥时先退订再订）、`usePush.ts`（设置页「通知」的状态与动作；`unavailable` 带原因：明文、不支持、iOS 未安装、全局令牌 403）。`pages/NotificationsSection`、`InstallSection` 只管展示。偏好是动作，点了立即发请求，不走保存条。
- 桌面一侧：`features/settings/devices/`（「手机设备」页：列表与撤销、`AddDeviceDialog` 出二维码，`QrCode` 用 `qrcode-generator` 画 SVG 且**懒加载**——库自带色值，进入口包会被构建守卫拦；`model.ts` 是地址与配对链接的纯函数）；令牌门 `app/Gate` 的 `alt` 属性放一个入口（桌面传「手机版」→ `/m/`）。
- `mobile.css`：类名 `m-` 前缀，触控目标走令牌 `--touch`（48，高度刻度里没有这一档）；**对话页的样式不在 `@layer` 里**（chat 的 CSS 是层外的），覆盖它只能写在层外，层内的规则永远输给层外的。键盘兜底变量 `--m-kb` 由 `useKeyboardInset` 写。
