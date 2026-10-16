# Plan: 项目骨架
Author: bluezeamer
Status: accepted
Date: 2026-10-16

> plan 是活的：实现中偏离计划，写进 Deviations，与对应代码同一次提交，无需重新审批。
> 只有偏离触及 spec 的 Requirements 时才回头改 spec。

## Links
来源: [spec.md](spec.md)
下游: PR（实现后回填）

## Files that change
| 文件 | 说明 |
|---|---|
| `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | 根工作区；`packageManager` 锁 pnpm 精确版本，`engines.node >=22.19.0`，`license: MIT`，private（R1） |
| `tsconfig.base.json` | 严格模式的共用配置（R2） |
| `biome.json` | lint 与格式化；读取 `.gitignore`（R3） |
| `packages/server/`、`packages/web/` | 各含 `package.json`、`tsconfig.json`、`tsconfig.build.json`、`src/index.ts`、`src/index.test.ts`（R2） |
| `scripts/check.sh` | 唯一检查入口，含前置检查；`CHECK_ROOT` 仅供自检指向临时工程（R4、R5） |
| `tests/check/selfcheck.sh` | R4–R6 的自检：造最小临时工程驱动 `check.sh`，每次只让一步失败；由 `check.sh` 的自检步骤调用 |
| `.github/workflows/ci.yml` | 作业 `check`（R7、R8） |
| `.gitignore`、`README.md` | 补充忽略项；最小 README（R9） |

## Order of work
1. 工作区骨架：根配置、两个占位包，`pnpm install` 生成锁文件。逐条跑 typecheck、lint、test、build，确认各自能通过（R1–R3）。对 R2、R3 做变异验证：引入类型错误、错误断言、格式违规，各自必须变红，随后还原。
2. 先写自检 `tests/check/selfcheck.sh`，此时 `check.sh` 不存在，自检必须失败（失败先行）。自检覆盖：缺 python3 或 pnpm 时前置检查失败并报出缺失项；空测试目录下测试步骤失败；`package.json` 与锁文件不一致时安装失败。
3. 写 `scripts/check.sh`：`set -euo pipefail`，步骤依次为前置检查、`pnpm install --frozen-lockfile`、typecheck、lint、测试（含自检）、build、`aisdlc_index.py --check`。自检转绿后做变异验证：给任一步骤加 `|| true`、给测试命令加 `--passWithNoTests`、删掉某项前置检查，自检必须变红，随后还原（R4–R6）。
4. 写 `ci.yml` 与 README，补全 `.gitignore`。action 按提交 SHA 固定并注明标签：checkout `3d3c42e5…`（v7.0.1）、setup-node `949feb24…`（v7.1.0）。runner 自带 python3，不引入 setup-python；前置检查负责在缺失时失败（R7–R9）。
5. 本地完整跑一遍 `scripts/check.sh`，记录输出。
6. 新开空上下文 subagent 评审，结果写进 `review.md`；修复后再评审增量，直到无阻塞级问题。
7. 经用户同意后推送分支并开 PR，观察 CI 通过。再开一个一次性草稿 PR，其中带类型错误，确认 CI 变红，随后关闭并删除该分支（R7 的变异验证）。
8. 用户评审并合并 PR；用户在 GitHub 上开启主干保护并做负向验证（R10），结果记入 `review.md`。

## Deviations
- 2026-10-16：spec Proof 与 plan 步骤 3 写的变异"给测试命令加 `--passWithNoTests`"未做。`check.sh` 用 `find` 自行统计测试文件，零文件时先于 vitest 失败，不依赖 vitest 的行为，所以该变异不会让自检变红，也不构成漏洞。改为对 `find` 这一道防线做变异（"零测试文件不再报错"），已被自检抓住。
- 2026-10-16：首版变异验证发现自检有盲区：删掉前置检查的存在性判断后，后续版本检查因命令缺失同样失败，输出里恰好含工具名，旧断言放过了变异。已把断言收紧为要求出现"缺少前置工具：<名称>"。同一轮还修正了"缺 pnpm"用例的受限 PATH（漏放 corepack）。
- 2026-10-16：pnpm 把依赖仓库建到了仓库外，且 `minimumReleaseAge` 自动改写了 `pnpm-workspace.yaml`。vitest 改锁 5.0.4（发布已满 4 天），安装时用 `--store-dir` 指向 `tmp/`。
- 2026-10-16（评审第 1 轮后）：自检重写。首版自检只覆盖前置检查、零测试文件和锁文件漂移，无法抓住"任一步骤后加 `|| true`"，与 spec Proof R4 不符。现在用最小临时工程（`CHECK_ROOT`）逐步骤注入失败，并带一个"全部正常"的对照组；锁文件漂移的断言改为要求出现 `ERR_PNPM_OUTDATED_LOCKFILE`，不再接受空匹配。`check.sh` 因此去掉了 `--precheck-only` 等单步参数，零测试文件的扫描收窄到 `packages/`。
- 2026-10-16（评审第 1 轮后）：变异验证中"前置检查后加 `|| true`"不会让自检变红，经复现确认是等价变异——前置检查的所有失败路径都经 `die`，而 `die` 用 `exit`，不受 `|| true` 影响。不是盲区。
- 2026-10-16（评审第 1 轮后）：CI 作业在 `check.sh` 之前多了一步 `corepack enable`（环境准备，非检查逻辑），与 spec R7 "唯一实质步骤"的字面表述有出入；README 同步补上这一步。pnpm 12 只认 `pnpm_config_` 前缀的环境变量（`npm_config_store_dir` 无效），自检里据此设置，避免在仓库外建 store。
