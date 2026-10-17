# Intent: 契约测试（第一批：本机可验证的 SDK 假设）
Author: bluezeamer
Status: accepted
Date: 2026-10-17
Lane: build
Why: 依赖本身已由 ADR-0001 定下，不是新决策；但要验证的全是对第三方 SDK 真实行为的假设，命中"静默"信号，故为标准档加固。若实测推翻了某条 ADR，则停下升到决策档。

## Links
来源: ROADMAP 第 2 条
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0001](../../../genesis/adr/0001-pi-sdk-no-fork.md)、[ADR-0004](../../../genesis/adr/0004-state-storage-recovery.md)、[ADR-0005](../../../genesis/adr/0005-client-protocol.md)、[ADR-0008](../../../genesis/adr/0008-capability-sets.md)、[ADR-0009](../../../genesis/adr/0009-prompt-assembly-injection.md)、[ADR-0015](../../../genesis/adr/0015-model-management.md)
下游: [spec.md](spec.md)

## Problem
主干（第 3 条起）要建在 pi SDK 的若干行为上，这些行为目前只是 ADR 里的"S0 需验证"。不先验证，错误会在主干成型后才暴露，且代价是返工。
SDK 迭代快，升级版本时也需要一组能自动判断"假设是否还成立"的测试（ADR-0001）。

## Proposed outcome
- Server 包以精确版本依赖 pi SDK，锁文件入库。
- 一套契约测试，全部对着本地 stub provider 运行，进 `scripts/check.sh` 与 CI；另有一个手动冒烟脚本，对真实端点跑一次最小会话，不进 CI。
- 第一批覆盖的假设：压缩后在系统提示词末尾追加；`supportsMidConvoSystemMessages` / `supportsMidConvoToolChanges` 的实际行为；从 JSONL 加载会话；AGENTS.md 的接管；单槽位界面分发；模型配置的指定路径与密钥来源；skill 扫描目录。
- 每条假设有实测结论。结论与 ADR 一致则记录；不一致则停下，向人说明并升档。

## Out of scope
- 第二批：真实 Windows 上的 ssh 与 GUI 自动化、macOS 命令差异、`sudo -n -l` 的缓存与输出差异。需要外部机器，另开 intent。
- 任何 Server 业务代码（会话池、事件流等）：契约测试只验证 SDK，不实现主干。
- 把 SDK 行为包一层适配层：先知道行为，适配留给第 3 条。

## Constraints
- 精确锁定 `@earendil-works/*`，不用范围符；升级须先过契约测试（[ADR-0001](../../../genesis/adr/0001-pi-sdk-no-fork.md)）。
- 只依赖 SDK 公开接口；不读取机器上已有的 pi 配置目录（ADR-0001）。
- CI 用托管 runner，没有模型端点；缺少前提必须失败而不是跳过（[ADR-0014](../../../genesis/adr/0014-hosting-and-ci.md) 与 `scripts/check.sh` 的既有原则）。
- 仓库公开：端点地址、密钥只经环境变量传入，不写进任何入库文件、测试输出与评审记录。

## Decisions needed
1. **锁定的 SDK 版本**：**1.3.0**。（2026-10-17，bluezeamer 确认）
2. **真实模型的使用方式**：CI 与契约用例不调用真实模型，全部对着本地 stub provider；真实端点只做手动冒烟。理由：断言的是"内容到达请求"，与模型无关；协作者提交时 CI 不应消耗模型额度。（2026-10-17，bluezeamer 确认）
3. **模型口径**：契约只断言"内容到达请求"，不断言"模型听话"；冒烟用本地部署的 Qwen3.8-27B，端点无需 key。（2026-10-17，bluezeamer 确认）

4. **R3 的协议范围**：第一批只覆盖 openai-completions；anthropic-messages 的 `supportsMidConvoToolChanges` 延期到接入该协议时。理由：最终版本能兼容即可，依赖的是 pi 自身基建，目前只是没有对应的 mock。（2026-10-17，bluezeamer 确认）
5. **中途变化的载体**：不需要中途 system 消息。变化以用户消息或工具信息附加到上下文末尾（参考 opencode 的模式切换设计），开头前缀不动；ADR-0009 的退路本来就是这条，无需新增 ADR。（2026-10-17，bluezeamer 确认）
6. **忽略 SDK 传递依赖的安装脚本**：`@google/genai` 的 preinstall 是 no-op，`protobufjs` 的 postinstall 只打印版本方案警告，忽略无负面影响。（2026-10-17，bluezeamer 确认）

## Open questions
- `supportsMidConvo*` 两个标志在 1.3.0 里的确切含义与默认值，实现阶段读源码与实测确认（实现者）。
