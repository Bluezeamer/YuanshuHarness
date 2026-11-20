---
name: ys-server
description: 元枢 Harness 后端（packages/server：Fastify + better-sqlite3 + 内嵌的 pi SDK）的结构与约定。新增或修改 REST / WebSocket 路由、store 表、session / pool / extensions、env / ssh、MCP、技能、权限、目标（goal），写服务端测试时使用。改 `browser/`（agent 浏览器工具、引擎、代理）、`forward/`（服务转发）、`devices/` 与 `push/`（设备令牌、Web Push）下的代码，或写对应的 `scripts/verify-browser-*.mjs`、`verify-forward.mjs`、`verify-mobile-push.mjs` 验收脚本时也加载。
---

# 元枢后端：结构与约定

## 原型期硬约束

原型期没有历史包袱：不做数据迁移、不做接口兼容、不双轨、不留死代码（硬约束与例外见仓库根 `AGENTS.md` 的「协作原则」）。

## 分层（方向不能倒）

`api/` → `session/` `env/` `skills/` `mcp/` `permission/` … → `store/`。

- `api/` 里没有 SQL，不碰 `better-sqlite3`、`store/db`；`store/` 不 import `api/` 与 `server.ts`。
- `SessionPool` / `EnvHub` / `McpRuntime` 只在 `server.ts` 里构造，别处靠注入。
- 没有 `export default`。
- 以上由 `src/structure.guard.test.ts` 守着。

## 新路由怎么落

一个资源一个 `api/<名>.ts`：校验在 api，业务在 `session/` 等领域目录，表与 SQL 只在 `store/<名>.ts`（`*Store`），测试同目录 `.test.ts`。**公共小件不复制**：

| 要做 | 用 |
|---|---|
| 判断对象、取字符串、取正整数 | `lib/validate.ts`（`isObject` / `str` / `posInt`） |
| 400 / 404 响应 | `api/lib/reply.ts`（`bad` / `notFound`） |
| 业务错误带 HTTP 状态 | 继承 `lib/http-error.ts` 的 `HttpError(code, message, status)`，路由用 `toHttp(reply, err)` 翻译，别自己查状态表 |
| WebSocket 心跳与慢客户端保护 | `api/lib/ws.ts`（`startHeartbeat` / `failIfOverloaded`） |

- **往没有 body 的 POST 带 `content-type: application/json`，Fastify 回 400 `FST_ERR_CTP_EMPTY_JSON_BODY`**：前端 `packages/web/src/api/http.ts` 的 `request()` / `call()` 无 body 时不带该头，所以界面没事；自写的探针 / 验收脚本里这类请求要传 `{}`。

## 写代码时守着的规矩

