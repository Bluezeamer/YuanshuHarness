# Review: 项目骨架

Reviewer: 每轮由新开的空上下文 subagent 执行（见 .agents/skills/aisdlc/references/review.md）；人在 PR 上做最终评审

> 每一轮评审追加一节。评审记录写在这里，不写进 spec。
> 连续三轮仍有阻塞级问题 → 暂停，回到 spec 澄清口径，必要时请人裁决或升档。

## 第 1 轮（2026-10-16）— 范围：95efc9b..272a63d — 执行：独立评审 subagent（空上下文）

| 级别               | 位置              | 发现         | 处理                                       |
| ------------------ | ----------------- | ------------ | ------------------------------------------ |
| 重要 | `scripts/check.sh:61`（all 分支的 `typecheck`） | spec Proof R4 要求"在任一步骤后加 `\| 已修 `e02e242`：自检重写为最小临时工程逐步骤注入失败，加对照组。对 check.sh 做 14 项变异（各步骤 `\|\| true`、删前置检查、去 `set -e` 等），13 项变红；另一项“前置检查后加 `\|\| true`”经复现是等价变异（`die` 用 `exit`），不是盲区。已记入 plan Deviations | true`，R5、R6 自检必须变红"，实现无法达成：自检只覆盖前置检查与测试步骤的 die 路径，不覆盖 `all` 分支各步的退出状态。复现（临时副本，已实测）：把 `typecheck` 行改为 `typecheck \|\| true`，`scripts/check.sh` 仍输出"全部检查通过"、exit 0。spec Proof 与 plan Deviations 均未记录此偏离。违反：R4 的"必须立即非零退出"没有任何自检覆盖。 | |
| 重要 | `tests/check/selfcheck.sh:64` | R6 的锁文件漂移断言 needle 为空，任何失败都判为通过。复现（已实测）：把 `scripts/check.sh:32` 的安装命令改为 `pnpm install --frozen-lockfile --no-such-flag`（与漂移无关的参数错误），自检仍输出"ok 锁文件漂移"、"自检通过"。该断言也无法区分失败来自前置检查、网络还是漂移。待确认：pnpm 12 在锁文件不一致时的错误码或文案，需实测后用它作断言。 | 已修 `e02e242`：断言改为要求出现 `ERR_PNPM_OUTDATED_LOCKFILE`。用评审给的反向变异（安装命令加无关参数）复测，自检变红 |
| 重要 | `README.md:13`；`scripts/check.sh:20` | README 写"pnpm 由 corepack 提供，不需要全局安装"，但没有 `corepack enable` 步骤；`command -v pnpm` 在仅有 node、corepack 的环境里失败。复现（已实测）：PATH 只含 node、corepack 时运行 `scripts/check.sh --precheck-only`，输出"缺少前置工具：pnpm"，exit 1。按 README 操作的全新机器会在第一步失败。CI（`.github/workflows/ci.yml:17-25`）同样没有 corepack enable，依赖 runner 镜像自带 pnpm，待确认（需 PR 上的 CI 日志）。intent 的 Open questions 与 plan 步骤 4 要求的 corepack 核实未见记录。 | 已修 `e02e242`：README 与 `ci.yml` 补 `corepack enable`；前置检查的提示改为指出该步骤。在 Node 22.19.0 干净环境按“未启用被拦下 → 启用后通过”验证。CI 上的实际表现仍待 PR 的 CI 日志确认 |
| 建议 | `scripts/check.sh:41` | 零测试判定的 `find` 扫描整个仓库根（含 `tmp/`、`.worktrees/`），不限于 `packages/*`。复现（已实测）：删除两个包的测试、在根目录放 `stray.test.ts`，前置计数通过，实际是 vitest 的 "No test files found, exiting with code 1" 兜住的。当前结果正确，但 R6 的防线实际依赖 vitest 行为，脚本自身的守卫不完整。 | 已修 `e02e242`：扫描收窄到 `packages/`；加入变异（改回扫描仓库根）并被自检抓住 |
| 建议 | `.github/workflows/ci.yml:4-6`；spec R10 与 Risks | 工作流执行的是 PR 分支上的 `scripts/check.sh`、`tests/check/selfcheck.sh` 与 `.agents/**`，PR 可以同时改动检查本身并让自己通过。R10 只要求"PR"，未规定批准数。Risks 只提到了 `.agents/`，没有提到 `scripts/`、`tests/`、`ci.yml`。建议在 spec Risks 中补上，并在 R10 写明批准规则。 | 已修 `e02e242`：spec Risks 补充 `scripts/`、`tests/check/`、`ci.yml` 也属于“PR 可自改检查”的范围，说明后果止于本次检查被放过，闸门是人评审；并写明单人仓库不要求他人批准的理由 |
| 建议 | spec R10 | 必需检查只有在该作业至少成功运行过一次之后才能在设置页选中。plan 的步骤顺序隐含满足，但 spec 没有写出这一前提。建议在 R10 补一句。 | 已修 `e02e242`：R10 补上“必需检查需作业至少成功运行一次后才能选中，须在骨架 PR 的 CI 跑完之后配置” |
| 建议 | `scripts/check.sh`（pnpm 调用） | 实测中 pnpm 12 忽略 `npm_config_store_dir`，store 写到了仓库外的 `/home/bluezeamer/projects/.pnpm-store`（由本轮运行产生，创建于 09:19，未删除，待你决定是否清理）。仓库内 `tmp/` 的约定与该行为不一致。待确认：pnpm 12 的 store 配置键，改用它或在文档中注明。 | 部分处理 `e02e242`：自检里设 `pnpm_config_store_dir`（pnpm 12 只认 `pnpm_config_` 前缀），不再污染仓库外。主脚本直接 `pnpm install` 在这台机器上仍会落到 `projects/.pnpm-store`（主目录 store 与项目不在同一文件系统，pnpm 的回退行为）。是否在仓库里钉死 `storeDir` 交用户决定。已清理仓库外的目录 |
| 待确认 | `.github/workflows/ci.yml` | 未经真实 CI 运行。待确认：runner 自带 python3 与 pnpm；setup-node 22.19.0 之后 corepack 下载 pnpm 12.11.2 的行为。已核实：checkout `3d3c42e5…` 与 setup-node `949feb24…` 分别对应 v7.0.1、v7.1.0 的 tag（`gh api` 只读核对）。 | 推迟：需 PR 上的真实 CI 运行才能确认；plan 步骤 7 执行 |

