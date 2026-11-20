# pi 插件兼容

Author: bluezeamer
Status: 现行
Date: 2026-11-09
Verified: 2026-11-19（对着代码核对：`packages/server/src/plugins/`、`store/plugins.ts`、`api/plugins.ts`、`session/factory.ts`、`session/extensions.ts`、`session/delivery.ts`、`env/virtual-pi.ts`、`env/login-env.ts`、`mcp/transport.ts`、`mcp/remote-*.ts`，以及依赖的 pi 1.3.0 源码）

让元枢能装、启停、卸载 pi 生态的包（`pi install` 那一套），包里的扩展在 Web 界面里尽量照常工作。**这是兼容层，尽力而为，不做保证**；目前只保证「与主机无关」的插件（PL3）。术语「目录」「工作区」见 [`workspace.md`](workspace.md)；「插件」指 pi 包里的**扩展**（可执行的 TypeScript 代码）。

## 1. 范围与原则

- **PL1 只做 pi 包里的扩展**：安装、启停、卸载（更新未做，见 §7）。包里的 skill 不登记进技能库，由 pi 自己扫：开着的包里的 skill 照常进提示词（`skills/runtime.ts` 的 `mergeSkills` 只剔除技能库命名空间里的同步产物与同名项），包被关闭或卸载就随之消失；技能库里没有「插件」这个来源（设想见 §7）。提示词模板与主题不接（模板是输入框的快捷输入，将来与 `/` 菜单统一，见 §7）；元枢自有的插件格式先不设计。
- **PL2 扩展代码只在 server 进程里运行**：它是 TS 模块，由 server 的 Node 加载。放到远程主机上运行，等于在每台主机装 Node 和一套 pi、另起一个 harness，不做。
- **PL3 只保证与主机无关的插件**：纯网络、纯状态、纯界面。插件里的文件类操作（直接 `fs`、`child_process`、`node-pty`、`process.cwd()`、`pi.exec`）一律视为 **server 端执行**；工作目录在远程主机时，`ctx.cwd` 是远程路径，插件读不到不算兼容问题，**界面如实写明，不做转译**。依据：抽样 15 个插件，约 9 个与主机无关（pi-tasks 的默认存储、pi-web-access 的本地视频有例外），6 个不行（pi-subagents 及其单仓分支、interactive-shell、plannotator、mcp-adapter、sudo-helper）；`ctx.executeTool(` 在这些插件里没有真实调用，没有「只经 pi 工具管线」的。MCP 不同，它是客户端—服务端结构，可以远程化，见 §6。
- **PL4 目前只做全局**：读 `~/.pi/agent`；项目级 `.pi/` 暂不支持，需求出现再设计。因此必须显式关掉项目信任（§3）。
- **PL5 我们只存开关**：「会话加载哪些包」存我们的库（`meta` 表一条 `enabled_plugins`，默认全关），其余都用 pi 的；插件的权限不在我们控制范围，也不假装能管。**不建插件表。** 元枢自己的东西（预设、权限、工作区、目录登记）仍放我们的数据目录，不写进 `~/.pi`。
- **PL6 行为对齐 pi 原生，不复杂化**：凡 pi 已有的行为（登记、安装位置、开关写法、过滤）直接用它的，不另造。

## 2. 存储

| 内容 | 放哪 | 谁写 |
|---|---|---|
| 包登记（`packages`，只说「装了哪些」） | `~/.pi/agent/settings.json` | pi 的包管理器（`installAndPersist` / `removeAndPersist`） |
| 会话加载哪些包（开关，默认全关） | 我们的库，`meta` 表 `enabled_plugins`（来源数组） | 元枢（设置页「扩展」） |
| npm / git 包体 | `~/.pi/agent/npm`、`~/.pi/agent/git`（pi 默认布局） | 同上；pi TUI 与我们共用一份 |
| 插件运行时写的状态 | 由插件自己决定，多数在 `~/.pi` 下 | 插件 |
| 元枢自己的设置 | 我们的数据目录 | 元枢 |

