# 真浏览器验收脚本（`scripts/verify-*.mjs`）

单测在 jsdom 里跑，看不出真实布局、滚动、输入法、打包顺序、真实终端和各处接线。所以每个界面或接线改动，另有一份脚本起**真实 Server**（临时数据目录）+ **假模型**（`scripts/lib/fake-model.mjs`，按剧本回答，不需要真实模型）+ **无头 Chromium** 来验。每个脚本开头的注释写明它验什么、分几步、怎么用，**用途以那里为准**，这里不再逐个列。

## 怎么跑

1. 装 Chromium 本体（一次）：`pnpm --filter yuanshu-harness-server exec playwright-core install chromium`。脚本通过 `scripts/lib/playwright.mjs` 用服务端已依赖的 `playwright-core` 驱动它，**不需要另外装 Playwright 的命令行工具**。网络受限时先设 `PLAYWRIGHT_DOWNLOAD_HOST` 指向镜像。`check.sh` 找不到 Chromium 时真机验收阶段直接失败并打印这条装法。
2. 构建并同步产物（见 `SKILL.md` 收尾第 4 步），然后 `node scripts/verify-<名>.mjs [--shots 目录]`。
3. `check.sh` 把验收脚本按领域分成六个阶段（脚本清单在它的 `verify_scripts` 里，`scripts/check.sh --list` 可列出），可以只跑一个阶段，如 `scripts/check.sh browser`。浏览器那一组（`verify-browser*.mjs`、`verify-forward.mjs`、`verify-mobile-browser.mjs`）里 agent 用的 Chromium 取环境变量 `YUANSHU_BROWSER`，没设就用 playwright 装的那个。多数脚本各起一个真 Server，同一阶段内只能一个接一个跑；阶段之间在 CI 里并行。
4. 环境里设了 `http_proxy` 时：脚本起的 Server 要 `NO_PROXY=127.0.0.1,localhost`（Server 依赖的 SDK 装了按环境变量走代理的全局分发器，本机的假端点会被送去代理）；Chromium 访问非回环的主机名要 `--no-proxy-server`。

## 按改动选脚本

| 改了什么 | 跑什么 |
|---|---|
| 设计令牌、全站布局 | `visual`、`shell` |
| 设置页框架或某一页 | `settings` 与对应页（`providers`、`variables`、`studio`、`remote`、`tools`、`defaults`、`review-prompt`），框架改动全跑 |
| 工作区外壳、窗格、目录、标签状态 | `shell`、`workspace`、`directories`、`state`、`tab-zoom` |
| 对话区 | `chat`、`chat-scroll`、`chat-copy`、`jobs`、`goal`、`input`、`md` |
| 画布与版本历史 | `canvas`、`versions` |
| 终端、预览、插件 | `terminal`、`html-preview`、`plugins` |
| agent 浏览器与服务转发 | `browser*`、`forward` |
| 手机端、设备令牌、推送 | `mobile`、`mobile-browser`、`mobile-layout`、`devices`、`mobile-push`、`foreground`（写法见 `ys-mobile`） |
| 真实模型的端到端 | `e2e-real-model`、`e2e-ui`（要 `tmp/model` 里的真实模型端点，不进 `check.sh`） |

## 写新脚本

照最接近的现有脚本抄骨架：起 Server（临时数据目录、`HOME` 指到临时目录）→ 配假模型与供应商 → 起 Chromium → 逐项 `check(名称, 条件, 详情)` → 清理并以退出码报告。几条通用规则：

- **给 Server 的 `HOME` 指向临时目录**：不然供应商注册失败时会悄悄用上真实 `~/.pi` 里的默认模型，现象是「假模型没被调用、回复来自别处」。
- **探针里的 `POST` 没有 body 时要传 `{}`**：带 `content-type: application/json` 而没有 body，Fastify 回 400 `FST_ERR_CTP_EMPTY_JSON_BODY`（前端 `request()` 无 body 时不带该头，所以界面没事）。
- **假模型**：剧本是数组，每个元素是一轮回答；`requests` 里带着每次请求体（`body.messages`、`body.tools`），可以断言系统消息、尾部通知、工具声明。建会话要用 `reasoning: true, levels: ["off", "low", "high"]` 的供应商载荷（`levels: ["off"]` 会被 400 `invalid_models`，没有默认模型时消息发不出去，模型一个请求都收不到）。`aux` 选项让不带工具的辅助调用回自定义内容，消息内容是分段数组，取文字要拼 `text` 字段；**设辅助模型要用 `POST /providers` 返回的供应商 id，不是 slug**。
- **让 agent `browser_open server:端口` 之前，剧本里要先有一步 `bash` 打印这个端口**（`echo "ready on http://localhost:PORT/"`），否则会卡在「允许 agent 访问这个服务？」的审批卡片上。
- **默认「规则」档下 bash 要审批**：脚本里先 `PUT /defaults {permissionTier:"full"}`，或在界面里处理审批卡片。
- **从工具结果里取元素编号要认两种写法**：页面内容走机械层时是 `button "名" [ref=e12]`，走意图路径展开后是 `e12 button "名"`；只认一种，换了路径整条剧本就落空。
- **需要令牌的场景**（Cookie 闸门、设备令牌）起 Server 时要配令牌；用 `addInitScript` 把令牌放进 `sessionStorage`（键 `yuanshu.token`）让界面登录并落会话 Cookie。
- **iframe 里的东西**要经 `elementHandle().contentFrame()` 取 frame 再 `evaluate`；iframe 盒子的像素比对用元素截图，在两种状态下 `Buffer.equals`。
- **后台任务相关**：对话窗格较窄时右栏收成竖排标签，要先 hover `[data-rail="job"]`；任务标签与对话标签同窗格，看对话流里的字要先点回对话标签。
- **弹窗 / 浮层的 Esc 监听与「打开时清空输入」都在渲染后的 effect 里**：元素一出现就按 Esc、或马上打字，会落空，或把新字接在旧内容后面；先等一小会，或等输入框清空再操作。
- **画面里的键盘输入**要落在可编辑元素上（浏览器标签用一个看不见的 `textarea`）；验收用 CDP 的 `Input.imeSetComposition` + `Input.insertText` 模拟组词与上屏。
- **进程内脚本**（`verify-browser.mjs`、`verify-browser-tools.mjs` 这类不起 Server 的）手工装配 `BrowserService` 与 `browserTools`：`BrowserToolsDeps` 加了新字段要同步补进这些脚本。
- **镜像相关**（`verify-browser-mirror.mjs`）：故意不给浏览器、镜像指向没人监听的端口，靠引擎的下载失败原因核对「下载源」；**别触发到官方源的下载**（连得上就是下 200MB），清空镜像后不再 `ensure`。
- **接线类缺陷**（把依赖传下去、`listen` 之后才知道的值）单测与突变都测不出，只有这类真 Server 脚本测得出：委派他人实施服务端改动后，验收时要问「哪一步是接线、什么测它」。
- 新页面照 `verify-variables` / `verify-studio` / `verify-remote` 加一份，并归进 `scripts/check.sh` 的某个阶段（`verify_scripts` 里按领域选一个；漏接自检会失败）。