已核实无问题（实测）：`scripts/check.sh` 全量退出 0（约 2.4 秒）；typecheck、lint（13 个文件）、test、build、aisdlc 校验均通过；自检 5 项通过；vitest 5.0.4 在零测试文件时退出 1；工作流权限为 `contents: read`，无 `pull_request_target`，无 `secrets.`；`.gitignore` 覆盖 R9 要求的项；`LICENSE` 存在；`packageManager` 与运行的 pnpm 版本一致（12.11.2）。

本轮阻塞级：0 条。

## 第 2 轮（2026-10-16）— 范围：272a63d..db008b2 — 未做独立评审

原因：连续三次新开评审者均在读取工件阶段被 API 以 HTTP 400（"缺少必需参数或包含不允许的参数"）终止，没有产出任何结论，也没有向本文件写入任何内容。三次分别是 haiku、sonnet、haiku，第 1 轮以同样方式开启则成功，失败原因未查清。

不用本会话的自评顶替。第 1 轮之后的修复（提交 `e02e242`、`db008b2`）目前只有实现者自己的验证：对 `scripts/check.sh` 的 14 项变异（13 项被抓住，1 项为等价变异）、Node 24 与 Node 22.19.0 干净检出上的完整运行。这些不是独立评审。

待办：由用户另起会话，按 `.agents/skills/aisdlc/references/review.md` 评审上述增量，或在新会话里重试；结果追加到本文件。在此之前，第 1 轮的 3 条"重要"发现只有实现者自证已消失。