- **内部约定用英文标识，不拿中文当键 / 取值 / 标记**：对象键、线上枚举值、判别字段、前缀标记都用英文 id，展示名另走映射（`id → name / label`，范例：`env/activation.ts` 的 `ACTIVATION_STEPS`）；中文只出现在界面文案、说明文字、文件名与用户数据里，原样引用、不改名。别靠解析报错文字判类别，在源头带码（范例：`mcp/connection.ts` 的 `isAuthError` → 握手记录的 `authFailed`）；也别把「展示名」同时当排序键或哨兵。`src/names.guard.test.ts` 扫服务端、前端源码与 `prompts/` 的 JSON：对象键、`case`、相等比较、联合类型里出现中文字面量会红（一行里的 `{名: 值}` 说明文字与注释不算）。新写的模型看得见的文字也用英文。
- 每个状态只有一个 owner，不得两处写入；**库归 Server**（技能、MCP 登记、卡片、预设、供应商、密钥都存 Server 的库），web 不拼路径、不读密钥、不直连 SSH。
- 审批与执行分离：审批是独立事件，有超时、有审计、全端广播，先答先赢。
- 能力白名单默认最小：创建会话时带显式的工具白名单，未列出的工具对这个会话**不存在**，不是「关着」；框架工具必须显式并入。
- 隐私变量的值只在执行端出现一次，名字与描述进上下文，值不进。
- 文件与命令一律经 `ExecEnv`（local / ssh / virtual），业务里不直接 `fs` / `child_process` 碰「当前目录」。
- **文件工具的位置只有一个解析器**：`session/address.ts` 的 `createAddressBook().locate(host, path)`（位置是单独的 `host` 参数，`path` 只是路径：缺省 = 当前目录；裸主机名 `dev1` 只接绝对路径；`dev1:train` = 已登记目录，相对路径从它起；虚拟主机 `attachment`（工作区级、只读）与 `collab`（同一棵会话树）只认 `/` 开头的路径；`local` = 工作区主目录所在主机，`server` = Server 本机）。六个文件工具（`env/tools.ts`）、`bash`、`transfer_files`（`from_host` / `to_host`）、`browser_upload`（`host`）、权限层（`permission/extension.ts` 的 `locate` → `judgeTarget`，按目标的**归属目录**判）都经它；新工具要接收文件路径就用同一个 `locate`、同样带 `host` 参数（描述用 `session/host-param.ts` 的 `hostProperty`），别在工具里另写解析。同一台机器上目录名唯一（`directories` 表的部分唯一索引，附件区行除外）。`pool.addressBookOf(sessionId)` 是唯一的地址簿实例化点（扩展、权限、传输、上传、子代理派发、画布都从它取）；目录引用统一用 `book.directory(ref)`，不再各处另写名称 / id 匹配。权限测试用 `permission/testkit.ts` 的 `locateAt`（文件类）/ `dirAt`（bash 的目录解析）造单目录解析，要测真解析再用 `session/address.ts`。
- **用户发给 agent 的内容（文字 + 附件）只有一个解析入口**：`session/user-content.ts` 的 `resolveUserContent`（池里薄封装是 `pool.resolveContent(id, text, paths)`）：校验路径在附件区内、按磁盘识别 mime、图片读字节压缩、追加 `[attach_file]` 标记行；返回 `{ text, images, attachments }`。`send_message / answer_prompt / set_goal / edit_goal / edit_queue` 都经它，新入口（如定时任务的提示词）也要经它，别各写一套校验与读图。标记行格式是跨端契约（`attachments.ts` 的 `injectAttachmentMarkers` / `splitAttachmentMarkers`），要还原文字与附件（排队消息、回退回填）用后者，别自己切行。图片随消息走 `images`；目标是例外：图片只在新建 / 改附件后的第一轮带，之后只带标记行（`GoalDriver` 的待带图）。
- **弹窗（审批、`ask_user`、handoff、插件对话）只有一个模型**：问题 + 可选的选项（快捷回复）+ 可选的输入框（`PromptSpec.input`：缺省没有 / `text` / `rich` 带附件），答复是选项、文字、附件的任意组合（校验只在 `session/prompts.ts` 的 `PromptTable.answer`）。新增弹窗别再造 `kind` 之类的分支：审批一律 `input: "text"`，被拒时把用户的话用 `withUserNote`（`permission/`）或 `approve.ts` 的 `Verdict` / `withNote`（浏览器）追加到给模型的拒绝原因后面；插件的 select / confirm 不给输入框（pi 的返回值类型固定）。用户的话在 `ask_user` 里要区分「选了某项 / 自己写的 / 选项加补充」，别把自由回答当成选项。
- 工作区相关的状态变化（目录、会话归属）走库与推送流，别让前端自己推断。
- **设置里能调的参数**（体积上限、压缩质量这类）放进 `DefaultsStore`，用的地方**每次请求现取**，别在构造时读死；有缓存的话缓存键要带上这些参数，改了才立刻生效、旧缓存也不用清（范例：`canvas/thumb.ts` 的 `settings`）。**输出会被浏览器长期缓存（`immutable`）的，地址里也要带设置的指纹**：缓存键只管服务端的磁盘缓存，浏览器按地址缓存，地址只带 mtime 时改了设置旧结果会一直留着；做法是接口把指纹（`thumbs.rev()`）随载入数据一起给，界面拼进地址。
- **目录打包下载**：`GET /environments/:envId/files/archive`，`lib/zip-stream.ts` 手写流式 zip（不引依赖；deflate-raw + 数据描述符，超 4GB 的文件与超 65535 个条目走 zip64，外部属性带文件类型位与 mode）、`env/archive.ts` 经 `ExecEnv` 原语走目录（`lstat` 不跟随链接）。**客户端断开要停止读盘**：`createZip` 覆盖了 `destroy`，先掐断正在读的源流；正在 `entry.open()`（ssh 慢）时被 destroy 靠 `stopped` 守卫。测试用 `test/support/zip-read.ts` 的最小读取器解包核对，别另写一份。
- **审核模型的提示词分三段**（`permission/review-policy.ts`）：固定头（角色 + 输出格式）、**判别准则**（唯一可改的一段）、固定尾（证据可信度 + 防注入）。全局准则存 `DefaultsStore.reviewCriteria()`，工作区的追加 / 覆盖存 `workspaces.review_mode / review_text`，两者由 `server.ts` 里池的 `reviewCriteria(workspaceId)` 每次审核现取、用 `resolveCriteria` 合成；别把审核相关的文字设置挂到会话上（会话级 `reviewPolicy` 已删）。
- **会花很久的写入（上传大文件）别占着 repo 的串行队列**：拆成「开头占位与建目录（在队列里）→ 字节流式写临时文件（在队列外）→ 结尾按结果落位（在队列里）」，出错就删临时文件；临时文件放在不进 git 的位置，崩溃残留也不会被提交。范例：`canvas/repo.ts` 的 `startAsset` / `finishAsset`，与 `api/canvas.ts` 的 `PUT /asset`。

