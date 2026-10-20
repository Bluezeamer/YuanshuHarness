# 进度：元枢 usable-v1（长周期任务）

> 最后更新：2026-10-20。活文档：就地更新，不追加快照；变更流水记在文末 Changelog。

## 接手须知（上下文被压缩或换会话后，先读这里）

这是一个长周期、体量很大的任务：除 TUI 与 IM 外，ROADMAP 第 6、7、8、9、12 条全做，WebUI 全部对齐 `tmp/mock-proto`。它不会在一两个上下文窗口内完成，这是预期，不是出了问题。

- 不要因为上下文快满、轮数很多、进展看起来慢，就收尾或缩小范围。压缩不是终点，从「下一步」继续。
- 恢复顺序：读本文件 → `git status` → `git log --oneline -20` → 回到「下一步」。本文件与代码冲突时，以代码和提交为准，并修正本文件。
- 每次提交后，把「当前状态」与「下一步」改成最新（几行即可）；每个里程碑结束时用 /checkpoint 完整更新；预感上下文将被压缩时，先更新再继续。
- 停止的唯一合法理由：验收全部满足，或遇到只有用户能解的阻塞（见 goal）。其余分歧按「决策与偏差」里的默认处理，记一笔，继续。
- 密钥不进库：模型端点与 key 只在 `tmp/model`（已 gitignore），由程序读取使用，不回显，不写进任何文档、提交、日志。

## 目标与边界

分支 `feat/usable-v1`，不推送、不合 main、不发布。范围 = ROADMAP 第 6、7、8、9、12 条全部；第 13 条只做发布前准备（`npm pack`、镜像冒烟），不执行发布。第 10（IM）、11（TUI）不做。VISION「不做什么」里属于设计取舍的条目（多用户、公网、自研沙箱、会话内模型路由、自动降级、CD）仍不做。

固定决策：
1. 视觉按 mock（奶油纸 + 珊瑚），同步改 AGENTS.md 与 yuanshu-webui-style 技能。
2. 不做 virtual-model 路由表，设置页只保留模型登记、默认模型、审核模型。
3. 凭证网关 tab 在其后端落地前显示「规划中」并置灰，落地后启用（排在最后）。
4. 文件传输只走 sftp，不做 rsync / scp / agent·ssh 选择。
5. 能力页只展示真实存在的内容，不做三层加载与升级通道。
6. Windows 无真机：只写不验，标注「未验证」。
7. 原型期不走 aisdlc；ADR 只在新依赖、数据形状、对外协议、权限边界处各写一条短的。
8. MCP 先查 SDK 接入点，没有干净的就记入 ROADMAP 并跳过。

## 验证环境

- 真实模型：`tmp/model`（pi models.json 格式，provider `qwen27b`，openai-completions，带 compat 与 thinkingLevelMap）。真实模型只做冒烟场景，不做评测。
- 本地 sshd：`tmp/sshd`（端到端用）。
- 日常：typecheck、lint、相关单测；里程碑结束：`scripts/check.sh`。

## 里程碑

- [x] M0 收尾：提交 7 个未提交文件；切 `feat/usable-v1`；提交本文件
- [ ] M1 ssh 环境路由（进行中，见「当前状态」）：工具走 ssh、多环境 workspace、list/switch_workspace 与尾部通知、sftp 传输、环境状态、权限按环境判定（第 6 条）
- [ ] M2 WebUI 工作区：mock 布局模型（pane 内 tab、follow/钉住、预设、落区拖拽）、终端/文件管理/文件预览/PDF/网页预览/审计 pane、划选提问、跨主机拖拽传输、会话 rail 与总览、视觉 token 迁移
- [ ] M3 agent 定义：提示词块拼接、能力勾选、build/plan 模式、模型向导补 compat/thinkingLevelMap（第 7 条）
- [ ] M4 隐私变量与 sudo：@占位符审批后替换、输出回显遮罩、sudo 三类处理（第 8 条）
- [ ] M5 skill 与 MCP 集中管理与同步、能力集页（第 8 条）
- [ ] M6 subagent：spawn/wait/interrupt、拓扑图、会话详情页（第 9 条）
- [ ] M7 设置页逐 tab 对齐 mock
- [ ] M8 持久进程追踪；内置浏览器、侧边虚拟浏览器、常驻链接应用形态（第 12 条）
- [ ] M9 hook；输出脱敏；凭证网关（第 12 条）
- [ ] M10 agent teams、workflow、提示词块节点编辑器、claudedesign 式前端设计模式（第 12 条）
- [ ] M11 加强档环境 daemon；rg/fd 静态二进制补全；LSP/DAP（第 12 条）
- [ ] M12 收口：VISION 6 条成功标准端到端、发布前准备、整体评审、ROADMAP/VISION/README/AGENTS 同步

