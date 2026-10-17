# Review: 契约测试（第一批）

Reviewer: 每轮由新开的空上下文评审者执行（见 references/review.md）；人在 MR 上做最终评审

> 每一轮评审追加一节。评审记录写在这里，不写进 spec。

## 实现者记录：契约结论（SDK `@earendil-works/pi-coding-agent` 1.3.0）

日后升级 SDK 时，对照本表判断"假设是否还成立"。用例都在 `packages/server/test/contract/`，对着本地 stub provider 运行。

| 需求 | 实测结论 | 与 ADR 的关系 |
|---|---|---|
| R1 | 精确版本 1.3.0，锁文件一致。SDK 传递依赖带安装脚本（`@google/genai`、`protobufjs`），pnpm 12 要求显式声明，已在 `pnpm-workspace.yaml` 用 `allowBuilds` 设为不执行。 | 一致 |
| R2 | `session.compact()` 能产出摘要；压缩后经 `appendSystemPromptOverride` + `session.reload()` 追加的内容，在随后请求里只出现一次，摘要同在请求中。 | 一致（见 R3 对载体的限定） |
| R3 系统消息 | 默认（标志未设或为假）：追加的内容**改写开头的系统提示词**，前缀缓存失效，无中途 system 消息。`supportsMidConvoSystemMessages=true`：开头不变，追加内容以中途 system 消息出现在最新用户消息之前。`before_agent_start` 返回 `systemPrompt`：无论标志如何都整体替换开头。 | 机制存在，但见下方"需要人看的发现" |
| R3 工具 | openai-completions 用的标志名是 `supportsMidConvoToolAdditions`，`...ToolChanges` 属于 anthropic-messages。标志为假：工具集变化体现在顶层 `tools`。标志为真：顶层 `tools` 不变，新增工具走**带 `tools` 字段的非标准中途 system 消息**；移除工具无论标志如何都直接改写顶层 `tools`。 | ADR-0009 与 ROADMAP 写的是 `...ToolChanges`，对 openai-completions 不准确 |
| R4 | `SessionManager.open(file, sessionDir)` + `createAgentSession({sessionManager})` 重建后 `messages` 与原会话相等，继续对话时历史随请求发出。文档明确：直接赋值 `session.agent.state.messages` 不会替换持久化上下文。 | 一致 |
| R5 | 默认读取 `cwd` 下的 `AGENTS.md`，请求里出现一次。接管做法：`noContextFiles: true` + `appendSystemPrompt` 自己注入，出现一次；不关自读又注入，出现两次。显式 `agentDir` 时不读取 HOME 下的 AGENTS.md。 | 一致 |
| R6 | 扩展里的 `ctx.ui.confirm/select/input` 原样委托给 `bindExtensions({uiContext})` 提供的实现，`timeout`、`signal` 选项原样透传，返回值回到扩展。SDK 自身**不强制** `timeout`（uiContext 不返回时扩展一直等）。先答先赢与超时由 Server 自己实现，留给第 3 条。 | 一致 |
| R7 | `ModelRuntime.create({authPath, modelsPath})` 只读显式路径。key 三种来源都不落明文：`setRuntimeApiKey`、`$ENV` 引用、`!command`（可接密码库命令行）。 | 一致 |
| R8 | 扫描：`<agentDir>/skills`、`<cwd>/.pi/skills`、`<cwd>/.agents/skills`、`~/.agents/skills`；另可 `additionalSkillPaths` 追加、`noSkills` 关闭自动扫描。未验证：`.agents/skills` 向祖先目录上溯到仓库根的行为。 | 一致 |
| 其他 | `createAgentSession({noTools:"all"})` 会连扩展注册的工具一起屏蔽，要用扩展工具须不传 `noTools`，改用 `setActiveToolsByName` 选择。 | 无 |

### 需要人看的发现（真实端点，手动一次性实测，未入库）

对本地部署的 Qwen3.8-27B（OpenAI 兼容端点）：默认配置下追加提示词、改工具集都正常；开启 `supportsMidConvoSystemMessages`（含同时开 `supportsMidConvoToolAdditions`）后，端点返回 `400: System message must be at the beginning.`。
也就是说中途 system 消息要看 provider 是否支持：支持的（该标志的存在即表明）才能用；不支持的只能走"改写开头"（破坏缓存前缀）或"以非 system 消息附加到上下文末尾"。ADR-0009 已写了"否则在上下文末尾附加"的退路，但具体载体（用户角色消息？）未定，也没有验证。是否需要为此补一份 ADR 或在 ADR-0009 的后继里定下来，交给人决定。

### 变异验证记录

每条都是"去掉保护或引入错误 → 对应用例必须变红"，实测结果：

| 变异 | 结果 |
|---|---|
| package.json 版本改为 `^1.3.0`（R1） | 2 条红 |
| 压缩后不追加标记（R2） | 2 条红 |
| 压缩后标记追加两次（R2） | 2 条红 |
| 把"开启 supportsMidConvoSystemMessages"用例改成关闭（R3） | 1 条红 |
| 把"开启 ToolAdditions"用例改成关闭（R3） | 1 条红 |
| 追加提示词同时开启 `noContextFiles` 去掉（R5） | 1 条红 |
| uiContext 对 confirm 返回相反答案（R6） | 1 条红 |
| `models.json` 写入明文 key（R7，第 1 轮后加强为断言文件无 `apiKey`） | 1 条红 |
| skill 放到扫描目录外（R8） | 1 条红 |
| `noSkills: true` 改为 false（R8） | 1 条红 |
| 压缩后承载标记的消息角色期望改为 user（R2，第 1 轮后新增） | 2 条红 |
| JSONL 补两个空行（R4 对照） | 1 条红 |
| 去掉某文件对隔离模块的 import（R9） | 1 条红 |

