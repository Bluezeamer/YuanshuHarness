# ROADMAP: YuanshuHarness（元枢）

> 这是地图不是合同：团队级的方向，变得慢。只写方向与顺序，不写进度（"做到哪了"由已关闭的变更推出），也不链具体 intent。
> 方向变了才改本文件：顺序与条目随之调整，提交并记入「调整记录」。
> 影响路线的重大取舍（为什么先做 A 后做 B）若经正式决策，须链接对应 ADR。

## 能力演进序列
1. 部署骨架：空壳 Server，健康端点可探测，npm 包与 Docker 镜像可构建（[ADR-0012](genesis/adr/0012-delivery-form.md)、[ADR-0017](genesis/adr/0017-server-web-framework.md)、[ADR-0018](genesis/adr/0018-startup-params-and-health-endpoint.md)、[ADR-0019](genesis/adr/0019-release-artifacts.md)）
2. 契约测试：固化对 pi SDK 的假设并锁定版本（[ADR-0001](genesis/adr/0001-pi-sdk-no-fork.md)）。需要验证的假设：
   - 压缩后能否在系统提示词末尾追加；`supportsMidConvoSystemMessages` 与工具类中途变更标志的实际行为（openai-completions 为 `supportsMidConvoToolAdditions`，anthropic-messages 为 `supportsMidConvoToolChanges`；后者随接入该协议时再验证）（[ADR-0009](genesis/adr/0009-prompt-assembly-injection.md)）
   - 从 JSONL 加载会话的接口；pi 自身读取 AGENTS.md 时如何接管、避免重复注入（[ADR-0004](genesis/adr/0004-state-storage-recovery.md)）
   - 单槽位界面在 Server 层分发是否可行（[ADR-0005](genesis/adr/0005-client-protocol.md)）
   - 模型配置能否引用密码库而不是写明文 key，SDK 能否指定配置路径（[ADR-0015](genesis/adr/0015-model-management.md)）
   - skill 在 pi 中被扫描的目录（[ADR-0008](genesis/adr/0008-capability-sets.md)）
   - 真实 Windows 机器上 ssh 原语与 GUI 应用自动化的可行性；macOS 上零安装档命令的差异（[ADR-0002](genesis/adr/0002-thin-environment-ssh.md)）
   - `sudo -n -l` 的缓存与跨系统输出差异（[ADR-0007](genesis/adr/0007-private-variables.md)）
3. 主干：会话池、带序号的事件流与排队、持久化、认证、最小命令行客户端，仅本机环境（[ADR-0004](genesis/adr/0004-state-storage-recovery.md)、[ADR-0005](genesis/adr/0005-client-protocol.md)、[ADR-0011](genesis/adr/0011-auth-and-im-routing.md)）
4. WebUI 基础：对话、停止、断线重连、统一弹窗
5. 权限：三档、规则、自动审批与审核模型、只读命令白名单（[ADR-0006](genesis/adr/0006-permission-tiers.md)）
6. 环境：ssh 环境（含 Windows）、workspace、环境切换、文件传输、状态通知、存 ssh 凭据的基础密码库（[ADR-0002](genesis/adr/0002-thin-environment-ssh.md)、[ADR-0003](genesis/adr/0003-concept-model.md)、[ADR-0007](genesis/adr/0007-private-variables.md)）
7. agent 定义：提示词分组拼接、能力勾选、模式、模型接入向导（[ADR-0003](genesis/adr/0003-concept-model.md)、[ADR-0009](genesis/adr/0009-prompt-assembly-injection.md)、[ADR-0015](genesis/adr/0015-model-management.md)）
8. skill 与 MCP 集中管理与同步；密码绑定命令注入与 sudo（[ADR-0007](genesis/adr/0007-private-variables.md)、[ADR-0008](genesis/adr/0008-capability-sets.md)）
9. subagent 与调用拓扑图（[ADR-0010](genesis/adr/0010-subagent.md)）
10. IM 接入（[ADR-0011](genesis/adr/0011-auth-and-im-routing.md)）
11. TUI
12. 之后，顺序待定，随需求取舍：
    - WebUI 上层能力：内置浏览器、文件预览、侧边虚拟浏览器、claudedesign 式前端设计模式、对话导航与输入区布局、常驻链接应用形态
    - 持久进程追踪
    - 提示词块的节点编辑器；agent teams、workflow
    - 用户可配置的 hook（参照 Claude Code、Codex 的设计；开放点位 = pi 自身加 Server 附加，后定）：安全护栏、工具后自动化、可观测性、上下文增强
    - 输出脱敏；凭证网关
    - 加强档环境 daemon；rg 与 fd 的静态二进制补全；LSP 与 DAP 经环境拉起
13. 首次发布（npm 包与镜像）：用户确认有可用版本后（条件式）

## 调整记录
- 2026-10-17 第 2 条：契约测试第一批只覆盖 openai-completions，anthropic-messages 的工具类标志延期到接入该协议时（bluezeamer 批准）。
- 2026-10-16 创世：初始序列。排序原则是先验证风险、再搭主干、最后按依赖叠加。
