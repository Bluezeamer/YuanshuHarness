# Spec: 契约测试（第一批）
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> delta：只写本次相对既有约定新增的内容。背景见各 ADR。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0001](../../../genesis/adr/0001-pi-sdk-no-fork.md)、[ADR-0004](../../../genesis/adr/0004-state-storage-recovery.md)、[ADR-0005](../../../genesis/adr/0005-client-protocol.md)、[ADR-0008](../../../genesis/adr/0008-capability-sets.md)、[ADR-0009](../../../genesis/adr/0009-prompt-assembly-injection.md)、[ADR-0015](../../../genesis/adr/0015-model-management.md)
下游: plan.md（按需）、PR

## Requirements
每条 R 对应一个"假设"。测试断言的是**实测到的行为**；行为与 ADR 的期望不符时，测试如实记录，并按 intent 规定停下升档，不得为了变绿改断言。

R1. Server 包必须以精确版本依赖 `@earendil-works/pi-coding-agent`（无 `^`、`~`、范围）；`pnpm-lock.yaml` 与之一致。
R2. 压缩（compaction）完成后，Server 追加到系统提示词末尾的内容必须出现在随后发往模型的请求里，且只出现一次。以 provider 实际收到的请求体为准，不以 SDK 内部状态为准。
R3. 必须记录 `supportsMidConvoSystemMessages` 与工具类标志在配置为真、为假时的实际行为：会话中途追加的系统消息、新增与移除的工具是否出现在下一次请求中。第一批只覆盖 openai-completions（标志名为 `supportsMidConvoToolAdditions`）；anthropic-messages 的 `supportsMidConvoToolChanges` 需要另一套 stub，留待接入该协议时再验证（2026-10-17，bluezeamer 批准延期）。ADR-0009 的实际路径是把变化以用户消息或工具信息附加到上下文末尾、开头前缀不动，本需求也验证这条路径：经 `before_agent_start` 返回 `message` 附加的内容必须以非 system 消息进入请求，开头系统提示词必须逐字不变，且保留在后续历史里。
R4. 必须能用 SDK 公开接口，从既有 JSONL 重建会话，重建后的 `messages` 与原会话一致，并能继续对话。
R5. 指定 cwd 与 AGENTS.md 时，同一份 AGENTS.md 内容在请求中必须只出现一次；Server 不得读取 `~/.pi` 下的任何文件（含 AGENTS.md、模型与设置）。
R6. 单槽位界面（confirm/select/input）必须能被 Server 层接管：SDK 把三类对话框原样委托给 Server 提供的 `uiContext`，`timeout`、`signal` 选项透传，答案回到扩展。先答先赢与超时默认值属于 Server 层的实现，留给 ROADMAP 第 3 条；本需求同时记录 SDK 自身不强制 `timeout` 这一事实。
R7. 必须能指定模型配置所在目录，不落到默认的 `~/.pi`；API key 必须能由 Server 在运行时提供（不是文件里的明文），请求中使用的是运行时提供的值。
R8. 必须确定 SDK 实际扫描的 skill 目录（SDK 没有公开的列目录接口，以正负 fixture 为证）：在临时目录布置 skill，断言"扫描目录内被发现、扫描目录外不被发现"，并记录追加目录与关闭自动扫描的行为。
R9. 任何测试不得读写真实的 `~/.pi`（用临时目录与显式路径隔离）；端点与密钥只经环境变量传入，不得出现在入库文件与测试输出里。
R10. 契约用例必须全部能对着本地 stub provider（OpenAI 兼容、返回预设响应）运行，进 `scripts/check.sh` 与 CI，不需要真实模型。另设一个手动冒烟 `scripts/contract-live.sh`：对真实端点跑一次最小会话，缺少环境变量时必须以非零状态失败；它不进 CI。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | `sdk-version.test.ts`：读 package.json 与锁文件 | 变异：把版本改为 `^x.y.z`，必须变红 |
| R2 | stub provider 记录请求体（压缩所需的摘要响应由 stub 预设），压缩后断言标记串出现一次 | 变异：不追加，必须变红；追加两次，必须变红 |
| R3 | stub：四种组合的请求体断言，结果记入 review.md；末尾附加路径的前缀不变断言 | 变异：翻转期望值，必须变红 |
| R4 | `session-load.test.ts`：先写后载，比对 messages | 变异：截断 JSONL 一行，必须变红 |
| R5 | `agents-md.test.ts`：捕获构造的系统提示词；并断言 stub 收到的请求体 | 变异：同时开启 SDK 自带读取与手动注入，必须变红（出现两次） |
| R6 | `ui-dispatch.test.ts`：三类对话框的委托与选项透传；超时不被 SDK 强制 | 变异：让 uiContext 对 confirm 返回相反答案，答案用例必须变红 |
| R7 | `model-config.test.ts`：临时配置目录 + 运行时 key | 变异：把 key 写成明文并让用例要求"文件内无 key"，必须变红 |
| R8 | `skills-dirs.test.ts` | 变异：把 skill 放到扫描目录外，断言"发现"必须变红 |
| R9 | `isolation.test.ts`：HOME 与 SDK 默认配置目录指向临时目录；每个测试文件首条 import 是隔离模块；源码不含内网 IP 与密钥形态 | 变异：去掉某文件的隔离 import，必须变红 |
| R10 | `scripts/check.sh` 日志含契约用例；`contract-live.sh` 无环境变量时退出码非零；live 冒烟对 Qwen 端点手动跑一次 | 是（脚本不存在） |

## Design
- 测试放在 `packages/server/test/contract/`，共用一个 stub provider（本地 HTTP，OpenAI 兼容，记录请求体、返回预设响应）；所有"到达了请求"的断言以它收到的请求体为准。
- live 冒烟是单个脚本，不是测试套件，不断言模型行为，只确认真实端点上会话能跑通。
- 每个假设的实测结论（含 SDK 版本号）记入 `review.md` 的"契约结论"表，作为日后升级 SDK 的对照基线。

## Risks
- 真实端点只有手动冒烟，SDK 对真实 provider 的细节差异靠它兜底；升级 SDK 时需记得跑，README 升级步骤里写明。
- stub 的响应是预设的，不代表真实模型输出；契约只断言 SDK 行为，不断言模型行为。
- 若 R2/R3/R5 的实测推翻 ADR-0009/0004 的前提，ADR 不得被改写，按 intent 升到决策档。
