# MCP 登记

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`packages/server/src/mcp/`、`store/mcp.ts`、`api/mcp.ts`、`session/extensions.ts`、`session/delivery.ts`、`session/pool.ts` 的 MCP 重载与同步、`permission/extension.ts`，以及 `packages/web/src/features/settings/tools/mcp/`）

登记库管「有哪些 MCP 服务、怎么连、怎么暴露给模型、怎么审批」；连接与工具注册交给 pi。本文只写登记本身：MCP 进程跑在哪、远程化见 [`plugin.md`](plugin.md) §6 与 [`workspace.md`](workspace.md) §3，连接状态与重载见本文 §12。路径省略 `packages/server/src/`；`web/` 指 `packages/web/src/`，设置页在 `web/features/settings/tools/mcp/`。

## 1. 登记与入口

- 一条登记 = 连接配置（stdio：`command` / `args` / `env` / `cwd`；http：`url` / `headers`）+ 选项（`enabled`、`exposure`、`toolExposure`、`timeout`、`oauth`）+ 行级状态（审批档、描述、最近握手、工具缓存、试装时解析到的最新版）。表 `mcp_servers`（建表在 `store/baseline.ts`），读写在 `store/mcp.ts`。名称是主键和引用 id，也是工具名前缀 `mcp__<名>__<工具>`。
- 唯一入口是一段 `mcpServers` JSON，一次一条，名称取自键，没有名称与描述输入框。设置页带 stdio / http 两个模板，200ms 防抖调 `POST /api/v1/mcp/validate` 边输入边校验（不落库，规则与保存同一套）；保存走 `POST /api/v1/mcp`（新增）与 `PUT /api/v1/mcp/:name`（编辑），body 都是 `{json}`（`api/mcp.ts`）。
- 保存配置会清掉握手结果、工具缓存与描述（`store/mcp.ts` 的 `update`），所以设置页在新增、改配置、启用成功后立刻自动检测一次（`web/.../mcp/actions.ts` 的 `checkAfter`），免得停在「未检测」。
- 描述不手填：取自握手返回的 `serverInfo.description`，或试装时包仓库的元数据；都没有时显示「来源未提供描述」。

## 2. JSON 校验

`mcp/conf.ts` 逐条给诊断，error 阻止保存，warning 只提示；重名返回 409，其余 400。

- error：顶层须有 `mcpServers` 且恰好一条；名称 `^[A-Za-z0-9_-]{1,32}$`；与已有条目重名（`-` 与 `_` 视为相同、不分大小写，因为名字拼进工具名后 `-` 会变 `_`）；`type` 只认 `stdio` / `http` / `streamable-http`，`sse` 明确拒绝；`command` 与 `url` 恰有一个且与 `type` 一致；`command` 不含空白（参数放 `args`）；`url` 须 `http(s)://`；`headers` 只用于 http，`cwd` / `args` 只用于 stdio；`env` / `headers` 的值须为字符串；`timeout` 为正数秒；`exposure` 与 `toolExposure` 的值须是两个暴露方式之一（`toolExposure` 的键不核对是否真有该工具）；`oauth` 须是对象或布尔。
- warning：http 条目带 `env`（忽略）、手填 `description`（忽略）、未知键（忽略）。
- 通过后再过一遍 `store/mcp.ts` 的 `parseMcpConfig` 的长度上限（`command` ≤1024、`args` ≤100 项等）。
- env / headers 取值：值以 `${secret:<id>}` 结尾就是密码库引用（前缀可带如 `Bearer `，≤64 字符），引用的条目必须存在；库里只存 id，回显写回 `${secret:<id>}`，不出明文。否则是明文，其中 `${VAR}` 取 **Server 进程环境**，没设置就点名报错而不是替换成空串（`mcp/resolve.ts`；检测、试装、会话三条路径共用这一份，`url` 里的 `${VAR}` 也一样展开）。会话里某个服务取值失败（变量没设置、引用的密码库条目已删）只丢掉那一个服务、原因进它的连接状态，不连累别的服务。被登记引用的密码库条目不能删（`server.ts` 里 `SecretStore.addReferrer` 接上了 `McpStore.referencesSecret`）。会话里的传输层（`mcp/transport.ts`）不再让 pi 对这些已解析的值二次展开，值里的 `$`、以 `!` 开头的内容原样交给进程。