## 浏览器（`browser/`）

- 浏览器流量只有一个出口（`browser/net/` 的代理，放行判定在工具层的 `browser/agent/access.ts`）；只有 `browser/engine/` 碰 `playwright-core`；页面状态只在 `browser/pages/` 的 `PageRegistry`。
- 新增 agent 浏览器工具要同时改四处：`browser/agent/` 里的注册文件、`BROWSER_TOOL_NAMES`、`session/tool-catalog.ts`、`permission/tool-matrix.ts`；开发 / 调试类的危险工具另归默认关闭的能力单元 `unit:devtools`。
- 设计见 `docs/model/browser.md`、`docs/model/browser-content.md`。**改这块代码前读 `references/browser.md`**（工具文件共用件、内置预设、新增工具的完整清单与站点授权、Playwright 的坑、live 测试与接线类缺陷）。

## 服务转发（`forward/`）

- 经环境通道转 HTTP / WebSocket 的共用件在 `lib/tunnel-http.ts`；出口闸门只认会话 Cookie；转发只由用户动作开启，agent 没有入口。
- 设计见 `docs/model/forward.md`。**改这块代码前读 `references/forward.md`**（含改了接线后要跑的 `scripts/verify-forward.mjs`）。

## pi SDK 与 ssh 的坑