- **为什么包体不放我们的目录**：pi 的包管理器里，包体位置与登记位置都由同一个 `agentDir` 推出（npm / git 的安装根都从它算，pi 1.3.0）。拆开要自己实现设置存储，且 pi TUI 会看到登记却找不到包体。
- **开关**：开关**整包**，存我们的库，不写 pi 的 `settings.json`。会话创建 / 重载时，工厂（`session/factory.ts`）把设置管理器的 `getGlobalSettings().packages` 过滤成「开着的来源」并一律按字符串写法给 pi（`plugins/enabled.ts` 的 `loadableSources`），所以关着的包连技能、提示词模板都不进（用 `extensions: []` 只关得掉扩展，技能与提示词模板仍加载；那个写法同时会改变 pi TUI 里的行为）。登记里 TUI 写的 `extensions` / `skills` 过滤在我们的会话里不生效。**默认全关**：库里没记录的包（pi TUI 装的、此前装的）不会进任何会话，要在设置页「扩展」手动打开；在设置页新装的包随即打开。卸载同时清掉开关。理由：插件工具可能与元枢自带的功能重叠（如 pi-tasks 的任务工具与 `todo_write`、pi-subagents 与 `spawn_subagent`），打开后模型会同时看到两套，所以是否打开重叠的包由用户决定；单个扩展的开关以后做（§7）。
- **与 pi TUI 的关系**：包体与登记仍共用（TUI 装的包在设置页能看到）；加载与否各管各，互不影响。
- **pi 设置项**（压缩阈值等）存元枢自己的位置（`<ysHome>/settings.json`）、建会话时注入，不写 `~/.pi`。插件登记写 `~/.pi` 是因为 pi 的包管理器只认那里，没得选，不是通例。

## 3. 作用逻辑

**安装**（`plugins/runtime.ts`）：先用 `resolveExtensionSources(..., {temporary: true})` 装到临时目录当预览，**默认不跑安装脚本**；预览读出来源、包里写的版本、扩展数与 skill 数、有没有安装脚本（`preinstall` / `install` / `postinstall` / `prepare`），用户在确认框里确认，再正式 `installAndPersist`（user 范围）；包带脚本时勾选「允许」才跑。不跑脚本的做法是用 `Object.defineProperty` 覆盖设置管理器的 `getNpmCommand`（`["npm", "--ignore-scripts"]`；只在一次 install 期间且用户允许时去掉），**不把参数写进 `settings.json`**，免得污染 TUI。所有包操作串行（install 会临时切换 npm 参数）。本地目录来源不跑脚本也不删目录：pi 的 `remove` 对 local 只去登记。不做自动更新（手动更新未做，§7）。不分管理员与普通用户：能登录 WebUI 的人本来就能让 agent 跑 bash。界面如实写明：插件拥有 server 进程的全部权限，元枢的权限层只管它注册的工具被调用时的审批，管不到插件代码内部。

**生效时机**：加载器只在**会话创建或 `/reload`** 时读 `settings.json`；已有会话不变，运行中不热切换（设置页提示「新会话或重载后生效」；「N 个会话仍在用旧版本」的提示未做，§7）。

**信任**：必须 `projectTrusted: false`。pi 的资源加载器自己建设置管理器时信任默认是开的，所以 `session/factory.ts` 先建好设置管理器（`projectTrusted: false`），同时传给加载器与会话；`PluginRuntime` 自己那份也是 `projectTrusted: false`。这会让 pi 不再自动发现项目里的 `.pi/skills` 与上级目录的 `.agents/skills`；技能库分发的 skill 不受影响（`mergeSkills` 是显式注入，技能库的环境来源自己扫那两个根）。

**插件的贡献怎么进来**