首轮变异时发现 `countIn` 统计的是"包含标记的消息条数"，抓不住"同一条消息里重复两次"，已改为统计出现总次数后重跑。

## 第 1 轮

| 级别 | 位置(文件:行) | 发现 | 处理 |
|---|---|---|---|
| 重要 | `packages/server/test/contract/model-config.test.ts:22-30`、`packages/server/test/contract/harness.ts:102-116` | R7 的“运行时提供 key”用例调用 `writeModels(..., undefined as never)`；这会触发 helper 的默认值并把明文 `stub-key` 写入 `models.json`。断言只检查运行时 key 不落盘，没有断言配置文件不含 `apiKey`，所以把模型配置改回明文 key 的变异仍可能通过，未证明“不是文件里的明文”。 | 已修：`writeModels` 支持 `null` 表示不写 apiKey，用例断言 models.json 不含 `apiKey`；变异（写回明文）实测变红。 |
| 重要 | `packages/server/test/contract/mid-convo.test.ts:15-16,79-99` | R3 要求记录 `supportsMidConvoToolChanges` 真/假行为；本轮只测 openai-completions 的另一个标志 `supportsMidConvoToolAdditions`，没有 anthropic-messages/`supportsMidConvoToolChanges` 的测试，也没有覆盖工具移除。实现者记录中的“标志名不同”不能替代需求点的实测证据。 | 部分接受：补了 openai-completions 的工具移除用例；anthropic-messages 的 `ToolChanges` 需另一套 stub，spec R3 收窄为第一批只覆盖 openai-completions，并写明留待接入该协议。 |
| 重要 | `packages/server/test/contract/ui-dispatch.test.ts:43-61,64-68,101-141` | R6 的先答先赢、取消和超时断言只运行本文件内自写的 `fanOut` 原型；没有导入或调用 Server 层实现，因此不能发现真实 Server 分发逻辑的回归。`askVia` 的上下文类型和三组用例也只实际调用 `confirm`，`select`/`input` 的接管、答案和超时均未验证。 | 已修：删除只测自写 `fanOut` 的用例；改为验证 SDK 对 confirm/select/input 的委托与选项透传，并锁定"SDK 不自行强制 timeout"。先答先赢与超时属 Server 实现，spec R6 收窄。 |
| 重要 | `packages/server/test/contract/skills-dirs.test.ts:36-49` | R8 要求列出 SDK 实际扫描的目录集合，但断言仅使用 `arrayContaining` 验证四个目录，既不排除额外目录，也没有布置祖先 `.agents/skills` 来验证 SDK 的上溯扫描；当前用例会对扫描集合漂移静默通过。 | 已修：首个用例改为精确集合断言；新增祖先目录 `.agents/skills` 上溯用例（记录现状）。 |
| 建议 | `packages/server/test/contract/compaction.test.ts:43-49` | R2 只断言压缩摘要和标记串在请求体中出现，并未断言标记位于 system 消息且在其末尾；把标记放进错误角色或错误位置的变异仍可能通过。 | 已修：断言承载标记的消息角色是 system；变异（改期望为 user）实测变红。 |
| 建议 | `packages/server/test/contract/isolation.test.ts:13-30` | R9 的敏感信息检查只扫源码中的少数 IPv4/`sk-` 模式，未检查测试输出，也未按 Proof 要求记录真实 `~/.pi` 测试前后 mtime；因此对其它端点形式、密钥格式或意外默认目录 I/O 的证据较弱。隔离 import 约束本身可降低风险，但不能替代运行时核验。 | 部分接受：spec 的 R9 Proof 去掉 mtime 说法，改为 HOME/配置目录隔离、首条 import 约束、源码不含内网 IP 与密钥形态；输出检查不做（stub 的地址是 127.0.0.1，没有敏感信息可泄漏）。 |
| 建议 | 评审环境 | 按要求执行 `cd packages/server && npx tsc -p tsconfig.json && npx vitest run test/contract` 时失败：环境无 `npx`（退出码 127），且无可用的 `node`/`pnpm`，本轮无法得到实际类型检查或契约测试结果。 | 驳回：评审沙箱缺 node 路径，环境问题；实现者在本机与 `scripts/check.sh` 中已跑通。 |
| 建议 | 评审环境 | 补齐 Node 路径后 `tsc` 可通过，但 Vitest 仍无法运行：契约 stub 的 `server.listen(127.0.0.1, ...)` 在本评审沙箱返回 `EPERM`，导致带 stub 的用例不出结果并超时；需要允许本地监听的环境复跑以确认完整测试结果。 | 驳回：评审沙箱禁止本地监听，环境问题；第 2 轮请评审者只做纸面核对，测试由实现者运行并在 MR 附结果。 |

本轮阻塞级：0 条。