- **同步的 WASM 会堵住整个 Server 的事件循环**：pi 的 `resizeImage`（光子）解码缩放是同步的，一张 4k JPEG 约 0.9 秒，期间所有请求与 WS 都停；放进 `node:worker_threads`（见 `canvas/thumb.ts`，最多 2 个、FIFO、空闲 60 秒终止），别在主线程直接调。
- **`AgentSession.reload()` 只在会话「有绑定」时才重发 `session_start`**：`bindExtensions` 不传任何绑定，重载后 pi 的 MCP 扩展不重启、工具全消失。`session/factory.ts` 传一个空的 `onError` 就是为了它，别删。
- **ssh2 的通道一 `end()` 就不再发 `signal`**：往 stdin 写内容的命令别关写端（命令行按字节数读，`eval "$(head -c N)"`），否则超时与中止的 TERM 丢失，通道要等远端进程自己结束才关。`SshEnv.exec` 带环境变量的路径就是这样。
- **sshd 的 exec 通道是非登录非交互 shell**：PATH 只有系统目录。agent 的命令与 MCP 进程的环境靠 `env/login-env.ts` 的登录环境快照补，别在别处各自 `bash -lc`。
- **覆盖 pi 的 `SettingsManager` 要在会话工厂里按实例 `Object.defineProperty`**（先例：`getImageAutoResize`、`session/agent-settings.ts` 的 `overlayAgentSettings` 压缩与重试）：值在 `<ysHome>/settings.json`，getter 每次现读（按 mtime 缓存），所以运行中的会话改完立即生效，没写的键回落到 pi 自己的配置。SDK 里 `getCompactionSettings` 等是经 `this.getX()` 合成的，覆盖单项 getter 就够，但保留了合成的覆盖让「五个 getter 给同一份答案」有测试守着。测试里 pi 的 agentDir 用 `PI_CODING_AGENT_DIR` 指到临时目录，别读写真实的 `~/.pi` 与 `~/.ys`；跑真浏览器验收时给 Server 的 `HOME` 指到临时目录（`verify-defaults` 会真写 settings.json）。
- **给 pi 的 `tools` 白名单是创建时定死的**：MCP 只能写通配 `mcp__*`，别把当时缓存里的具体工具名写进去，否则之后才登记的 MCP 要么被过滤要么注册了不能激活。桩工厂不传白名单，这类问题要用真实工厂（`createSessionFactory()`）才测得出。
- **给 pi SDK 的工具白名单加通配会把 pi 自带的多余工具一并放进来**：`session/delivery.ts` 的 `allowlist()` 里的 `*` 靠同文件的 `EXCLUDED_TOOLS` 排除（`session/factory.ts` 把它作为 `excludeTools` 传给 pi）；pi 升级新增内置工具时 `session/plugin-tools.test.ts` 的守卫测试会变红，提醒补排除名。
- **MCP 工具名单以 pi 实际注册的为准**（`delivery.observe`），不是 Server 本机的检测缓存；审批档也据此取。direct 暴露下 pi 不写 `mcp_servers` 提示段。
- **Node 的 `http.request` 里 `agent: false` 会忽略 `createConnection`**（实测：自带连接的调用次数是 0，请求退化成直连 `host:port`；没传 host 就连 `localhost:80`，现象是空消息的 `ECONNREFUSED`）。要走自己的连接（如经 SSH 通道）：不传 `agent`，或传一个一次性 `new http.Agent({ keepAlive: false })` 并把它的 `createConnection` 换成自己的（先例：`lib/tunnel-http.ts` 的 `TunnelAgent`）。**测试要用解析不了的 host（如 `x.invalid`）才测得出**：host 恰好能解析到本机时请求会直连目标、看着「成功」，其实根本没走你的通道，预先建好却没人用的连接还会让进程退不出去。

## 目标（`session/goal*.ts`，设计见 `docs/model/goal.md`）

- **目标的操作与续跑只经 `entry.goal`（`GoalDriver`）**：WS 命令、模型的 `get_goal / create_goal / update_goal`、运行钩子都调它；`SessionStateHolder` 的目标方法只管「转移（`goal.ts` 的纯函数）→ 落库 → 广播 `goal.updated`」。**每次目标变更都出一张 notice 卡片**，由驱动统一经 `host.note` 发（或收尾消息自己当卡片），别在调用点各发一份。
- **模型看得见的文字全在 `goal-messages.ts`，一律英文**：纯函数与 `StateError` 的中文信息只给用户；驱动里模型侧的拒绝统一过 `modelFailure`。
- **别用 `??` 给「不限」补缺省**：轮数上限 `null` = 不限，是有效值（`deps.goalMaxRounds?.() ?? 50` 会把它吞成 50）。
- 续跑检查要「每次运行结束 + 每次 send / notify 收尾」都调（后者管 `run.ended` 到来时发送调用还没返回、`busy` 仍为真的窗口），`settled()` 幂等、用 `setImmediate` 推迟一拍；池里的接线（`onRunFailed` 转给目标、`onStop` 先暂停再 abort、`hasPendingWork`）单测测不出，靠 `goal-pool.test.ts` 的多轮用例与 `verify-goal.mjs`。