后续（实现者补记）：此后又新开两次，同样失败（共五次）。对照测试（只读同一批文件的小任务，分段、重跑）显示失败与内容无关：同一条命令有时通过有时被拒，连不读任何文件的首次请求也会失败，判断为网关随机返回 HTTP 400，约五分之一的请求受影响。评审要连续发十几次请求，整轮跑完的概率很低。改为在失败后恢复同一个评审者（已有进展保留），共恢复 5 次后在第 3 轮完成。

## 第 3 轮（2026-10-16）— 范围：272a63d..db008b2 — 执行：独立评审 subagent（空上下文，只读，临时副本在 tmp/review3/）

> 更正（实现者）：评审者在初稿里把本轮写成"本会话执行，不是新开的空上下文 subagent，独立性弱于 aisdlc 要求"，与事实不符。本轮由实现者新开的空上下文 subagent 执行，只收到填好的评审提示词；因网关随机 400 被恢复 5 次，恢复时实现者只发了"继续"一类的指令，没有传达任何对实现的判断。除这一处更正外，本节发现与核对结论均为评审者原文。

| 级别 | 位置 | 发现 | 处理 |
| ---- | ---- | ---- | ---- |
| 重要 | `scripts/check.sh:61-63`（`selfcheck` 步骤） | 自检不覆盖 `selfcheck` 这一步本身。临时副本里把 `selfcheck` 改为 `selfcheck \|\| true`，selfcheck 仍输出"自检通过"。R4 字面是"任一步骤"，spec Proof R4 也未豁免。自检无法自证自己的调用，需要 CI 或脚本外的机制兜住，或在 spec 中写明豁免。待确认：是否接受豁免。 | 接受为豁免（用户同意）：自检以 `CHECK_ROOT` 驱动 `check.sh`，该路径必须跳过自检以避免递归，脚本无法检验自己对自检的调用。已写入 spec Proof R4 的例外，plan Deviations 同步记录，由 PR 上的人工评审兜底 |
| 建议 | `scripts/check.sh:61` | `CHECK_ROOT` 只要在环境中被导出，整个检查就静默跳过自检，并且把 ROOT 指向别处运行。CI 与本地目前都未设置它（已核对），风险低，但缺少提示。 | 已修：设置了 `CHECK_ROOT` 时 `check.sh` 打印"已设置 CHECK_ROOT，跳过检查脚本自检" |
| 建议 | `scripts/check.sh`（参数处理已删） | 去掉 `case "$1"` 后，`scripts/check.sh --tests-only` 等旧参数被静默忽略并执行全量检查，不再报"未知参数"。仓库内已无引用（`git grep` 只剩 plan.md 与本文件的历史说明）。 | 不处理：仓库内无引用，这些参数本是实现过程中的临时产物，不做兼容。已记入 plan Deviations |
| 建议 | `tests/check/selfcheck.sh:7-9` | `WORK="$(mktemp -d)"` 失败时 `WORK` 为空，后续路径会变成 `/ok`、`/install` 等仓库外绝对路径，`mkdir -p` 与 `ln -s` 会在根目录下写入。概率极低（mktemp 基本不会失败），待确认是否值得加 `[[ -n "$WORK" ]] \|\| exit 2`。 | 已修：`mktemp -d` 失败时自检打印原因并以退出码 2 退出，不再继续使用空路径 |
| 待确认 | `.github/workflows/ci.yml:25` | `corepack enable` 在 GitHub 托管 ubuntu runner 上是否可写入 node 的 bin 目录，以及 setup-node 22.19.0 下的 pnpm 解析，本地无法验证，需 PR 上的 CI 日志确认（与第 1 轮待确认一致，仍未结）。 | 推迟：需骨架 PR 的 CI 日志才能确认，plan 步骤 7 执行 |