## 3. 暴露方式

- **只有两个值（codemode 通道整个关闭）**：`direct` 像内置工具一样声明给模型（默认）；`hidden` 已登记、连接照常建，但工具对模型不可达。pi 的 `codemode` 与 `deferred` 不支持：JSON 里写了会报 `invalid_exposure` 并说明原因（`mcp/conf.ts`），没有装载 codemode 工具，也没有 `tool_search`。工具多的服务要省 token：服务级 `hidden` 加逐工具 `"toolExposure": {"search": "direct"}` 只放行几个。`toolExposure` 按工具覆盖，pi 支持 `*` 通配，我们原样透传。
- **现在生效的路径**：`session/extensions.ts` 用 pi 的 `createMcpExtension` 负责连接、握手与工具注册（`mcp__<server>__<tool>`），**只要池有 MCP 能力就装**（没勾选任何服务也装，之后登记了、重载才接得上）；`mcp/pi-config.ts` 把登记映射成 pi 的 `mcpServers` 条目，`exposure` 一律显式写（pi 的缺省是 codemode）。我们自己的连接（`mcp/connection.ts`，官方 SDK）只用于检测、刷新工具缓存与试装，会话里不经过它。
- **默认值**：`direct`（`mcp/conf.ts` 省略时、库表列默认、`DEFAULT_OPTIONS` 三处一致）；编辑器回显总会写出 `exposure`。
- **工具名单以 pi 实际注册的为准**：会话创建 / 恢复时 `runtime.prepare` 读检测缓存（为空的先在 Server 本机连一次）算出工具名，只在 pi 连上之前顶用；每次运行前与每次工具调用时，`session/delivery.ts` 的 `observe` 取 pi 此刻注册的 `mcp__*` 工具（`mcp/tools.ts` 的 `liveToolDefs`，按服务名前缀归属、`hidden` 的不算）当作可用名单，并据此取审批档。所以 Server 本机跑不起来、目标主机上能跑的服务，重载后照样可用；缓存里有而没连上的不会通知给模型。

## 4. 固定版本（pin）