## 设备与手机入口（`devices/`、`api/devices.ts`）

- 身份只经 `auth.ts` 的 `authOf(req)` 取；管设备的路由（建配对码、列表、撤销）都要先过 `api/devices.ts` 里的 `globalOnly`，设备令牌只能删自己；不要求令牌的路由写 `config: { public: true }`（目前只有 `/devices/pair`）。
- 设计见 `docs/model/mobile.md` §8。**改这块代码前读 `references/push.md`**（「设备与手机入口」一节）。

## 推送（`push/`、`api/push.ts`、`store/push.ts`）

- 触发与策略全在 `push/notifier.ts` 的 `PushNotifier`；发送只经 `push/sender.ts` 的 `createSender`；`/push` 路由只认设备令牌。**别手写请求头 `Content-Length`**（pi SDK 装的 undici 会拒，单测测不出）。
- 设计见 `docs/model/mobile.md` §9；端到端用 `scripts/verify-mobile-push.mjs`。**改这块代码前读 `references/push.md`**（「推送」一节，含起真 Server 验推送时的代理变量）。

## 不要再往大文件里塞

`session/pool.ts` 是服务端最大的文件，已经很大：新逻辑抽成独立文件，池里只留接线。先例是 `session/extensions.ts` 的 `buildExtensions` + `ExtensionHost`（把池内成员收成一个接口传进去）。

## 测试与构建

- **必须在 `packages/server` 下跑**（根目录 `npx vitest` 会把 `node_modules` 里的第三方测试扫进来）：`pnpm --filter yuanshu-harness-server exec vitest run <路径>`；类型 `pnpm --filter yuanshu-harness-server exec tsc --noEmit`。
- 全量里 `connections` / `terminals` / `attachments` 偶发失败是已知的（待修）：单独重跑过就不算回归。
- 测试里用 `git ls-files` 看含中文的路径要加 `-c core.quotepath=off`，否则输出是八进制转义。
- **测试里要建临时目录，一律走 `test/support/tmp-registry.ts` 的 `makeTmpDir`**（测试文件结束时统一删），别直接 `mkdtempSync(tmpdir())`：忘了删的目录会累积、占满 `/tmp` 的 inode，之后 `mkdtemp` 报 `ENOSPC`、全量测试随机失败。`scripts/check.sh` 开头有 inode 守卫（用到 85% 报错）；清存量用 `scripts/clean-test-tmp.sh`（默认只列，`--yes` 才删，只清超过 3 小时没动、没被进程占用的 `yuanshu-*`；靠扫 `/proc`，只在 Linux 上可用）。别把 `TMPDIR` 指到仓库 `tmp/` 下绕开：要起真 Server 的用例会大面积超时，临时目录在仓库里还会让 git 类测试向上找到仓库的 `.git`。
- 需要真实模型凭据的 live 测试（`scripts/e2e-real-model.mjs`、`scripts/contract-live.sh`）没有凭据就跳过；`packages/server/test/live/` 里除 `transfer-ssh` 外的手动冒烟默认被 `vitest.config.ts` 排除，要显式设 `YUANSHU_LIVE=1` 才跑（不然「有 `tmp/model` 的机器」与 CI 跑的就不是同一套测试）。
- 改了提示词拼装后跑 `node scripts/prompt-golden.mjs`（离线，不起服务）。
- 前端与 `verify-*.mjs` 用的是构建产物：改完服务端要 `pnpm --filter yuanshu-harness-server build` 才看得到。
- 仓库里的文件不写凭据、内部地址、个人路径；需要引用证据时写脱敏摘要。
