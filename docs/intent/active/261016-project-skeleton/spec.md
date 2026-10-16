# Spec: 项目骨架
Author: bluezeamer
Status: accepted
Date: 2026-10-16

> 写成 delta：只写本次变更相对既有约定新增或改变了什么。ARCHITECTURE / ADR 已讲过的内容只链接，不复述。
> 本文件只在 Requirements 变化时修改；评审发现写进 review.md。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0013](../../../genesis/adr/0013-tech-stack.md)、[ADR-0014](../../../genesis/adr/0014-hosting-and-ci.md)、[ADR-0016](../../../genesis/adr/0016-license-mit.md)
下游: plan.md、PR（实现后回填）

## Requirements
R1. 仓库根是 pnpm workspace，含 `packages/server` 与 `packages/web`。根 `package.json` 为 private；`packageManager` 锁定 pnpm 的精确版本；`engines.node` 为 `>=22.19.0`；声明 `license: MIT`。
R2. 两个包都启用 TypeScript 严格模式，各有一个占位模块和一条占位测试。`pnpm -r typecheck`、`pnpm -r test`、`pnpm -r build` 在干净检出上全部通过。web 包本阶段不引入 React、Tailwind 或打包器。
R3. Biome 负责 lint 与格式化。`pnpm lint` 在干净检出上通过；存在格式或规则违规时必须失败。
R4. `scripts/check.sh` 依次执行：前置检查、冻结 lockfile 的依赖安装、类型检查、lint、测试、构建、aisdlc 校验。任一步骤失败，脚本必须立即以非零状态退出。本地与 CI 运行同一份。
R5. 前置检查缺少 node（≥22.19）、pnpm（≥10）、python3（≥3.11）中任一项时，必须失败并指出缺的是哪一项，不得跳过。pnpm 在仓库内报告的版本必须等于 `packageManager` 锁定的版本，否则失败。不依赖 corepack。
R6. 测试步骤发现零个测试文件时必须失败。`package.json` 与 lockfile 不一致时，依赖安装必须失败。
R7. `.github/workflows/ci.yml` 在 `pull_request` 与推送到 `main` 时触发，使用 GitHub 托管 runner，权限仅 `contents: read`，不使用 `pull_request_target`，不引用 secret。作业的唯一实质步骤是运行 `scripts/check.sh`。
R8. aisdlc 校验（`aisdlc_index.py --check`）直接引用仓库内 `.agents/skills/aisdlc/scripts/` 下的脚本，不复制到 `scripts/aisdlc/`。
R9. `.gitignore` 补充 `node_modules/`、构建产物、覆盖率与 tsbuildinfo。README 含名称、tagline、当前状态，以及本地运行检查的命令。
R10. 合并后动作：用户在 GitHub 为 `main` 启用保护——要求 PR、要求作业 `check` 通过、禁止强推与删除分支、对管理员同样生效——并做负向验证：直推 `main` 必须被拒。必需检查只有在作业 `check` 至少成功运行过一次之后才能在设置页选中，所以须在骨架 PR 的 CI 跑完之后配置。不要求他人批准（单人仓库，作者无法批准自己的 PR）。结果记入 `review.md`，之后骨架才能关闭。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | `pnpm -r list --depth -1` 列出两个包；`pnpm -v` 等于 `packageManager` 锁定的版本 | 不适用（结构性） |
| R2 | `pnpm -r typecheck`、`test`、`build` | 变异验证：占位模块里引入类型错误，typecheck 必须变红；把占位断言改错，test 必须变红 |
| R3 | `pnpm lint` | 变异验证：写入一行违反格式的代码，必须变红 |
| R4 | 全套检查通过；R5、R6 的自检 | 变异验证：在任一步骤后加 `\|\| true`，R5、R6 的自检必须变红。例外：调用自检的那一步本身无法被自检覆盖（自检以 `CHECK_ROOT` 驱动 `check.sh`，该路径跳过自检以避免递归），由 PR 上的人工评审兜底，见 Risks |
| R5 | 自检脚本：用缺少 python3 或 pnpm 的 PATH 运行前置检查，必须非零且输出缺失项；用报告错误版本的 pnpm 运行，必须非零且指出版本不符 | 变异验证：删掉某一项检查或版本核对，自检必须变红 |
| R6 | 自检：空测试目录运行测试步骤必须非零；改 `package.json` 依赖而不更新 lockfile，安装必须非零 | 变异验证：给测试命令加 `--passWithNoTests`，自检必须变红 |
| R7 | 在 PR 上触发一次，作业成功；向分支推一个带类型错误的提交，作业必须变红；`grep` 工作流确认无 `pull_request_target` 与 `secrets.` | 上述红灯即变异验证 |
| R8 | CI 日志出现 aisdlc 校验步骤且通过 | 变异验证：让某个 intent 的 `Status` 与所在目录不一致，作业必须变红 |
| R9 | 评审核对；README 中的命令在干净检出上可运行 | 不适用 |
| R10 | 用户贴回设置页面与直推被拒的输出；agent 用只读 API 核对规则 | 负向验证本身 |

## Design
沿用 ADR 的选型，新增的只有骨架结构：

```
package.json  pnpm-workspace.yaml  biome.json  tsconfig.base.json  README.md
packages/server/  packages/web/      # 各有 package.json、tsconfig.json、src/index.ts、src/index.test.ts
scripts/check.sh                     # 唯一的检查入口，含前置检查
tests/                               # R5、R6 的自检
.github/workflows/ci.yml             # 只负责起环境并调用 scripts/check.sh
```

- 作业名固定为 `check`，R10 的必需检查按此名配置。
- 第三方 action 的固定方式（版本标签或提交 SHA）在 plan 里定。

## Risks
- aisdlc 在 GitHub 上没有经验。以下几点未经验证，标明如下：必需检查与作业名的对应关系；"对管理员同样生效"在 Free 账号公开仓库上的实际表现。R10 的负向验证就是为抓这类问题。
- 不用 corepack 取得 pnpm：Node 25 起官方不再随发行包提供它；Node 22.19.0 自带的 0.34.0 在空缓存下装不了 pnpm 12（corepack ≥0.34.5 才行）。该问题由骨架 PR 的首次 CI 暴露，本地因缓存里已有旧结果而未发现。改为由 pnpm 自己按 `packageManager` 切换版本，已在 Node 22.19.0、无 corepack、空缓存下用 pnpm 10、11、12 作引导实测都落到锁定的 12.11.2。
- 公开仓库的 CI 对任何人的 PR 都会运行；已限定只读权限且不引用 secret。
- `scripts/check.sh` 是 bash 脚本；Windows 上开发需要 Git Bash 或 WSL。
- CI 执行的是 PR 分支上的 `scripts/check.sh`、`tests/check/`、`ci.yml` 与 `.agents/**`，PR 可以同时修改检查本身并让自己通过。工作流只读且不引用 secret，所以后果止于"本次检查被放过"，不会泄露凭据；真正的闸门是人评审 PR。日后建快车道章程时，上述路径必须在 `deny` 里，改动须经负责人批准。
- 单人仓库不要求他人批准：作者无法批准自己的 PR，要求批准会让合并不可能。
