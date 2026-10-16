# Review: 项目骨架

Reviewer: 每轮由新开的空上下文 subagent 执行（见 .agents/skills/aisdlc/references/review.md）；人在 PR 上做最终评审

> 每一轮评审追加一节。评审记录写在这里，不写进 spec。
> 连续三轮仍有阻塞级问题 → 暂停，回到 spec 澄清口径，必要时请人裁决或升档。

## 第 1 轮（2026-10-16）— 范围：95efc9b..272a63d — 执行：独立评审 subagent（空上下文）

| 级别               | 位置              | 发现         | 处理                                       |
| ------------------ | ----------------- | ------------ | ------------------------------------------ |
| 重要 | `scripts/check.sh:61`（all 分支的 `typecheck`） | spec Proof R4 要求"在任一步骤后加 `\|\| true`，R5、R6 自检必须变红"，实现无法达成：自检只覆盖前置检查与测试步骤的 die 路径，不覆盖 `all` 分支各步的退出状态。复现（临时副本，已实测）：把 `typecheck` 行改为 `typecheck \|\| true`，`scripts/check.sh` 仍输出"全部检查通过"、exit 0。spec Proof 与 plan Deviations 均未记录此偏离。违反：R4 的"必须立即非零退出"没有任何自检覆盖。 | |
| 重要 | `tests/check/selfcheck.sh:64` | R6 的锁文件漂移断言 needle 为空，任何失败都判为通过。复现（已实测）：把 `scripts/check.sh:32` 的安装命令改为 `pnpm install --frozen-lockfile --no-such-flag`（与漂移无关的参数错误），自检仍输出"ok 锁文件漂移"、"自检通过"。该断言也无法区分失败来自前置检查、网络还是漂移。待确认：pnpm 12 在锁文件不一致时的错误码或文案，需实测后用它作断言。 | |
| 重要 | `README.md:13`；`scripts/check.sh:20` | README 写"pnpm 由 corepack 提供，不需要全局安装"，但没有 `corepack enable` 步骤；`command -v pnpm` 在仅有 node、corepack 的环境里失败。复现（已实测）：PATH 只含 node、corepack 时运行 `scripts/check.sh --precheck-only`，输出"缺少前置工具：pnpm"，exit 1。按 README 操作的全新机器会在第一步失败。CI（`.github/workflows/ci.yml:17-25`）同样没有 corepack enable，依赖 runner 镜像自带 pnpm，待确认（需 PR 上的 CI 日志）。intent 的 Open questions 与 plan 步骤 4 要求的 corepack 核实未见记录。 | |
| 建议 | `scripts/check.sh:41` | 零测试判定的 `find` 扫描整个仓库根（含 `tmp/`、`.worktrees/`），不限于 `packages/*`。复现（已实测）：删除两个包的测试、在根目录放 `stray.test.ts`，前置计数通过，实际是 vitest 的 "No test files found, exiting with code 1" 兜住的。当前结果正确，但 R6 的防线实际依赖 vitest 行为，脚本自身的守卫不完整。 | |
| 建议 | `.github/workflows/ci.yml:4-6`；spec R10 与 Risks | 工作流执行的是 PR 分支上的 `scripts/check.sh`、`tests/check/selfcheck.sh` 与 `.agents/**`，PR 可以同时改动检查本身并让自己通过。R10 只要求"PR"，未规定批准数。Risks 只提到了 `.agents/`，没有提到 `scripts/`、`tests/`、`ci.yml`。建议在 spec Risks 中补上，并在 R10 写明批准规则。 | |
| 建议 | spec R10 | 必需检查只有在该作业至少成功运行过一次之后才能在设置页选中。plan 的步骤顺序隐含满足，但 spec 没有写出这一前提。建议在 R10 补一句。 | |
| 建议 | `scripts/check.sh`（pnpm 调用） | 实测中 pnpm 12 忽略 `npm_config_store_dir`，store 写到了仓库外的 `/home/bluezeamer/projects/.pnpm-store`（由本轮运行产生，创建于 09:19，未删除，待你决定是否清理）。仓库内 `tmp/` 的约定与该行为不一致。待确认：pnpm 12 的 store 配置键，改用它或在文档中注明。 | |
| 待确认 | `.github/workflows/ci.yml` | 未经真实 CI 运行。待确认：runner 自带 python3 与 pnpm；setup-node 22.19.0 之后 corepack 下载 pnpm 12.11.2 的行为。已核实：checkout `3d3c42e5…` 与 setup-node `949feb24…` 分别对应 v7.0.1、v7.1.0 的 tag（`gh api` 只读核对）。 | |

已核实无问题（实测）：`scripts/check.sh` 全量退出 0（约 2.4 秒）；typecheck、lint（13 个文件）、test、build、aisdlc 校验均通过；自检 5 项通过；vitest 5.0.4 在零测试文件时退出 1；工作流权限为 `contents: read`，无 `pull_request_target`，无 `secrets.`；`.gitignore` 覆盖 R9 要求的项；`LICENSE` 存在；`packageManager` 与运行的 pnpm 版本一致（12.11.2）。

本轮阻塞级：0 条。