| 贡献 | 处理 |
|---|---|
| 注册的工具 | 进 `tools` 槽（[`prompt-delivery.md`](prompt-delivery.md) §3.3）。**不进能力清单**：有无只由插件开关决定，会话里不能单独勾掉，开关只对新会话或重建后的会话生效。理由：样本里 `plannotator`、`pi-subagents`、`pi-web-access` 会自己调 `setActiveTools` 开关工具，我们没法预测，统一管理会打架。**我们每次运行前只设定自己管的部分**（内置、MCP），不覆盖插件自己设的启用状态；模式的 `tool_call` 钩子按名字拦，所以「限定为」的模式会把不在集合里的插件工具一并拦下，想放行要在模式里写它的名字。**实现**：pi 的工具白名单创建时定死、名字对不上的在注册表构建时就被过滤，而插件工具名不可预知，所以白名单里加一个通配 `*`（`session/delivery.ts` 的 `ALLOWLIST_ALL`），再用 `excludeTools` 把 pi 自带但不归我们的四个名字（`powershell` 与三个 `*_mcp_resource*` 工具）排除，保持工具集与改前逐项相同；`session/plugin-tools.test.ts` 有一条守卫测试，pi 升级新增内置工具时会变红。插件工具靠 `sourceInfo.origin === "package"` 认出（`plugins/tools.ts`），并入基线与 `registered()`；调用走现有审批（未知工具照常审批） |
| 工具重名 | pi 按名字去重、先注册的赢、后来的**静默丢弃**（pi 1.3.0 的 `getAllRegisteredTools`）。目前没有前缀逻辑，重名时后到的插件工具丢失；设计好的前缀方案未实现，见 §7 |
| 包里的 skill | 由 pi 自己扫，不进技能库（PL1）；包关闭或卸载时随之消失 |
| `before_agent_start` 返回的 message | 保留，作为尾注跟历史走 |
| 改系统提示词 | **目前不支持**，界面写明「注册的工具可用，对系统提示词的修改会被接管覆盖」。设想见 §7 |
| `ctx.ui.*` | 走 §4 的通道，与 `ask_user` 共用 |
| `tool_call` 钩子 | 照常运行，但能改调用参数；**我们的权限钩子必须排在所有插件之后**，审批的才是最终参数。pi 对多个钩子是否按加载顺序执行、我们的钩子实际排在哪，要核对（§7） |

## 4. 界面

界面能力分四层：L1 对话框与单向通知；L2 工具结果与自定义消息的通用卡片；L3 终端组件的虚拟面板；L4 自托管页面。

- **目前做 L1 与 L2 的工具结果部分**。**L1**：`select`、`confirm`、`input`、`editor`、`notify`、`setStatus`、`setWidget`（字符串行）、`setTitle`、`set_editor_text`；**L2**：工具结果照常显示，自定义类型的消息用通用卡片显示（卡片未做，§7）。`ctx.ui.custom()`（L3 终端组件）先返回空操作，生态里多数插件自带降级路径；L3 虚拟面板与 L4 自托管页面后移。针对某个插件的原生面板（如把 pi-tasks 的任务状态画成原生面板）按插件逐个加，以后做。
- **不做两套**：L1 的对话框、通知、状态条、输入框预填，直接复用 WebUI 自己要用的那些组件（组件库里的 ConfirmDialog、Select、Toast 等）；做法：没有另开 `extension_ui_request` / `extension_ui_response` 两种 WS 消息，而是**复用会话现有的弹窗表**：对话类（`select` / `confirm` / `input` / `editor`）发 `prompt.requested`（`source: "question"`），前端经 WS 的 `answer_prompt` 答复，与 `ask_user`、审批同一条，所以外观自然一致；单向类（`notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`）发 `extension.ui` 事件（`method` 区分，**不进会话快照、不重放**，只是瞬时展示）。服务端 `plugins/ui-context.ts` 的 `makeExtensionUiContext({ask, publish})` 是 Web 版 `ExtensionUIContext`，`session/pool.ts` 的 `uiFor(id)` 按会话 id 惰性取条目（工厂执行时条目还不存在），经 `bindExtensions({ mode: "rpc", uiContext })` 注入；**子会话（无人值守）不给**，`hasUI()` 为假。`select` 的选项 id 是下标，`editor` 先退化成单行输入。弹窗模型是「选项 + 可选输入框」（见 `chat-tab.md` §6）：`select` / `confirm` 没有输入框（pi 的返回值类型固定，自由文字放不进去），`input` / `editor` 是文字输入（`input: "text"`，不收附件）。
- **`mode: "rpc"` 的一个副作用**：pi 自己的 MCP 扩展在服务起不来时会 `ctx.ui.notify("MCP servers need attention … Run /mcp to fix.")`，`print` 模式下它是空操作，现在会变成一条 `extension.ui` 通知。保留它：`/mcp` 恰好也是我们的弹窗入口。
- **前端目前只接 `notify`**（弹右下角 toast，`features/chat/model/extensionUi.ts`，在 `sessionStore.handleFrame` 里拦下，不进对话流；超过 240 字截断）。`setStatus` / `setWidget` / `setTitle` / `set_editor_text` 没有现成位置，**先丢弃**，要和聊天页脚、右侧状态一起设计。
- 设置页「pi 扩展」：放在「工具与能力」页的第 4 个页签「扩展」（工具 / 技能 / MCP / 扩展），左列表 + 右详情，范本是 MCP 页签（`features/settings/tools/plugins/`）。行是来源原文（pi 的登记没有 id）：名字去协议与版本、副标题「npm · v1.2.3」、状态点（已启用 / 已停用 / 未装上 / 操作中）。启用 / 停用与卸载是立即动作（没有草稿与保存条），弹提示「新会话或重载后生效」；安装是两步弹窗（预览 → 安装，带脚本的包要勾选才允许脚本）。
- **标签类型注册表**：插件的 iframe 与虚拟面板、灵感画布、实时浏览器都要新标签类型，所以 `TabType` 是注册表而不是写死的联合（见 [`layout.md`](layout.md) §3，事实在 `model/tabKinds.ts` 的 `TAB_KINDS`）。

