# ADR-0055: skill 库、环境识别与向环境同步

状态：已定稿
日期：2026-10-20
可逆性：中
取代：无（落实 [ADR-0008](0008-capability-sets.md) 的 skill 部分）
被取代：——
引用入口：ROADMAP 第 8 条

## 背景
[ADR-0008](0008-capability-sets.md) 定了 skill 由 Server 集中管理、挂载时同步到环境。本篇定库的数据形状、环境里“已有 skill”的识别范围（ADR-0008 的 S0 核对点），以及同步的目标目录与冲突策略。

## 决定
- **库**：文件在 `<数据目录>/skills/<name>/`（`SKILL.md` 及附属文件），元数据在 SQLite 表 `skills`：名称、描述（取自 frontmatter，随文件重算）、作用域（`global` 全局 / `project` 项目级）、来源（`local` 或 `env:<环境名>`）、内容哈希、创建与更新时间。哈希只看（相对路径，内容）集合，与位置无关。
- **校验**：按 Agent Skills 规范——name 为 1–64 位小写字母、数字、连字符（不以连字符开头结尾、无连续连字符），与库名一致；description 必填且 ≤1024；frontmatter 缺 name 只警告。不合规的 `SKILL.md` 不落盘。体量上限：单文件 1 MiB、200 个文件、合计 8 MiB。库里的相对路径只接受 POSIX 风格且不含 `..`，读写前再做符号链接解析后的目录包含检查。
- **识别范围**：以 pi 实际扫描为准——`~/.pi/agent/skills`、`~/.agents/skills`、项目 `.pi/skills`、项目 `.agents/skills`（经 ExecEnv 原语，深度 ≤5，不跟随符号链接）。pi 还会向上扫祖先目录的 `.agents/skills`，不在识别范围。识别只读：用户选“纳入库”才复制整个目录，环境里的原件不动；环境里的项目 skill 不会被自动复制。纳入只接受识别结果里的目录，不能借此读环境里任意路径；元枢命名空间里的同步产物不可纳入。
- **作用域与分配**：全局 skill 只能挂在 agent 上；workspace 级只能分配项目级 skill，存于 `workspace_capabilities(workspace_id, kind, name)`（`kind` 预留给 MCP）。删库里的 skill 同时清除分配。agent 级分配由 agent 定义持有，本篇只提供 `resolveSkills(库, agent 名单, workspace 名单)` 的合并函数。

## 理由
- 库放文件系统而非 SQLite 大字段：skill 带脚本与资源，本来就是目录，同步时直接按文件比对。
- 识别只复制用户选中的，避免把环境里的私有 skill 悄悄收进 Server。

## 影响
- 迁移追加表 `skills`、`workspace_capabilities`。
- 排除：从 URL/压缩包导入；库内的版本历史；skill 依赖管理（ADR-0008：环境自备）。