## 当前状态

M0 完成。M1 代码、测试、真实模型冒烟完成，codex 评审已落 `docs/reviews/m1.md`，其中 7 条已采纳/部分采纳，**修复待做**（等 task/* 合并后做，避免与改 env/、ssh/ 的分支冲突），修完才勾 M1。

上一会话被中断后，5 个半成品分支（基线 731f9da）各留了已提交的第一块和一批**未提交**改动；本会话已重新派 5 个后台 subagent 在原 worktree 里续做，各自收尾后自行提交：
- `task/term-files`（.worktrees/term-files）：M2 服务端——终端(pty/ssh shell)、审计、文件管理 API、传输入口、预览支撑（ADR 0035–0039）
- `task/web-layout`（.worktrees/web-layout）：M2 WebUI 骨架——token 迁移已提交；布局模型对齐 mock、rail/总览、topnav 与路由骨架、pane 注册扩展点（0040–0044）
- `task/agent-defs`（.worktrees/agent-defs）：M3——提示词块、agent 定义、build/plan、能力引用位、编辑器面板（0045–0049）
- `task/private-vars`（.worktrees/private-vars）：M4 剩余——回显遮罩、sudo、interactive 判定接口、隐私变量面板（0050–0054）
- `task/skills-mcp`（.worktrees/skills-mcp）：M5 剩余——skill 同步、MCP（先查 SDK 接入点）、SkillsPanel/McpPanel（0055–0059）

合并预期冲突点：`store/db.ts` MIGRATIONS 末尾、`server.ts` 注册块、`session/pool.ts`、`env/ssh.ts`、`ssh/connection.ts`、web 的 `api.ts`/路由。

## 下一步

1. 等 5 个 subagent 回报；逐个核对（看 diff、跑测试）再 squash 合并到 feat/usable-v1，解冲突，每次合并后跑相关测试，全合完跑 `scripts/check.sh`。
2. 修 M1 评审 7 条（见 `docs/reviews/m1.md`），提交后把处理列改为「已修（提交号）」，勾 M1。
3. 合并后接线（subagent 刻意留给主 agent）：topnav 挂 `CapabilitiesPage`（含 AgentsPanel/PromptBlocksPanel/SkillsPanel/McpPanel）、agent 级 skill/MCP 分配 ↔ agent 定义、pane 注册表填入终端/文件/预览/PDF/审计真实组件、审计钩子、VariablesPanel 已挂设置页则核对。
4. 波次 2：M2 的 WebUI pane 内容（终端、文件管理、文件/PDF/网页预览、审计、划选提问、跨主机拖拽传输）；M6 subagent（依赖 M3 agent 定义与 M4 interactive 判定）；M7 设置页逐 tab 对齐。
5. 波次 3：M8、M9、M10、M11；M12 收口。
6. 评审节点：M4、M6、M9、M12 结束时委派 codex（read-only，后台，`< /dev/null`，`-o` 落最终回复），处理列写进 `docs/reviews/<里程碑>.md`。
7. 调研素材（pi 检索，`tmp/pi/`）：browser-embed（M8）、lsp-dap（M11）、rg-fd（M11）、hooks（M9）。

## 决策与偏差

- M0：未提交的 7 个文件含两件事（工具实时输出、pane 内新建会话入口），拆成两个提交；后者让 `settings.test.tsx` 里 5 个用例因同名按钮失败，改为取顶栏第一个按钮。提交落在 `feat/usable-v1` 上，没有动 `feat/permission-prompts`。
- 未跟踪的 `session/workspaces.ts`（与 `workspace-tools.ts` 同名工具、无人 import 的旧稿）已移到 `tmp/stale/session-workspaces.ts.bak`，未删除，可恢复。
- 基线 lint：`biome check .` 在 error 级别干净；`client.test.ts`、`models.test.ts` 的 useTemplate / noExplicitAny 是历史 warning/info，不属本任务，不动。

## 技术备忘

- 本机终端需要 pty 依赖（带预编译），前端用 xterm.js；选型写一条 ADR。
- 并行工作用 `.worktrees/<branch>/`，分支 `task/<short-desc>`，由主 agent squash 合并并清理。

## Changelog

### 2026-10-19（M1 中途）
本轮完成：M1 的 env 层、工具路由、workspace 切换、transfer 原语（三笔提交，见「当前状态」）。M1 未完成，未勾选。
主体更新：「当前状态」「下一步」改写，列出 M1 缺口。

### 2026-10-19（M0 完成）
本轮完成：创建本文件，对齐范围与固定决策。
主体更新：全部区块初始化。
下一步：M0，然后 M1 的 SDK 执行层 spike。