## 5. 远程主机上的虚拟 `~/.pi`

凡通过 SSH 连接的主机，都给文件原语一个虚拟 `~/.pi`，让第三方 CLI 与插件在远程目录下读写 `~/.pi` 时行为正常，**只做 A**：
- 在 `ExecEnv`（`env/types.ts`）外包一层：落在该主机家目录 `.pi` 下的路径，文件原语（`stat`、`readFile`、`writeFile`、`mkdirp`、`rename`、`remove`、`readdir` 等）重定向到我们数据目录下按主机区分的目录。
- `exec` **不重定向**：远程 bash 里的 `cat ~/.pi/x` 看到的仍是远程真实目录。
- **不往用户的远程机器写任何文件**（B 方案：在远程真的建 `~/.pi` 放配置，需要用户明确同意，不做）。
- 先例：`VirtualEnv` 已经重写了 `homedir()`（`env/virtual.ts`）。
- 注意：插件的文件操作按 PL3 都算 server 端，这层映射服务的是经路由的内置工具在远程主机上读 `~/.pi`，以及 MCP 远程化与第三方 CLI 的一致行为。
- **实现**：`env/virtual-pi.ts` 的 `VirtualPiEnv` 包在 `SshEnv` 外面，只在 `EnvHub.get(id)` 这条路径上包（`getSsh` 保持原样，`SshEnv` 独有的方法还有调用方）；镜像根 `<数据目录>/virtual-pi/<envId>`；远端家目录建连后才知道，所以惰性解析并缓存（取不到不缓存）；写入前自动建镜像里的父目录。为了不让包装层把远程终端掉回本机 pty，`ExecEnv` 有可选的 `openShell`，`terminal/manager.ts` 按它是否存在分流，不用 `instanceof SshEnv`；`openStdio`、`loginEnv` 等可选能力同样跟着内层走。
- **后果**：技能扫描读的 `<home>/.pi/agent/skills`（`skills/env.ts` 的 `user-pi` 根）经包装层落到镜像里，所以**远程主机上手放在 `~/.pi/agent/skills` 的技能不会被扫到**；技能同步写的 `~/.agents/skills` 不在 `.pi` 下，不受影响。

## 6. MCP 与远程主机

