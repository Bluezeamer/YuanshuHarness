# Intent: 项目骨架
Author: bluezeamer
Status: accepted
Date: 2026-10-16
Lane: build
Why: 不改持久化数据、对外契约、鉴权，选型已有 ADR，故不是决策档；CI 接线有"缺前提时静默假绿"的风险，用"缺前提必须失败"和负向验证加固，其余无静默信号，故为标准档加加固。

## Links
来源: 人工提出；骨架是变更循环的第 0 次迭代，先于 ROADMAP 第 1 条
上游: ../../../ROADMAP.md、../../../genesis/adr/0013-tech-stack.md、../../../genesis/adr/0014-hosting-and-ci.md、../../../genesis/adr/0016-license-mit.md
下游: 定稿后回填

## Problem
仓库还没有任何提交，没有构建配置、检查命令和 CI。后续每个 intent 既无处落地，也没有护栏。

## Proposed outcome
空壳加护栏，不含任何业务能力：
- 目录结构：补全 `.gitignore`（现有 `tmp/`、`.worktrees/`、`.claude/`、`tests/aisdlc`，再加 `node_modules/`、构建产物）。`LICENSE` 已在创世基线中。
- pnpm workspace：`packages/server` 与 `packages/web`。Node ≥ 22.19，经 corepack 使用并在 `packageManager` 字段锁定 pnpm 版本，不要求全局安装；严格类型检查；每个包只有一个占位模块和一条占位测试，用来证明类型检查、lint、测试、构建命令真的能跑。包配置声明 `MIT`。
- Biome 负责 lint 与格式化，Vitest 负责测试。
- 统一检查脚本 `scripts/check.sh`：一次跑完类型检查、lint、测试、构建和 aisdlc 校验；本地与 CI 跑同一份。
- GitHub Actions 工作流：只调用 `scripts/check.sh`，对 PR 和主干 push 触发，使用 GitHub 托管的 runner。
- `aisdlc_index.py`、`aisdlc_check_lane.py` 复制到 `scripts/aisdlc/` 并接入 CI。
- 防假绿：缺少工具、脚本、测试时 CI 必须失败，不能跳过。
- 最小 README：名字、tagline、当前状态、本地如何跑检查。
- 合并后动作（用户做）：在 GitHub 上为主干开启保护（要求 PR、要求检查通过、禁止强推），并做负向验证：直推主干被拒。没做完，骨架不算关闭。

## Out of scope
- 任何业务能力；HTTP 框架、健康端点、Dockerfile、npm 发布配置（属 ROADMAP 第 1 条）。
- pi SDK 依赖与契约测试（ROADMAP 第 2 条）。
- MR 评审、评论命令、监控接线：骨架合并后各自作为独立 intent。
- 命令行命令名。

## Constraints
- TypeScript，Node ≥ 22.19（[ADR-0013](../../../genesis/adr/0013-tech-stack.md)）。
- CI 逻辑写进仓库脚本，工作流只做调用；用托管 runner，不用自托管；设计时参考同类成熟项目（[ADR-0014](../../../genesis/adr/0014-hosting-and-ci.md)）。
- 仓库公开：提交前自查不含凭据与个人信息（[ADR-0014](../../../genesis/adr/0014-hosting-and-ci.md)）。
- 许可 MIT，包配置要声明（[ADR-0016](../../../genesis/adr/0016-license-mit.md)）。
- 提交遵循 Conventional Commits；分支用 `chore/` 前缀。
- aisdlc 没有 GitHub 的落地经验，按其接线原则与触点契约实现，并标明哪些未经验证；完成后问用户愿不愿意沉淀成 `wiring-github.md`。

## Decisions needed
1. 包管理器与仓库结构：选 pnpm workspace，`packages/server` 与 `packages/web`，经 corepack 使用。（2026-10-16，bluezeamer 确认）
2. lint、格式化、测试：选 Biome 加 Vitest。（2026-10-16，bluezeamer 确认）
3. 首次提交范围：创世产出（`docs/`、`.agents/`、`LICENSE`、`.gitignore`、项目 AGENTS.md）作为基线直接提交到 main，并打 `genesis-complete` 标签；骨架走 `chore/project-skeleton` 分支，经 PR 合并。源设计文档在 `docs/archive/Yuanshu-harness-design.md`，原样提交。基线直推 main 发生在主干保护开启之前，是创世的一次性例外。（2026-10-16，bluezeamer 确认）

## Open questions
- GitHub Actions 里 Python 版本与 aisdlc 脚本的运行方式（`python3 -I`），在 plan 阶段核实。
- 包管理器经 corepack 的具体用法，在 plan 阶段核实。
