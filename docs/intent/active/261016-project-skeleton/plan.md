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
| `scripts/check.sh` | 唯一检查入口，含前置检查，支持 `--precheck-only`（R4、R5） |
| `tests/check/selfcheck.sh` | R5、R6 的自检，由 `check.sh` 的测试步骤调用 |
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
无