- **skill 在 SSH 主机上已经全面支持**：同步到目标环境，命令经路由的 bash 在远程执行（`skills/sync.ts`、`skills/env.ts`）。
- **MCP 已远端化**：保留 pi 的 MCP 扩展，只换传输层。`session/extensions.ts` 给 `createMcpExtension` 传 `createTransport: mcpTransportFactory(home, status)`（`mcp/transport.ts`，`status` 是连接状态簿，见 [`mcp.md`](mcp.md) §12）：http 型照旧由 Server 直连，与主机无关；stdio 型按**会话第一个目录（逻辑 local）所在的主机**分流——本机用 pi 的 `StdioTransport`，SSH 主机用 `RemoteStdioTransport`（`mcp/remote-transport.ts`）。逻辑 local 在会话创建时定下，`switch_directory` 不迁移，恢复会话时按 `localWs ?? ws` 取同一个目录。工厂忽略 pi 传进来的 cwd（恢复时它是「当前目录」，可能在另一台主机）；**环境每次建连时现取**（`McpHome.env` 是函数）——主机重新激活会换新的 `SshEnv` 对象，拿着旧的会绕开用户的「断开」，`mcp/remote-session.test.ts` 专测这一点。
- **远端怎么起进程**（`mcp/remote-launch.ts`）：经 SFTP 写一个 0600 的 `/tmp/yuanshu-mcp-<随机>.sh`，脚本第一行 `rm -f "$0"` 自删，再 `export` 变量、`cd`、`exec` 服务，所以密钥不进命令行、不落盘留存；一行命令 `exec "$SHELL" -lc 'exec sh <脚本>'` 执行；PATH 等由下面的**登录环境快照**写进脚本的 `export`（快照取不到时，这一行的登录 shell 兜底）。`$$` 同时是进程组号，打到 stderr 的 `YUANSHU_PGID=` 一行被传输层取走；关闭三段：关 stdin → 对整组 `kill -TERM -- -<pgid>` 加通道 `signal` → `KILL`，**只在通道还开着时才发整组 kill**（进程自己退了，组号可能被别的进程复用）。`SshConnection.openChannel`（`ssh/connection.ts`）是长连接通道原语，stdout 与 stderr 分开，处理函数挂上之前到的输出先攒着。
- **对 OpenSSH 的实测结论**：①sshd 的 `AcceptEnv` 默认只放行 `LANG LC_*` 等，ssh 的 env 请求被拒，所以密钥只能走临时脚本；②非 pty 的 exec 通道，关通道**不会**杀不读 stdin 的远端进程，但读 stdin 的进程在 EOF 或整条 SSH 连接断开后自己退出，突然断连后连 `npx` 起的整棵进程树都会退出，没有孤儿，所以没做 Server 重启后的远端清扫；③每条 SSH 连接最多 10 条会话通道（`MaxSessions`），每个运行中的 MCP 服务与每次工具调用各占一条，撞上时报 `Channel open failure: open failed`，传输层已在错误里补上原因提示。
- **登录环境快照**：agent 的命令与 MCP 进程要像用户直接 ssh 登录那样找得到 `~/.local/bin`、nvm 装的 node 等。sshd 的 exec 通道是非登录、非交互 shell，PATH 只有系统目录；典型的三层：exec 没有、`bash -lc` 有 `~/.local/bin`（`.profile`）、交互登录还有 nvm（`.bashrc`，开头有「非交互就返回」）。做法（`env/login-env.ts`、`SshEnv.loginEnv`）：每个环境对象抓一次——先 `"$SHELL" -lic` 取 `env -0`，被 rc 脚本卡死或截断（8 秒超时、stdin 接 /dev/null）就退回 `-lc`——与 exec 默认环境做差，**只注入差异**（PATH、`NVM_*` 等；去掉 `PWD` `OLDPWD` `SHLVL` `_` `TERM` `LS_COLORS` 与 `SSH_*` `XDG_SESSION_*` `BASH_FUNC_*`）。`SshEnv.exec` 每条命令带上（登记的隐私变量覆盖同名项），`RemoteStdioTransport` 写进启动脚本。只在内存里，不落盘、不进审计；别名与函数不带；zsh / fish 没测过；Windows 不抓；要主机的 `env -0`（GNU 与较新的 BSD / macOS 有）。通道层面抓取失败不缓存，下次再试；重载时重抓（用户刚装好依赖，PATH 变了）。喂 stdin 的 exec 路径写完 stdin 不关闭（ssh2 在通道结束写之后不再发 `signal`，关了会让带环境变量的命令超时 / 中止的 TERM 发不出去），命令行按字节数读（`eval "$(head -c N)"`）。
- **语义**：①http 型与环境无关，Server 直连，不为「只有远端可达的地址」做隧道；②stdio 型每个会话每个服务各起一份进程（同一台主机上多个会话各一份，不共享）；③env / headers 的值我们在上游解析完，传输层不再让 pi 二次展开，值里的 `$`、以 `!` 开头的内容原样传给进程（pi 自己会再解释一次：含 `$` 报错、`!` 开头被当 shell 命令执行）。
- **前提与限制**：①**Server 持有 MCP 登记并动态分发**（与 skill 同理）：检测、试装固定与工具缓存在 Server 本机做，工具名单是登记本身的属性、各主机共用；「只存在于远端的服务」不是支持的场景。目标主机跑不跑得起来取决于它有没有依赖（node / npx / uvx / docker 等）：**Server 不管依赖**（MCP 后端可以是任意满足协议的东西）；起不来时界面显示原因（传输层把远端 stderr 带进连接状态），提示用户自行装好，装好后在会话里 `/reload`（见 [`mcp.md`](mcp.md) §12）。②会话里各服务的连接状态以状态簿为准（`mcp.md` §9、§12）。③Windows 主机不支持。
- **pi 内置 `mcp.json` 不会重复加载**：交了 `loadConfig` 就完全替代它的默认实现，SDK 会话也不装 pi 自己的 `builtin:mcp`；但 pi 会把**第三方扩展注册的** MCP 服务并进来（`pi.registerMcpServer`）。

