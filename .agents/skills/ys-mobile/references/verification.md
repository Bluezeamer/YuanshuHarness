# 手机端的验证

何时读：写或改手机端的验收脚本、需要在真浏览器里验证手机行为、判断哪些只能真机验证时。

- jsdom 测不出布局、键盘、滚动、安全上下文：用真浏览器脚本（Chromium，手机设备描述 `isMobile` + `hasTouch` + 2 倍屏），写法见 `ys-delivery/references/verify-scripts.md`。Playwright 模拟**测不到**软键盘、安全区、地址栏收起、安装流程、真实推送。
- 浏览器画面页的真浏览器脚本是 `scripts/verify-mobile-browser.mjs`（假模型让 agent 真的 `browser_open` + `browser_show`；CDP 派发触摸验双指缩放与平移；`wakeLock` 在 `addInitScript` 里包一层数申请次数；`visibilityState` 用 `defineProperty` 改了再派发 `visibilitychange` 验后台断流）；Playwright 的 `isMobile` 上下文里 `page.touchscreen` 只有点按，多点触摸要走 CDP 的 `Input.dispatchTouchEvent`。
- 真浏览器脚本是 `scripts/verify-mobile.mjs`（Server 配了全局令牌，先走配对页拿设备令牌，之后每一步都在设备令牌下跑；已进 `check.sh`）：列表、返回栈与滚动位置、回车换行、审批与「需要你」、状态抽屉、深链接、设置页、退出此设备、桌面撤销。
- `scripts/verify-mobile-layout.mjs`（版面扫描，已进 `check.sh`）：场景覆盖列表、工具抽屉、对话页（含长正文与审批卡）、状态抽屉、模型选择、设置、文件、预览、终端、画布与新建弹窗、浏览器、审计，每个场景在 320 / 360 / 375 / 390 / 412 / 430 宽度下各跑一遍，页面里逐元素量，报四类问题：`page` 横向滚动、`out` 伸出屏幕、`spill` 伸出父容器内容区（没有滚动容器兜着）、`clip` 文字被 `overflow: hidden` 截断而没有省略号。数据里故意放了长模型名、长标题、不能折行的长串。**收到新的错位截图后，先看它能不能被这个脚本抓到**：抓不到就补场景或补一类检测，再修，修完它就是回归保护；`--widths 320,390` 缩小范围，`--shots 目录` 出每个场景每个宽度的截图（读图自己判断品质，脚本只管几何）。它测不到软键盘、系统字体放大、安全区。
- `scripts/verify-devices.mjs`（桌面：令牌门的「手机版」入口、添加手机弹窗的二维码 / 倒计时 / 本机地址提示 / 重新生成、手机按链接配对后弹窗自己关、撤销）；二维码是否真能扫，截一张 `qr.png` 用 OpenCV 离线解码核对一次（`uv run` 的 PEP 723 脚本，`cv2.QRCodeDetector`）。
- `scripts/verify-mobile-push.mjs`（通知整条链路，已进 `check.sh`）：把 `PushManager.prototype.subscribe` / `getSubscription` 换成指向本地假推送端点的假订阅（密钥自己持有）；服务端发出的加密推送由假端点收下，用 `http_ece` 解开核对，再用 CDP `ServiceWorker.deliverPushMessage` 投给真 service worker，读 `registration.getNotifications()` 看显示、替换（同 tag 数量不变）与静音；`context.grantPermissions(["notifications"])` 给权限。脚本起 Server 时自己设了 `NO_PROXY=127.0.0.1,localhost`，发往本地假推送端点不走环境里的代理（原因见 `ys-server` 的推送一节）。**点通知的跳转只有 vm 单测**，Playwright 点不到系统通知。
- **明文来源**用 `chromium.launch({ args: ["--host-resolver-rules=MAP plain.test 127.0.0.1", "--no-proxy-server"] })` 再访问 `http://plain.test:端口`：非回环主机名就是非安全上下文，不需要局域网 IP；环境里设了 `http_proxy` 时，不加 `--no-proxy-server` 会把这个非回环主机名送去代理而 502（`ERR_HTTP_RESPONSE_CODE_FAILURE`）。
- 无头 Chromium 没有 Google 的推送服务，订阅不会真的收到：服务端用本地假推送端点核对 VAPID、TTL、紧急度、加密载荷；service worker 用 CDP 的 `ServiceWorker.deliverPushMessage` 验显示与替换；点通知的跳转拆成纯函数单测。
- 明文档与 HTTPS 档：见上，用 `plain.test` 映射得到真明文来源；真机用 `adb reverse` 让手机以 `localhost` 访问开发机即安全上下文；明文档就直接用局域网地址。Lighthouse 12 起已无 PWA 审计，安装条件看 DevTools Application → Manifest 的 Installability 与 Chrome 的 `about://webapks`。
- 只有真机能验：软键盘与输入框、WebAPK 安装、有 Google 服务手机上的真实推送、双指缩放手感、屏幕常亮、国产 ROM 浏览器；iOS 一律留给有设备的人。
