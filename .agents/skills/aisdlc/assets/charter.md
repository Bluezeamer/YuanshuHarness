# 快车道章程：<通道名>
Owner: <负责人，一条通道一个人>
Status: draft | approved
Approved: <YYYY-MM-DD 批准人>

> 放在 `docs/lanes/<lane>/charter.md`。章程由人批准一次并合入主干；之后每个 MR 是否合规，由 CI 对照**主干上的章程**判定，不靠口头争论。
> 章程文件本身永远在黑名单里：改章程必须走正规流程。

## 目的
<一句话：本通道处理哪一类改动>

## 准入（机器可读）
本节第一个 `toml` 代码块由 CI 脚本读取（格式见 `references/automation.md`）；注释写明每项的取舍。

```toml
lane = "<lane>"
# 只圈纯展示代码；会写入、删除数据的模块，即使放在展示层目录里也不要圈进来
# （本通道自己的 docs/lanes/<lane>/reports/ 由脚本自动放行，且不计入体量上限，无需写进 allow）
allow = ["<glob>"]
# 至少包含宏观文档，以及所有承载契约的文件（数据 schema、类型定义、通信协议、消息格式）
deny = ["docs/genesis/**", "<契约文件 glob>"]
max_files = 15   # 单个 MR 的文件数上限
max_lines = 400  # 单个 MR 的改动行数上限（新增 + 删除）
checks = ["<lint 命令>", "<既有回归套件命令>"]   # 必过检查，由 CI 逐条执行
```

## 升级规则
越过上述任一条 → 停下，转标准档，写正规 intent。已做的 commit 保留，不推倒重来。

## 工作约定
- 分支：`lane/<lane>`；每天 rebase 主线
- 每个小改动一个 commit（Conventional Commits），脚注写 `Source: <需求来源>`
- 行为 bug：先写失败测试，再修
- 开 MR 的节奏：满 <N> 个 commit 或满一周
- MR 附汇总报告，存 `docs/lanes/<lane>/reports/<YYMMDD>.md`
