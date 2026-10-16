# VISION: YuanshuHarness（元枢）

> 元枢 —— 万象之枢，昼夜不怠。
> 元：根本、元始；枢：门轴、北斗第一星，古称调度之处。元枢：元调度中枢
>
> 本文件在创世后冻结：只在项目转向时修改，且必须在同一次提交里带一份说明转向原因的 ADR。

## 一句话
基于 Pi SDK（不 fork）的常驻 Agent Server：托管 coding agent 与助理 agent，WebUI、命令行、IM 等客户端共享同一个会话池，随时接入与断开，不打断正在运行的任务。

## 痛点
- skill 与 MCP 要在每个环境各配一遍，换环境重配，工具更新后还要逐台同步。
- 远程操作靠 skill 或 MCP 拼凑：命令被包进一层外壳里，可读性差，规则判断只能全放或全拒，既不优雅也不原生。
- 非主流供应商的模型接入要手写配置文件。
- 权限靠规则穷举判断命令危险，效果有限；逐个审批又会决策疲劳。
- 密码、token 容易暴露给模型。

## 目标用户
我自己（单用户）。日常办公在 Windows 上，开发常在远程 Linux 上。项目开源，但不为多用户做设计。

## 做什么
- 常驻会话池：任务不随客户端断开而中断，多客户端同时接入同一会话。（[ADR-0005](adr/0005-client-protocol.md)）
- 原生的远程环境：只需 ssh，远程零安装，命令原样执行；Linux、macOS 与 Windows（经 Git Bash）都是环境。（[ADR-0002](adr/0002-thin-environment-ssh.md)）
- 三档权限（规则审批 / 自动模式 / 完全允许），依据当前 workspace 动态判断，自动模式由专用审核模型把关。（[ADR-0006](adr/0006-permission-tiers.md)）
- 隐私变量：密码绑定到具体命令，占位符引用，模型看不到值。（[ADR-0007](adr/0007-private-variables.md)）
- agent 即"提示词分组拼接 + 能力勾选 + 模型"；skill 与 MCP 由 Server 集中管理并分发到各环境。（[ADR-0003](adr/0003-concept-model.md)、[ADR-0008](adr/0008-capability-sets.md)、[ADR-0009](adr/0009-prompt-assembly-injection.md)）
- subagent：独立会话加父子关系，WebUI 以拓扑图展示并可介入。（[ADR-0010](adr/0010-subagent.md)）
- 模型接入向导：三种主流协议的图形化配置。（[ADR-0015](adr/0015-model-management.md)）

## 不做什么
- 不 fork pi，只用 SDK，版本精确锁定；不兼容 pi 命令行与第三方 pi 扩展。（[ADR-0001](adr/0001-pi-sdk-no-fork.md)）
- 不做多用户与账号体系，IM 只做白名单路由；不面向公网。（[ADR-0011](adr/0011-auth-and-im-routing.md)）
- Server 不创建、不管理隔离环境，环境由用户自备并通过 ssh 接入；远程不安装 pi 与 Node。（[ADR-0002](adr/0002-thin-environment-ssh.md)）
- 不自研沙箱，不靠规则穷举判断命令危险；基建内不做输出脱敏。（[ADR-0006](adr/0006-permission-tiers.md)）
- 本期不做出口凭证网关。（[ADR-0007](adr/0007-private-variables.md)）
- 不依赖 Durable，不做任务级 checkpoint，不做多写入者集群。（[ADR-0004](adr/0004-state-storage-recovery.md)）
- 不做会话内模型路由，不自动降级模型。（[ADR-0015](adr/0015-model-management.md)）
- 不做自动部署（CD）。（[ADR-0012](adr/0012-delivery-form.md)）
- agent teams 与 workflow 不属于基建；TUI 最后做；内置浏览器、文件预览等 WebUI 上层能力排在基建之后（见 ROADMAP）。

## 成功标准
- 在 WebUI 发起任务后关闭浏览器，从另一个客户端接入，任务未中断且能看到最新状态。
- 对一台只有 ssh 的陌生 Linux 主机，不装任何东西，agent 就能读写文件、执行命令、传文件。
- 一台装有 Git Bash 与 OpenSSH Server 的 Windows 机器，可以作为环境接入，完成同样的事。
- 新接入一个环境，已分配的 skill 在挂载时自动到位。
- 自动模式下的长任务：规则外动作由模型审，拿不准的弹给用户，全程没有默认放行。
- Server 重启后对话历史完整，被打断的工具调用能被 agent 感知。

## 约束
- TypeScript、Node ≥ 22.19，`@earendil-works/*` 精确锁定；WebUI 用 React 与 Tailwind。（[ADR-0013](adr/0013-tech-stack.md)）
- Server 以 Linux 为目标（宿主机、容器或 WSL）；Windows 机器只作为被操作的环境。部署位置不定，状态集中在单一数据目录。（[ADR-0012](adr/0012-delivery-form.md)、[ADR-0002](adr/0002-thin-environment-ssh.md)）
- 托管于 GitHub 公开仓库（YuanshuHarness），从一开始即公开；CI 逻辑写进仓库脚本；发布包名 `yuanshu-harness`。（[ADR-0014](adr/0014-hosting-and-ci.md)）
- 开源协议 MIT（[ADR-0016](adr/0016-license-mit.md)）；移植 Codex 的代码保留 Apache-2.0 并署名（[ADR-0006](adr/0006-permission-tiers.md)）。
- WebUI 视觉风格取向沿用用户的全局审美偏好（新拟态 / 瑞士国际主义 / 新粗野主义，动效丰富自然），具体风格在 WebUI 骨架 intent 中选定。

## 待决问题
- 审批超时时长；subagent 的深度与并发上限；子会话的审核规则怎么继承。
- `switch_workspace` 与跨环境复制按哪个 workspace 的档位判；MCP 工具调用走哪一档；MCP 所需密钥怎么注入。
- IM 发起的会话触发审批时由谁来答；Hermes 的 IM 接入做法待核对。
- 隐私变量的加密方式、占位符语法；输出脱敏将来如何设计。
- Windows 上经 ssh 启动的进程能否驱动 GUI 应用，是否需要常驻进程（S0 验证）。
- 凭证网关将来是否引入；命令行命令名；默认助理 agent 的名字（暂定"恒侍"）等预设。
- 用户可配置 hook 开放哪些点位；hook 能否影响权限决定（倾向只能收紧）。
- S0 要验证的 pi 假设，见 ROADMAP 第 2 条。

> 链接约定：本文件中凡由正式决策支撑的条目（尤其"不做什么"与"约束"），必须链接到当前有效的 ADR；ADR 的演化链在 adr/ 内追溯。