- 只有 `npx` / `uvx` 启动的 stdio 包可固定（`mcp/pin.ts` 的 `parseSource`，命令取 basename 并去 `.cmd` / `.exe`）：取 `args` 里第一个不以 `-` 开头的项当包规格；带 `-p` / `--package` / `--from` 的不认；http 与其他命令（`node`、`python`、绝对路径二进制）返回 `not_pinnable`。
- 是否已固定直接看 `args`：包规格带 `x.y.z`（可带预发布 / 构建后缀）算固定，无版本、`@latest`、`@1.2` 都算浮动。没有单独的 pinned 字段。**「可更新」**：已固定且包源查到的最新版（`latest_version`）高于固定版本，列表行状态标「可更新」（握手失败仍优先显示不可用；浮动的每次启动取最新，谈不上更新）。「最新版」由三处刷新：试装、`POST /:name/versions`（查候选版本，`McpRuntime.versions` 顺带 `setLatest`）、以及列表头「⋯ → 检查更新」（前端对每个已固定的服务逐个调 `versions`，3 路并发）；**首次进入 MCP 页签读完列表后会自动静默查一次**（同样的逻辑，不弹提示，6 小时内不重查，全部没查到不记时间；时间戳在浏览器 localStorage，`tools/common/autoCheck.ts`），Server 启动时不查。只标记，不自动更新；升级仍是「重新固定 / 选择版本」。
- 试装并固定（`POST /api/v1/mcp/:name/try-pin`，`mcp/runtime.ts` 的 `tryPin`）：① 解析最新版：npm 用 `npm view <pkg> --json`（Server 本机的 npm，沿用其镜像与代理配置，30s），PyPI 走 JSON API（`PYPI_URL` 可改）；② 把包规格换成 `pkg@版本` 作候选，用一次性连接在 **Server 本机** 跑 启动 → 握手 → 列工具（超时取条目 `timeout`，缺省 120s；npx / uvx 首次运行时自己下载）；③ 三步全过才写回 `args`、解析到的最新版、工具缓存、握手结果与描述，并断开旧的共享连接。任一步失败什么都不写，仍是原状态。
- 失败状态码：400 `not_pinnable` / `invalid_version`，503 `network_unavailable`，422 `package_not_found`，502 `resolve_failed` / `run_failed`；`run_failed` 带三步结果。
- 回退与升级：`try-pin` 带 `version` 即装指定版（同样要试装成功），仍记下解析到的最新版，界面据此标「高于已固定」；`POST /:name/versions` 给最近 30 个候选并补上当前版。升级 = 再点「重新固定」或「选择版本」。
- 编辑 JSON 换了包之后，旧的「解析到的最新版」作废（`store/mcp.ts` 的 `samePackage`）；固定的版本写在 `args` 里，编辑器里原样可见。

## 5. 检测

- 三步：启动传输、`initialize` 握手、列工具（分页取全），每步 `{state: ok|error|skipped, ms, error?}`（`mcp/connection.ts`）。失败点名原因：401「令牌无效或已过期」、403、其他 HTTP 状态（401 / 403 / `Unauthorized` 在步骤与握手记录里另带 `auth` / `authFailed` 标记，界面据此判授权问题，不解析报错文字）；stdio 失败附子进程 stderr 末 2000 字符。
- `POST /:name/check` 失败也返回 200，原因在结果里；成功会刷新工具缓存、握手结果与描述。检测前丢掉旧连接，成功后这条连接保留，即 Server 上驻留一个实例，直到该条目被改、禁用、删除或 Server 退出。
- 「检测全部」（`POST /check-all`）只测已启用的服务，逐个串行，返回就绪数 / 总数。检测是真连接，不是占位数据。
- 超时：条目 `timeout`（秒）同时作连接与调用超时；缺省连接 20s、调用 120s。
- 行状态（`model.ts` 的 `statusOf`）：检测或试装中 > 已禁用 > 未检测 > 握手失败（带 `authFailed` 的标「授权过期」，否则「不可用」）> 可更新 > 就绪。
- `oauth` 只登记：我们自己的检测连接不处理授权；`mcp/pi-config.ts` 把对象形的 `oauth` 传给 pi（仅 http）。**读 pi 1.3.0 源码确认**（`dist/extensions/mcp/runtime.js` 的 `usesOAuth`）：pi 对 http 服务默认走 OAuth，除非配置里带 `Authorization` 头（或 `auth`），所以静态 Bearer token 放进 `headers` 现在就能用；需要浏览器授权的远程服务（GitHub、Linear 这类）会在会话里进 `needs-auth`，要用户在浏览器里登录（回调到 Server 本机端口，到不了就粘贴回调地址，凭据存 `~/.pi/agent/mcp-auth.json`），我们没有登录入口，pi 自己的登录命令也被我们的 `/mcp` 弹窗挡住了。设置页写「Server 目前不执行授权流程」。暂无这个场景，先不做（§11）。

## 6. 审批档

