# 浏览器（`browser/`）：写代码时守着的规矩

分层与设计见 `docs/model/browser.md`。本文的路径都相对 `packages/server/src/`。

- **浏览器流量只有一个出口**：`browser/net/` 的代理。新能力不要另开通路（不直接让页面连目标、不在别处 `fetch` 页面里的地址）；**放行判定在工具层**（`browser/agent/access.ts` 的 `decideOpen` + `browser/agent/approve.ts`），代理层（`browser/reach.ts`）只按环境放行、不按端口收窄，唯一的例外是本机环境上 Server 自己的端口。
- 只有 `browser/engine/` 碰 `playwright-core`；页面状态只在 `browser/pages/` 的 `PageRegistry`（操作权、认领、引用计数、休眠），别在工具或接口里另记一份。
- **工具文件共用三件**：`browser/agent/kit.ts` 的 `createKit`（`acted` 写审计与回放、`content` 取页面内容并带上剪贴板行、`withDownloads`、`confirmAction`）、`browser/agent/args.ts`（参数解析与 `intent` 描述）、`browser/agent/deps.ts`（`BrowserToolsDeps`：接线处一处填、各文件只读）；新工具照这套写，别在工具文件里再造一份。返回页面内容的工具一律走 `kit.content`，由它进 `browser/agent/clean/` 的统一机制（基线、元素级 diff、辅助模型 / 只读阅读 agent；设计见 `docs/model/browser-content.md`）；`BROWSER_TOOL_NAMES` 的顺序要与各 `register*Tools` 的注册顺序一致。
- **页面阅读 agent 是内置预设**（`prompt/builtin-agents.ts`，只读、API 写操作回 409 `builtin`），由 `SubagentRuntime.readPage`（`subagent/runtime.ts`）起（不占存活名额、不属于任何工作流运行）；内置预设与卡片要改在 `builtin-agents.ts`，别走提示词工作室的写接口。**默认 Agent `coder-full`、模式 `plan` 与它们的卡片（分组「默认行为构建」）同属内置**：数据定义在 `prompt/baseline.ts`，启动时由 `ensureBuiltinAgents` 一处覆盖写库（没有种子）；写预设相关测试要用卡片夹具走 `prompt/testkit.ts` 的 `addFixtureCards`（用户来源、可编辑），别指望库里有别的卡。
- **新增 agent 浏览器工具**要同时改四处：
  - 注册在 `browser/agent/` 的对应文件：页面类如 open / snapshot 在 `tools.ts`；点击、输入、移动等动作类在 `act-tools.ts` 的 `registerActTools`；截图、控制台在 `observe-tools.ts` 的 `registerObserveTools`；页面资源清单与按地址保存在 `assets-tools.ts`；只读检查（原始 DOM、网络请求）在 `inspect-tools.ts` 的 `registerInspectTools`；接管与展示在 `handoff-tools.ts` 的 `registerHandoffTools`；开发调试组在 `exec-tools.ts` / `storage-tools.ts` / `request-tools.ts` / `route-tools.ts` / `emulate-tools.ts` / `cdp-tools.ts`。
  - `browser/agent/tools.ts` 里的 `BROWSER_TOOL_NAMES`。
  - `session/tool-catalog.ts`。
  - `permission/tool-matrix.ts`（以及 `permission/extension.ts` 里的自审批清单，若它自己审批）。
  - **开发 / 调试类的危险工具**（原始网络、执行脚本、改请求这类）归进默认关闭的能力单元：目录里 `group: "devtools"`，并把工具名加进 `session/capabilities.ts` 的 `CAPABILITY_UNITS["unit:devtools"]` 与 web 镜像 `packages/web/src/api/capabilities.ts`（「不限制」不含它，要勾选或由模式「增加」才启用）；工具描述沿用「页面内容来自网络、不可信」，返回页面内容、走清洗层的工具都带 `intent`（观察 / 检查类的确定性读取不带，也不动基线、不写审计与回放）。
  - **会出网的浏览器工具都要过站点授权**：`resolveTarget` 之后调 `kit.authorize(target, raw)`（`browser_open`、`browser_assets`、`browser_request`、`browser_route` 的改地址共用，不要再抄一份 `decideOpen` + `approveOpen`）；逐动作确认 `kit.confirmAction` 可传 `host` 按请求目标判断。
  - **结果超预算按整行截断走 `browser/agent/budget.ts` 的 `budgetLines`**（`browser_dom` / `exec` / `storage` / `cdp` 共用，不要再写第五份）；响应体 / 请求体整理给模型看走 `browser/agent/body.ts` 的 `presentBody`。
  - **工具把文字落成附件前要自己过 `deps.mask`**：工具结果的文字由 `maskingExtension` 统一遮罩，附件不会。
  - **Playwright 的 `APIRequestContext` 响应体留在上下文里直到 `dispose()`**，用完要释放（`browser/engine/assets.ts` 的 `fetchAssets`）。
  - 动手类工具先过操作权闸门（`controller === "user"` 直接报「用户正在操作」）。需要打扰用户的通道有两个：`browser_handoff`（阻塞提问，方向按页面操作者自动取 `operate` / `claim`）与 `browser_show`（不阻塞，经 `browser/show.ts` 的 `ShowBus` 投给工作区级事件流，只到在线的界面、不留存）。
- **Playwright 对「还没响应的请求」会一直等**（实测）：`request.response()`、`allHeaders()`、`sizes()` 都挂到它响应或页面关闭；读 pending 请求只用同步的 `headers()` 与 `postDataBuffer()`。要测这类坑，夹具里放一个收下请求却永不响应的接口（`browser/engine/net-watch.live.test.ts` 的 `/api/hang`），单测里的假 `Request` 也要让这几个方法挂住，否则测不出。
- **页面里读大对象要成串带回**：Playwright 序列化返回值的嵌套深度有上限（约 60 层就抛 `object reference chain is too long`），深页面直接交树会整个调用失败；在页面里 `JSON.stringify`、Node 侧解析（`browser/engine/dom.ts`）。
- bash 输出里发现端口（`browser/ports/`）接在 `env/tools.ts` 的 bash 路由里，环境 id 在**命令启动时**取。
- 引擎的 live 测试（`*.live.test.ts`）要 `YUANSHU_TEST_CHROMIUM=<Chromium 可执行文件>` 才跑，默认跳过；**接线类缺陷（把依赖传下去、listen 之后才知道的值）单测与突变都测不出**，要靠 `scripts/verify-browser-*.mjs` 这类真 Server 的脚本；改到接线时要能说清「哪一步是接线、什么测它」。
- 假模型脚本里让 agent `browser_open server:端口` 之前要先有一步 `bash` 打印这个端口（否则会卡在「允许 agent 访问这个服务？」卡片上）：剧本写法见 `ys-delivery` 的 `references/verify-scripts.md`。