### 上轮发现的核对结论（本轮自行复现）

- 第 1 轮"重要" `scripts/check.sh:61`（`typecheck` 无 `\|\| true` 检测）：**已消失**。逐步骤加 `\|\| true` 的变异共 7 项（precheck、install、typecheck、lint、test、build、aisdlc），其中 install、typecheck、lint、test、build、aisdlc 6 项自检均变红；precheck 为等价变异（`die` 直接 `exit`，已在第 1 轮记录）；selfcheck 见本轮"重要"。
- 第 1 轮"重要" `tests/check/selfcheck.sh:64`（漂移断言 needle 为空）：**已消失**。安装命令加无关参数 `--no-such-flag` 后，自检变红（install 项报缺少 `ERR_PNPM_OUTDATED_LOCKFILE`）。真实漂移下 pnpm 12 输出该错误码（已实测，退出码非零）；加 `--offline` 的变异仍被判为通过，这是正确的（失败原因确为漂移）。`--frozen-lockfile` 被去掉时自检变红。
- 第 1 轮"重要" README/前置检查/CI 对 corepack 的说明：**已消失（三者一致）**。README:13、16；check.sh:20 提示；ci.yml:25 均指向 `corepack enable`。仅有 node、corepack 时 `check.sh` 报"缺少前置工具：pnpm"，exit 1。CI 上的实际表现见本轮"待确认"。
- 第 1 轮"建议" `scripts/check.sh:41` 零测试 find 范围：**已消失**。扫描已收窄到 `packages/`，selfcheck 的 notests 用例在根目录放 `stray.test.ts`，仍被判为失败。
- 第 1 轮"建议" spec Risks 与 R10 补充：**已处理**（spec.md 的 Risks 与 R10 已含 `scripts/`、`tests/check/`、`ci.yml` 与批准规则）。
- 第 1 轮"建议" R10 必需检查前提：**已处理**（spec.md R10 已写明）。
- 第 1 轮"建议" pnpm store 位置：**部分处理，未变**。自检已设 `pnpm_config_store_dir`；主脚本在本机仍把 store 写到 `~/projects/.pnpm-store`（仓库外），仓库内未钉死 `storeDir`，交用户决定。本轮 `git status` 干净，未产生仓库内 store。
- 第 1 轮"待确认" CI 未运行：**仍待确认**，需骨架 PR 的 CI 日志。

### 本轮核对的其他项（无发现）

- 第 5 项：`scripts/check.sh` 全量运行（`pnpm_config_store_dir` 已按要求设置）退出 0，约 5.6 秒，八个步骤均执行，selfcheck 通过。运行后 `git status` 干净。结果可信。
- 第 4 项受限 PATH：缺 python3、缺 pnpm、缺 node 三个用例的断言字样只能由前置检查的 `die` 输出，前置检查先于任何外部步骤执行，因此不会被其他原因误判为通过。临时目录位于 `mktemp -d`，`trap` 清理；自检期间的 pnpm 调用只使用 `WORK` 下的 store 与夹具，未触碰仓库与仓库外的真实目录（上面 `mktemp` 的边界情况除外）。
- 第 6 项：`find` 收窄、参数删除、corepack 步骤的回归检查见上表；未发现新的功能回归。

本轮阻塞级：0 条。本轮重要级：1 条（待确认是否豁免）。本轮建议级：3 条。

## CI 首次运行（实现者补记，非评审）

骨架 PR 的首次 CI 失败（作业 `check`，9 秒）：`Cannot find module .../corepack/v1/pnpm/12.11.2/bin/pnpm.cjs`。第 1、3 轮把“CI 上的 corepack 行为”都列为待确认，结论是评审标对了：这是真实缺陷。

