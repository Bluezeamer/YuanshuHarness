# Review: 契约测试（第一批）

Reviewer: 每轮由新开的空上下文评审者执行（见 references/review.md）；人在 MR 上做最终评审

> 每一轮评审追加一节。评审记录写在这里，不写进 spec。

## 实现者记录：契约结论（SDK `@earendil-works/pi-coding-agent` 1.3.0）

日后升级 SDK 时，对照本表判断"假设是否还成立"。用例都在 `packages/server/test/contract/`，对着本地 stub provider 运行。

| 需求 | 实测结论 | 与 ADR 的关系 |
|---|---|---|
| R1 | 精确版本 1.3.0，锁文件一致。SDK 传递依赖带安装脚本（`@google/genai`、`protobufjs`），pnpm 12 要求显式声明，已在 `pnpm-workspace.yaml` 用 `allowBuilds` 设为不执行。 | 一致 |
| R2 | `session.compact()` 能产出摘要；压缩后经 `appendSystemPromptOverride` + `session.reload()` 追加的内容，在随后请求里只出现一次，摘要同在请求中。标志为假时位于开头系统提示词的最末（`<cwd>` 之后的 `<addendum>` 段）；标志为真时是紧挨最新用户消息的中途 system 消息。 | 一致（见 R3 对载体的限定） |
| R3 系统消息 | 默认（标志未设或为假）：追加的内容**改写开头的系统提示词**，前缀缓存失效，无中途 system 消息。`supportsMidConvoSystemMessages=true`：开头不变，追加内容以中途 system 消息出现在最新用户消息之前。`before_agent_start` 返回 `systemPrompt`：无论标志如何都整体替换开头。 | 机制存在，但见下方"需要人看的发现" |
| R3 工具 | openai-completions 用的标志名是 `supportsMidConvoToolAdditions`，`...ToolChanges` 属于 anthropic-messages。标志为假：工具集变化体现在顶层 `tools`。标志为真：顶层 `tools` 不变，新增工具走**带 `tools` 字段的非标准中途 system 消息**；移除工具无论标志如何都直接改写顶层 `tools`。 | ADR-0009 与 ROADMAP 写的是 `...ToolChanges`，对 openai-completions 不准确 |
| R4 | `SessionManager.open(file, sessionDir)` + `createAgentSession({sessionManager})` 重建后 `messages` 与原会话相等，继续对话时历史随请求发出。文档明确：直接赋值 `session.agent.state.messages` 不会替换持久化上下文。 | 一致 |
| R5 | 默认读取 `cwd` 下的 `AGENTS.md`，请求里出现一次。接管做法：`noContextFiles: true` + `appendSystemPrompt` 自己注入，出现一次；不关自读又注入，出现两次。显式 `agentDir` 时不读取 HOME 下的 AGENTS.md。 | 一致 |
| R6 | 扩展里的 `ctx.ui.confirm/select/input` 原样委托给 `bindExtensions({uiContext})` 提供的实现，`timeout`、`signal` 选项原样透传，返回值回到扩展。SDK 自身**不强制** `timeout`（uiContext 不返回时扩展一直等）。先答先赢与超时由 Server 自己实现，留给第 3 条。 | 一致 |
| R7 | `ModelRuntime.create({authPath, modelsPath})` 只读显式路径。key 三种来源都不落明文：`setRuntimeApiKey`、`$ENV` 引用、`!command`（可接密码库命令行）。 | 一致 |
| R8 | 扫描：`<agentDir>/skills`、`<cwd>/.pi/skills`、`<cwd>/.agents/skills`、`~/.agents/skills`；另可 `additionalSkillPaths` 追加、`noSkills` 关闭自动扫描。直接祖先目录的 `.agents/skills` 会被发现；未验证：逐级上溯与在仓库根停止的边界。SDK 没有公开的"列出扫描目录"接口，目录集合只能由正负 fixture 证明。 | 一致 |
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