- 每个服务一档 `allow` / `ask`，默认 `ask`，对 `mcp__<名>__*` 全部工具统一生效，不分 cwd 内外；`PATCH /api/v1/mcp/:name` 修改；设置页里它是详情里的一个「放行 / 审批」开关，进草稿、点保存才落（skill `ys-ui-design` 的 X06）。**没有「禁止」档**（与内置工具矩阵同理：不想让模型用它就停用这个服务），传 `deny` 返回 400。
- 裁决在 `permission/extension.ts`：`allow` 不弹窗；`ask` 按未知工具走常规裁决：不可记住、不可交审核模型，规则档与自动档交人工，完全允许档在无隐私变量时放行。
- 每次调用读库里当前档（`runtime.approvalOf`），改档对进行中的会话立即生效；「工具名→服务」映射在会话创建 / 恢复时固定。

## 7. 改名、删除与引用

- 改名 = 新增并删除：`PUT` 的 JSON 里键与原名不同即改名（`api/mcp.ts`）。先查引用（`mcp/refs.ts`），有就 409 `mcp_referenced` 并列出位置（编辑器里显示）；没有才建新条目、删旧条目。新条目用 JSON 里的值，**审批档回到默认 `ask`**，解析到的最新版不带过去（`api/mcp.v2.test.ts` 有用例）。
- 引用范围：审批档是服务自己的字段，没有独立规则引用服务名（`mcp/refs.ts` 注释）。实际查两处：提示词预设（agent / 模式）能力集里的 `mcp:<名>`，以及工作区的勾选（`workspace_capabilities`）。**会话自己存的能力选用不查**，改名后那些会话下次启动时该引用被跳过，并记审计「跳过不存在的 MCP server 引用」（`store/capability-refs.ts`）。
- 删除（`DELETE` 与批量卸载）**不查引用**：只顺带清掉工作区勾选（`store/mcp.ts`），预设与会话里的引用悬空，运行时跳过并记审计。卸载确认框只写「断开实例并删除登记」，不列引用。

## 8. 批量

- `POST /api/v1/mcp/batch` `{action, names}`：`action` 为 `pin` / `check` / `enable` / `disable` / `uninstall`，`names` 1–200 个；逐项串行，部分失败不回滚，逐项返回结果并带回最新列表（`api/mcp.ts`）。**界面不提供批量**：左列表 + 右详情，没有复选框与批量条；只在列表头菜单留「检测全部」，走 `POST /check-all`；接口保留。
- 按状态挑对象的规则仍在接口层之上：**服务端不做过滤**，直接调接口对已固定的包 `pin` 会试装最新版。

## 9. 会话怎么用到登记

- 一个会话生效的服务 = **全局**（`global` 为真的）∪ 会话配置 `capabilities` 里的 `mcp:<名>` ∪ 所在工作区的勾选（`mcp/runtime.ts` 的 `resolveMcp`，顺序即此），去掉已禁用的，库里已不存在的跳过并记审计。**全局默认关**：详情页「对所有会话生效」开关改它（`PATCH /api/v1/mcp/:name {global}`，进草稿、点保存才落）；没标全局的，在工作区弹窗「技能与 MCP」里勾给工作区（`GET/PUT /api/v1/workspaces/:id/capabilities`）。全局与工作区是同一套逻辑上的两层，与传输方式无关：stdio 由我们在主机上起进程，http 由别人起好、我们只连。只按主目录（逻辑 local，即会话的第一个目录）装载；stdio 进程起在该目录所在的主机（本机，或经 SSH 在远程主机上），http 型由 Server 直连，见 [`plugin.md`](plugin.md) §6、[`workspace.md`](workspace.md) §3。
- pi 在 `session_start` 读一次配置（含已解出的密码库值与 `${VAR}`）。登记内容**每次现取**（`McpSetup.servers` / `config` 是函数）。**会话开着时登记、勾选或变量变了**：右栏与 `/mcp` 显示「待加载」（pi 没读走过这一项）；下一条消息发出前（会话空闲时）`SessionPool.syncMcp` 比较 `config()` 与 pi 上次读走的指纹（`McpSetup.loaded`，`mcp/pi-config.ts` 的 `configSig`），不同就 `session.reload()` 重连——**不写重建标记，前缀不动**；MCP 扩展排在送达扩展之前，pi 第一次运行会等直连的服务连上，所以新增工具在**同一条消息**里就能被状态比较发现，用尾部通知（走 `call_tool`）告诉模型。指纹没变不重连，不会每条消息都重启进程。手动 `/reload` 仍是完整重建（缓存失效）。`runtime.forget` 只关我们自己的检测连接。
- direct 暴露下 pi 不在系统提示里写 `mcp_servers` 段（那段只列 codemode / deferred 的服务），所以连不上、没注册成的服务模型感知不到，不需要提示；已注册后才断的，调用时的报错里带原因。
- 右栏「已加载能力」与 `/mcp` 弹窗读同一份 `GET /api/v1/sessions/:id/context` 的 `mcp`：会话在内存里就以它**自己的连接状态**为准（`ready` / `connecting` / `pending` / `failed` / `disabled`，加原因、运行位置、全局与否、实际注册的工具数，见 §12），不在内存里就看 Server 最近一次检测。工具数排除 `hidden`。