- 原因：Node 22.19.0 自带 corepack 0.34.0，装不了 pnpm 12；corepack ≥0.34.5 才行。另外 Node 25 起官方不再随发行包提供 corepack，而 `engines.node` 的范围包含 Node 25、26。
- 本地为什么没发现：本机 corepack 缓存里已有 Node 24 自带的新版 corepack 装好的 pnpm。**第 1 轮“处理”列里“在 Node 22.19.0 干净环境验证”的说法因此不成立**，那次验证并不干净。
- 处理（与本节同一次提交）：去掉对 corepack 的依赖，改为 pnpm ≥10 按 `packageManager` 自动切换；前置检查新增“pnpm 实际版本等于锁定版本”的核对，自检新增用例并通过变异验证（删掉核对后新用例变红）。依据与实测矩阵见 plan Deviations。
- 验证方式：在“Node 22.19.0、PATH 无 corepack、pnpm 10 引导、全新 HOME、空依赖仓库”的环境里完整跑通 `scripts/check.sh`；CI 里那一行命令经 YAML 解析器取出后原样执行通过。最终以修复提交上 CI 的真实结果为准，见 PR。
- 这次修复没有再做独立评审：评审者的调用被网关随机 400 反复打断（见第 2 轮的补记），经 bluezeamer 同意，这次不做独立评审，改以上述实测和 CI 结果作为验证。需要时由人评审该提交。

### CI 结果与 R7 反向验证

- 修复后 PR #1 的 CI 通过（作业 `check`，16 秒）。日志逐步骤核对：前置检查、安装（39 个包）、类型检查、lint、测试（两个包各 1 条）、检查脚本自检（12 项全绿）、构建、aisdlc 校验均实际执行并通过。至此第 1、3 轮的两项“待确认”（runner 上的 python3 与 pnpm、setup-node 22.19.0 下的行为）确认无问题。
- R7 变异验证：草稿 PR #2（目标分支为骨架分支）在占位模块里引入 `string` 赋给 `number` 的类型错误，CI 在“类型检查”一步变红（`TS2322`），之后的步骤未执行。验证后已关闭 PR 并删除分支，未合并。
- 未做：R8 的 CI 变异（让某个 intent 的 `Status` 与所在目录不一致，作业必须变红）没有在 CI 上做，本地自检的 `aisdlc` 用例覆盖同类情形，不再单开临时 PR。

## 合并后动作（R10）

PR #1 以 squash 方式合并为 `74e5b75`，`main` 上随后触发的 CI 通过。

主干保护：用户在 GitHub 建了 ruleset `protect-main`（ID 25245509，选 ruleset 而非经典分支保护：同一分支可叠加多条、任何有读权限的人可查看、可用只读 API 核对）。agent 用只读 API 逐项核对：

- 生效状态 `active`；绕过名单 `bypass_actors` 为空，即管理员同样受限；目标为默认分支（`main`）。
- 规则：`deletion`（禁止删除）、`non_fast_forward`（禁止强推）、`pull_request`（必须走 PR，批准数 0）、`required_status_checks`（必需检查 `check`，来源 ID 15368，已核对为 GitHub Actions；未要求分支为最新）。
- 经典分支保护不存在（查询返回 404），没有叠加其他规则。

负向验证：agent 从 `main` 切出一次性分支，提交一个空提交，执行 `git push origin HEAD:main`，推送被拒：`GH013: Repository rule violations found for refs/heads/main`，原因两条——`Changes must be made through a pull request.` 与 `Required status check "check" is expected.`。该推送使用的账号对仓库有 `admin=true` 权限，因此“对管理员同样生效”得到实证。验证后远程 `main` 仍为 `74e5b75`，一次性分支已删除。

未验证（只记录，不阻塞关闭）：
- 规则里网页默认带上的参数 `require_extra_approval_for_unattributed_changes: true` 含义未查明；批准数为 0，推测无影响，本次关闭用的 PR 是该规则生效后的第一个 PR，合并时会暴露。
- 禁止删除与禁止强推只核对了规则配置，没有实际尝试：失败时后果是删除或改写 `main`，不值得以此冒险。

R1–R10 的证明均已具备，除上面列出的“未做”与“未验证”外。