## 第 2 轮（2026-10-17）— 范围：7446c13..0ac6d09 — 执行：codex exec（workspace-write，空上下文，纸面核对）

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 重要 | `docs/intent/active/261017-sdk-contract-tests/spec.md:18`、`docs/intent/active/261017-sdk-contract-tests/intent.md:20`、`docs/ROADMAP.md:10`、`docs/genesis/adr/0009-prompt-assembly-injection.md:59-60` | R3 在缺少 anthropic-messages 证据被指出后，把第一批改成只覆盖 openai-completions；但已接受的 intent、ROADMAP 与 ADR 仍明确要求验证 `supportsMidConvoToolChanges`。另一套 stub 的工作量不能自行改变上游目标，这次收窄会让现有实现通过自己改写后的标准。应补协议 stub，或按变更流程明确批准延期并同步上游。 | 待人裁决：这是对已接受 intent 范围的收窄，不由实现者自批。选项：(a) 补 anthropic-messages 的 stub 与用例，(b) 批准延期到接入该协议时，并同步 ROADMAP 第 2 条与 ADR-0009 的措辞。实现者倾向 (b)，理由是 Server 近期只接 OpenAI 兼容端点；决定记入 intent 的 Decisions needed。 |
| 重要 | `packages/server/test/contract/mid-convo.test.ts:108-125`、`docs/intent/active/261017-sdk-contract-tests/review.md:16` | 新增的“标志为真时移除工具”用例没有任何 `expect`，只打印请求体；工具仍留在顶层、产生中途 system 消息乃至行为任意变化都会通过。因而“移除工具无论标志如何都直接改写顶层 tools”的契约结论没有测试证据，上轮 R3 的工具移除项并未真正修复。 | 已修：上一轮替换没生效（biome 重排了该行，我只看了测试通过）。现在断言顶层 tools 为 `["t1"]` 且无带 tools 的中途 system 消息；变异（期望改为 `["t1","t2"]`）实测变红。 |
| 重要 | `docs/intent/active/261017-sdk-contract-tests/spec.md:21`、`packages/server/test/contract/ui-dispatch.test.ts:67-82,99-113` | 将先答先赢和默认超时留给第 3 条符合本 intent 不实现 Server 业务代码的边界；但新增证据仍不足。`signal` 只断言是 `AbortSignal`，未断言与传入对象相同；“不强制 timeout”在确认 `uiContext` 已被调用前就开始固定 400ms 竞速，也不检查 `calls`，未执行到对话框时同样会通过，且遗留未释放的 prompt/session。该用例至多想证明 SDK 不在自定义 `uiContext` 外再包一层 30ms 超时，不能据此概括“SDK 自身”所有 UI 模式。 | 已修：断言 `signal` 与传入对象同一；竞速前先 `waitFor` 确认 uiContext 已被调用；结束时 dispose。关于"SDK 自身"的概括：用例名与结论已限定为"对自定义 uiContext 不叠加超时"。变异（等待调用数改为 2）实测变红。 |
| 重要 | `packages/server/test/contract/skills-dirs.test.ts:36-55`、`docs/intent/active/261017-sdk-contract-tests/review.md:21` | R8 仍未列出实际扫描目录集合。精确比较的是四个 fixture 的 skill 名称，不是目录；新增用例只用 `toContain` 证明一个直接祖先可发现，没有锁定逐级上溯范围及仓库根停止边界。实现者结论也仍明确写着该行为“未验证”，所以不能把上轮项记为已修。 | 部分接受：SDK 没有"列出扫描目录"的公开接口，只能用正负 fixture 证明；spec R8 改写为"以 fixture 确定扫描目录"，仓库根停止边界仍未验证，结论表已如实写明。 |
| 建议 | `packages/server/test/contract/skills-dirs.test.ts:36-48`、`packages/server/test/contract/isolate.ts:7-10` | 精确集合断言依赖文件级共享的 `fakeHome` 事先为空，且本用例写入的 `in-home-agents` 不清理；今后若在它之前增加另一个 home skill 用例，R8 会因无关残留失败。应让该用例拥有可重置的 HOME/目录状态，避免测试顺序成为隐含前提。 | 已修：用例结束清理 `fakeHome/.agents`，不再依赖顺序。 |
| 建议 | `packages/server/test/contract/compaction.test.ts:44-50` | 上轮“位于 system 消息且在其末尾”只修了前半句：现有断言检查角色与出现次数，没有检查 system 内容以标记结尾。把标记放在 system 内容中间的变异仍会通过，R2 的“追加到系统提示词末尾”尚未被证明。 | 已修，并发现新事实：压缩后重载的路径里，追加内容位于整个系统提示词的最末（`<cwd>` 之后的 `<addendum>` 段），未压缩时在 `<cwd>` 之前；标志为真时则是紧挨最新用户消息的中途 system 消息。两种都已断言；变异（翻转标志）实测变红。 |
| 重要 | `docs/intent/active/261017-sdk-contract-tests/spec.md:24,38`、`packages/server/test/contract/isolation.test.ts:13-30`、`packages/server/test/live/smoke.ts:72-79` | R9 用临时 HOME/显式路径替代真实 `~/.pi` mtime 检查是合理收窄；但 Requirements 和 intent 中“端点与密钥不得出现在测试输出”没有收窄，Proof 却删除了输出检查。现有静态扫描既不捕获输出，也只识别少数 IPv4/`sk-` 形式；live 冒烟还会让 `session.prompt` 的 SDK 异常原样冒泡。用“stub 地址不敏感”不能证明真实端点冒烟的输出约束，所以上轮该项只修复了目录隔离部分。 | 部分接受：live 冒烟的异常输出已脱敏（把端点地址替换为 `<endpoint>`、截断 300 字符）。stub 测试没有真实端点信息；静态扫描只能挡常见形态，spec R9 的 Proof 已如实写明范围。 |

本轮阻塞级：0 条。
