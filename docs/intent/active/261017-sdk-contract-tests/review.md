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
| R3 工具 | openai-completions 用的标志名是 `supportsMidConvoToolAdditions`，`...ToolChanges` 属于 anthropic-messages。标志为假：工具集变化体现在顶层 `tools`。标志为真：顶层 `tools` 不变，新增工具走**带 `tools` 字段的非标准中途 system 消息**。 | ADR-0009 与 ROADMAP 写的是 `...ToolChanges`，对 openai-completions 不准确 |
| R4 | `SessionManager.open(file, sessionDir)` + `createAgentSession({sessionManager})` 重建后 `messages` 与原会话相等，继续对话时历史随请求发出。文档明确：直接赋值 `session.agent.state.messages` 不会替换持久化上下文。 | 一致 |
| R5 | 默认读取 `cwd` 下的 `AGENTS.md`，请求里出现一次。接管做法：`noContextFiles: true` + `appendSystemPrompt` 自己注入，出现一次；不关自读又注入，出现两次。显式 `agentDir` 时不读取 HOME 下的 AGENTS.md。 | 一致 |
| R6 | 扩展里的 `ctx.ui.confirm/select/input` 原样委托给 `bindExtensions({uiContext})` 提供的实现，`timeout`、`signal` 选项原样透传，返回值回到扩展。先答先赢与超时由 Server 自己实现（用例里的 `fanOut` 是原型）。未验证：SDK 自己是否也强制 `timeout`。 | 一致 |
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
| 去掉先答先赢里对落败方的 `abort`（R6） | 1 条红 |
| `models.json` 写入明文 key（R7） | 1 条红 |
| skill 放到扫描目录外（R8） | 1 条红 |
| `noSkills: true` 改为 false（R8） | 1 条红 |
| JSONL 补两个空行（R4 对照） | 1 条红 |
| 去掉某文件对隔离模块的 import（R9） | 1 条红 |

首轮变异时发现 `countIn` 统计的是"包含标记的消息条数"，抓不住"同一条消息里重复两次"，已改为统计出现总次数后重跑。
