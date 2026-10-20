# 进度：元枢 usable-v1（长周期任务）

> 最后更新：2026-10-19。活文档：就地更新，不追加快照；变更流水记在文末 Changelog。

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

M1 进行中，已提交：a694538（权限判定改走环境原语、async）、6c77148（工具按 workspace 环境路由、list/switch_workspace、pool 接线）、27d38a5（ExecEnv 流式读写 + `env/transfer.ts`）、15347a0（环境 status / connect / transfers 端点）、4a16593（routed tools 对本机与真实 sshd 的测试）、81bd5be（权限路径判定经 ssh 环境的测试）、d246776（web 测试严格类型修正）、1db1064（workspace 可登记到 ssh 环境，按 `(环境, 路径)` 唯一）。`scripts/check.sh` 在 1db1064 上 exit 0（含真实 sshd 用例）。

M1 还缺：真实模型冒烟（对 ssh workspace 跑一次真实会话）；M1 末的 codex 评审；勾选 M1 与更新 ROADMAP 第 6 条。

未跟踪的 `packages/server/src/session/workspaces.ts` 与已提交的 `workspace-tools.ts` 注册同名工具（`list_workspaces` / `switch_workspace`），但接口不同（前者 `deps.list/get/current/setCurrent` + 参数 `workspace_id`，后者 `WorkspaceToolsApi` + 参数 `workspace`），且前者无人 import；`pool.ts` 用的是后者。来源不明（会话中被标记为用户或 linter 改过，且是有意的）：不删、不提交，等用户确认去留。

## 下一步

M1 收尾，按顺序：
1. （已完成）环境状态与传输端点。
2. （已完成）权限路径判定的 ssh 用例（`permission/paths.ssh.test.ts`：链接逃逸、悬空/循环、`~` 展开、敏感文件扫描）与工具路由用例。
3. （已完成）`scripts/check.sh` 全绿；workspace 可登记到 ssh 环境。
4. 真实模型冒烟（`packages/server/test/live/`，对本机 sshd 的 ssh workspace 跑真实会话，密钥只读不打印）。
5. codex 评审（权限绕过、数据损坏、密钥泄露），结果写 `docs/reviews/m1.md`；再勾选 M1、更新 ROADMAP 第 6 条。

## 决策与偏差

- M0：未提交的 7 个文件含两件事（工具实时输出、pane 内新建会话入口），拆成两个提交；后者让 `settings.test.tsx` 里 5 个用例因同名按钮失败，改为取顶栏第一个按钮。提交落在 `feat/usable-v1` 上，没有动 `feat/permission-prompts`。
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