## 10. 已知限制

- **只有测试调用的代码**：`McpRuntime.call`（`mcp/runtime.ts`）与 `McpConnection.callTool` 只有测试调用（用来验证环境变量展开、重连、禁用等检测连接的行为），生产里调用由 pi 的 MCP 扩展做。`buildToolDefs` / `McpToolDef` 仍在用（pi 连上之前的工具名单），不是死代码。
- **工具名规则不一致**：同一服务里 slug 后撞名的工具（如 `a-b` 与 `a_b`），pi 给两个都加哈希后缀，`mcp/tools.ts` 的 `toolName` 只给后到的加；会话连上之后可用名单以 pi 实际注册的为准（§3），所以只影响 pi 连上之前依据检测缓存算出的名字。只在撞名或超 64 字符时发生。
- **旧结构化接口**：`POST /api/v1/mcp {name, config}`、`PUT {config}`、`POST /:name/refresh`，以及 `web/api/capabilities.ts` 的 `createMcp` / `updateMcp` / `refreshMcp` / `deleteMcp`，没有生产调用方（设置页走 `web/api/mcpLibrary.ts`）；该路径建出的条目 `exposure` 为 `direct`。
- pi 内置 MCP 扩展读 `~/.pi/agent/mcp.json`：不会与我们交给它的登记重复加载（`loadConfig` 完全替代默认实现），但会并进第三方扩展注册的 MCP 服务，见 [`plugin.md`](plugin.md) §6。

## 11. 未实现与未决

- **授权流程（OAuth）**：`oauth` 只登记，我们的检测不执行，会话里需要授权的 http 服务连不上；静态 token 走 `headers` 不受影响。暂无这个场景，不做（§5）；真做时可复用供应商页的订阅登录弹窗（授权链接 + 粘贴授权码）。
- **目标主机缺依赖（node / npx / uvx / docker 等）Server 不管**（MCP 后端可以是任意满足协议的东西）：起不来时界面显示原因（远端 stderr、`ENOENT`、找不到命令），stdio 服务失败时弹窗提示「运行时要在运行位置的主机上自行装好」，装好后点重载。没有依赖探测，也没有一键装机。
- 弹窗里的单服务启用 / 关闭（只对当前会话）：没做，要一张「会话级覆盖」表，同时补上「会话里去掉某个全局项」。
- 「有引用则阻止并列出位置」只做了改名，且只覆盖预设与工作区勾选；删除、卸载与会话自存的能力选用没有。
- 会话里单独去掉某个全局 MCP：没有（没有对应的数据结构）。
- 全局的 stdio 服务每个会话各起一份进程、各占一条 SSH 通道（每连接默认最多 10 条，运行中的命令也占）：全局服务多、会话多时会撞上限。决定：搁置，等真撞上再说（全局服务在 10 个以内时不会撞上）。「让多个服务复用通道」不是小事：一条通道只承载一个远程进程的输入输出，要共用得在远程主机上放转发小程序；便宜的替代是同一主机上同一个全局服务让多个会话共用一个进程（有状态的服务会互相串）。现状是撞上时报错并带原因，加上详情页「运行位置」里一行提示：当前版本对每台远程主机同时最多支持 10 个 MCP 连接（仅 stdio 服务显示）。
- **`toolExposure` 通配**：pi 支持 `*`，我们透传；但 `mcp/runtime.ts` 与 `mcp/context.ts` 里的 `hidden` 判断是精确匹配，通配写的 `hidden` 不会排出可达名单与工具数——对模型实际可见性未核实。