## 7. 未实现与未决

**已定方向、未做**
- **包的更新**：手动，显示「旧版本 → 新版本」，不做自动更新；配套的「N 个会话仍在用旧版本」提示。
- **单个扩展的开关**（现在是整包）。
- **工具重名前缀**：冲突时该插件的全部工具统一加前缀，前缀**只对模型可见**：声明与通知里写前缀名，执行时回落到真实工具，插件内部按自己工具名做的事（`setActiveTools`、`tool_call` 里按名字匹配）不受影响；不改写插件描述里对其他工具名的引用（不增加复杂度）。前缀字符受各家 API 限制（`[a-zA-Z0-9_-]`、≤64），写成 `插件名__工具名`；走占位 `call_tool` 时名字是参数，不受限，天然可映射；直接声明的工具在 pi 查找工具名之前怎么映射，实现前验证。现状是代码里没有任何前缀逻辑。
- **界面渲染**：`setStatus` / `setWidget` / `setTitle` / `set_editor_text`（要与聊天页脚、右侧状态一起设计）、通用 L2 卡片（自定义类型消息）、L3 虚拟面板、L4 自托管 iframe。

**设想（没定）**
- 包里的 skill 登记进技能库（PL1 的原设想）：来源标「插件」，不让 pi 自己扫，包被关闭或卸载时随之置灰 / 移除。
- 支持插件改系统提示词：`before_agent_start` 先于 `context_with_system` 触发（读 pi 1.3.0 代码得出、未实测），改动会以 pi 写的系统条目（补丁或强制替换的开头消息）出现，接管时与基线做差异即可识别，作为一个注入点。
- L4 自托管页面需要在 `/api/v1` 下加代理端点，做的时候与浏览器（[`browser.md`](browser.md)）、端口转发（[`forward.md`](forward.md)）的代理合成一个基础件。
- 提示词模板接入 `/` 菜单（与工作流的 `/名字 参数`、技能的斜杠命令统一）；元枢自有插件格式。

**未决（待核实）**
- 权限钩子与插件 `tool_call` 钩子的先后（这条没动过）；我们自己的工具与插件工具重名时谁先注册。
- `ctx.cwd` 在会话创建时定下（`session/pool.ts` 传 `ws.path`），推断不跟随 `switch_directory`（目录切换），未实测。
- `~/.agents/skills` 的全局自动扫描不受信任开关管，属 skill 一侧，同类问题。
- 插件与我们子代理 / 团队 / 任务的功能重叠（pi-subagents、pi-tasks）：现在靠整包开关（默认全关）隔离，开着时模型会同时看到两套，是否在界面提示，未定。
- 无人值守的会话（定时任务、后台团队成员）里，插件的 `confirm` 等对话框谁应答：子会话不给 UI 通道（`hasUI()` 为假），其余沿用「没人盯着」的统一约定，未定。

**依据**：pi 1.3.0 的包与扩展文档（packages、extensions、security、settings、mcp）与对应 `dist` 源码；对 15 个样本插件的源码抽样（抽查结论：`executeTool` 无真实调用、pi-tasks 默认存 `<cwd>/.pi/tasks`、interactive-shell 的 PTY 用 `cwd`、plannotator 用 `statSync`）。验收：服务端 / 前端单测；`scripts/verify-tools.mjs` 的扩展页签（本地目录当包，核对临时 HOME 的 `settings.json`）；`scripts/verify-plugins.mjs`（真 Server + 本地包 + 假模型 + 浏览器，整条链路到 toast）。
