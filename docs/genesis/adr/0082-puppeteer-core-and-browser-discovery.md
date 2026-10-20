# ADR-0082：用 puppeteer-core 驱动本机 Chromium，只找不装

**作者**：bluezeamer
**状态**：Accepted
**日期**：2026-10-20

## 背景

侧边浏览器（ADR-0081）需要一个能被程序驱动、能取页面内容、能推屏幕帧的浏览器。调研（`tmp/pi/browser-embed.md`）列了 `puppeteer-core` 与 `chrome-remote-interface` 两个候选。

## 决策

**新增依赖 `puppeteer-core@25.14.0`（精确版本，Apache-2.0，要求 Node >=22.12，项目要求 >=22.19）。**

- 选它而不是 `chrome-remote-interface`：点击要滚动到可见、算坐标、等元素可交互，输入要处理焦点和键盘事件，请求拦截要配合导航守卫。这些 puppeteer 都已封装好，自己用裸 CDP 重写既长又容易错。屏幕帧仍用 CDP 的 `Page.startScreencast`，经 `page.createCDPSession()` 取得，不另装客户端。
- 选 `-core` 而不是 `puppeteer`：完整包安装时会下载约几百 MB 的 Chromium。`-core` 不带浏览器，下载行为完全不发生。

**浏览器二进制：只找不装。** `locate.ts` 依次找：

1. 环境变量 `YUANSHU_BROWSER`。设了就只认它，路径不存在则视为没有，不再往下找，避免用户以为指定生效而实际用了别的。
2. `PATH` 里的 `chromium`、`chromium-browser`、`google-chrome`、`google-chrome-stable`、`chrome`、`microsoft-edge`。
3. macOS 与 Windows 的固定安装路径。Windows 路径只写未验证，没有真机。

找不到就返回 null，由上层给出安装提示（`apt install chromium` 或设置环境变量）。状态检查、WebUI 展示、工具调用的任何路径都不会触发下载。

**启动参数**：

- `pipe: true`，用管道而不是本地调试端口通信，本机其他进程连不上浏览器。
- 关闭 puppeteer 对 SIGINT、SIGTERM、SIGHUP 的自带处理，进程退出统一由 Server 的停止流程收尾。
- 每次导航请求（含重定向）经 `navAllowed` 过问，拦下的跳转记下来回报给模型。授权规则见 ADR-0083。
- 以 root 运行时（常见于容器）Chromium 沙箱起不来，此时才加 `--no-sandbox`；非 root 保持沙箱开启。

## 后果

- 部署者要自备浏览器。没有时功能降级，其余不受影响，这是有意的取舍：不为一个可选功能让每次安装多下几百 MB，也不在用户不知情时联网下载二进制。
- puppeteer 对 Chromium 版本有兼容范围，用系统自带的发行版 Chromium 一般没问题。版本差得太远时会启动失败，此时报「浏览器启动失败」并带原因。
- 新增一个运行时依赖，升级时需关注与系统 Chromium 的兼容。