## 12. 连接状态与重载

- **状态簿**（`mcp/session-status.ts`）：每个会话一份，进程内，不落盘。记法**不包装传输对象**（pi 失败时认 `StdioTransport` 类型取它的 stderr）：`mcp/transport.ts` 在建出传输后给它挂监听，并换掉实例上的 `start` 与 `send`——启动或握手前发送失败记 `failed`（带 stderr 尾部、fetch 的 `cause`）；第一个应答是 `result` 记 `ready`、是 `error` 记 `failed`；之后连接关闭记 `failed`。pi 每次（重）连都会重建传输，所以每次建连先记 `connecting`。取值失败（`mcp/pi-config.ts` 的 `failed`）在 `loadConfig` 里直接记进状态簿。同一次连接里先记下的原因不被后来的「连接已关闭」覆盖。
- **重载 = 刷新上下文（原地）**：`POST /api/v1/sessions/:id/reload` 与左轨「刷新上下文」的 `POST /sessions/:id/refresh-context` 是同一件事（`SessionPool.refreshContext`）。空闲才做（运行中、压缩中 409 `session_running`），没加载进内存的先加载；重读两份约定文件（`rebase(id, false)`，只更新条目不单独重载）、清空状态簿、重新同步技能（技能集合指纹变了才真同步，见 [`skills.md`](skills.md) §4）、涉及的每台主机重抓登录环境（见 [`plugin.md`](plugin.md) §6）、再调一次 pi 的 `session.reload()`（带重建标记，前缀换新），各服务在后台重连，结果看 `/context`。历史、配置、模式不动。输入框里 `/reload` 发它并弹提示，`/mcp` 打开弹窗（状态 + 重载按钮），`web/features/chat/tab/McpDialog.tsx`。**重载会重启本会话全部 MCP 进程**（远程的也是）。
- **工具白名单**：创建会话时 `createAgentSession({ tools })` 给 pi 的白名单是**创建时定死的**，所以 MCP 一项只写通配 `mcp__*`（`session/delivery.ts` 的 `allowlist`），不写当时缓存里的具体工具名：写具体名的话，白名单里已有别的 `mcp__` 名时，之后登记的 MCP 工具会被整个过滤（握手成功、状态「就绪」、工具数 0）；一个都没有时工具能注册却**不能被激活**（模型看不到、调不了）。在场与否由登记 ∩ 勾选（`loadConfig`）决定，是否启用由送达层的启用集合决定。桩工厂不传白名单，所以单测要用真实工厂（`session/mcp-allowlist.test.ts`）。
- **pi 的一个坑**（实测）：`AgentSession.reload()` 只在会话「有绑定」（界面上下文 / 命令动作 / 关闭处理 / 错误监听之一）时才重发 `session_start`；一个绑定都不传的话，重载后 MCP 扩展不重启、工具全部消失（压缩后的 `rebase` 也走这条路）。`session/factory.ts` 在 `bindExtensions` 里至少传一个空的 `onError`；有 Web 版 `ExtensionUIContext` 时（[`plugin.md`](plugin.md) §4）绑定自然就有了。
