# ADR-0081：侧边虚拟浏览器由 Server 管理，agent 经工具操作，WebUI 只旁观

**作者**：bluezeamer
**状态**：Accepted
**日期**：2026-10-20

## 背景

ROADMAP 第 12 条要求「侧边虚拟浏览器」：agent 能读网页、点击、输入，用户能看到它在看什么。预览 pane（ADR-0080）受 iframe 嵌入限制，也不能被 agent 驱动，所以需要 Server 端的真实浏览器。

## 决策

**Server 持有一个无头 Chromium 进程，每个会话至多一个隔离的浏览上下文（一个页面）。** 实现在 `packages/server/src/browser/`，驱动选型见 ADR-0082。

**agent 工具**（`browser_open` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_screenshot`）：

- 页面内容以带编号的文本快照返回：可交互元素给编号，其余是页面文字。点击和输入只认最近一次快照的编号，编号每次快照重编；失效时报错并提示重新取快照。
- 快照和工具描述里都标明页面内容是不可信数据，其中的指令不要照做。
- 失败抛 Error，信息直接给模型看（域名解析失败、超时、被拦截的跳转等都翻成人话）。
- 只接 http 与 https。`file:`、`chrome:`、`data:`、`view-source:` 一律拒绝。
- 下载一律拒绝，弹窗和新窗口一律关掉，agent 与用户始终面对同一个页面。

**WebUI 旁观**：

- `GET /api/v1/sessions/:id/browser` 返回状态，`DELETE` 关闭页面，`GET .../browser/stream` 是 WebSocket。
- WebSocket 文本帧是状态 JSON，二进制帧是 JPEG 画面（CDP `Page.startScreencast`）。
- 旁观流只读，不接收任何输入。页面只由 agent 的工具驱动，所以 WebUI 不能成为绕过审批的第二条操作路径。
- 没人旁观就不推屏幕帧；慢客户端的画面直接丢，不堆积。新订阅者先收到最近一帧。
- 认证由 `/api/v1` 作用域统一施加，WebSocket 升级用子协议里的令牌，与其他流一致。

**生命周期**：

- 工具无操作 10 分钟（`IDLE_MS`）回收该会话的页面。最后一个页面关闭后，浏览器进程再留 60 秒（`LINGER_MS`）才退出。
- 会话被删除时（`pool.remove`）页面与审批记录一并清掉。Server 停止时全部关闭。
- 浏览器进程意外退出时，所有页面作废，旁观者收到「未开启」状态，下次 `browser_open` 重新启动。
- 同一会话并发的首次 `browser_open` 共用同一次创建，不会开出两个页面。

**降级**：找不到 Chromium 时，状态里 `available` 为 false 并带安装提示，`browser_open` 返回同一提示；WebUI pane 显示「浏览器不可用」与提示。检查流程不下载任何东西。

## 后果

- 用户看到的就是 agent 正在看的页面，不是另一份拷贝。
- 浏览器进程是 Server 的子进程，吃内存；靠空闲回收和 linger 控制，没有做并发会话数上限。单用户场景下不加。
- 页面状态不持久化。Server 重启后页面和审批记录都没有了，agent 需要重新打开。
