# 自动化与 CI

归档变更、生成索引、使用快车道越线检查时读本文件。把这些接入 CI 与平台，见 [wiring.md](wiring.md)。

脚本在本技能的 `scripts/` 下，只用 Python 标准库（≥3.11），不装依赖。运行方式：`python3 -I <脚本> ...`。
三个脚本里，`aisdlc_index.py` 和 `aisdlc_check_lane.py` 要在 CI 里跑，而 CI 只有仓库、没有本技能的目录，所以**使用前把这两个复制到项目的 `scripts/aisdlc/`** 并提交；
本地运行也用这份，保证本地和 CI 跑的是同一个文件。若 aisdlc 本身装在随仓库提交的项目级技能目录里，CI 可直接引用其中的脚本，不必复制。
`aisdlc_archive.py` 只在本地由实现者关闭变更时运行，留在技能目录里调用，不复制。

| 脚本 | 做什么 | 谁调用 |
|---|---|---|
| `aisdlc_archive.py <id>` | 把已关闭的变更整夹从 `active/` 搬到 `done/`，并改写指向它的入向链接 | 变更关闭时，实现者运行 |
| `aisdlc_check_lane.py <章程>` | 对照**主干上的章程**检查分支的改动范围；`--report` 输出报告的机械层 | 快车道分支的 CI |
| `aisdlc_index.py` | 扫描所有变更生成索引；`--check` 校验 Status 与目录一致、链接有效 | CI（每个 MR）|

## aisdlc_archive.py

```
python3 -I <技能目录>/scripts/aisdlc_archive.py <id> [--docs docs] [--dry-run]
```

- `<id>`：`docs/intent/active/` 下的文件夹名，例如 `261013-folder-merge`。
- 前提：该夹里的 `intent.md` 是 `Status: closed`，否则报错退出（状态由人或 agent 在评审通过后改，脚本不替它决定）。
- 动作：整夹搬到 `docs/intent/done/<id>/`（在 git 仓库里用 `git mv`，保留历史）；把 docs 下其他 `.md` 里指向 `active/<id>` 的链接改写为 `done/<id>`；
  最后检查搬走的夹里的链接是否仍然有效。`active/` 与 `done/` 同深度，出向链接不需要改。
- 脚本只改链接，不动内容。`--dry-run` 只打印将做的事。

## aisdlc_check_lane.py

```
python3 -I scripts/aisdlc/aisdlc_check_lane.py docs/lanes/<lane>/charter.md --base origin/main [--head HEAD] [--report]
```

- 章程从 `--base` 上读取（`git show <base>:<路径>`），不读分支自己的版本，所以 MR 无法先改宽白名单再放行自己。
  章程在 base 上不存在，或 `Status` 不是 `approved`，都报错：先把章程合入主干。
- 检查 `git diff --numstat --no-renames <base>...<head>` 的每个文件：必须命中 `allow`、不得命中 `deny`、章程文件本身永远视为命中 `deny`；
  本通道自己的 `docs/lanes/<lane>/reports/`（汇总报告与截图）自动放行，且不计入下面的体量上限，因为提交报告是流程要求；
  文件数 ≤ `max_files`，改动行数（新增 + 删除）≤ `max_lines`。
- 退出码：0 通过；1 越线（逐条列出，并提示"升级为正规 intent"）；2 章程缺失或格式错误。
- `--report`：额外输出 Markdown 的机械层（commit 列表、diffstat、检查结果），可直接贴进 [assets/report.md](../assets/report.md)。`checks` 里的命令由 CI 自己跑，脚本不执行。

### 章程里的机器可读部分

脚本读取章程中**第一个** ` ```toml ` 代码块，字段如下（`glob` 支持 `*`、`**`、`?`，路径相对仓库根）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `lane` | 字符串 | 通道名，必须与章程所在目录名一致（防止复制章程时忘改）|
| `allow` | 字符串数组 | 允许改动的路径 |
| `deny` | 字符串数组 | 禁止改动的路径（优先于 `allow`）|
| `max_files` | 整数 | 单个 MR 的文件数上限 |
| `max_lines` | 整数 | 单个 MR 的改动行数上限 |
| `checks` | 字符串数组 | 必过检查命令，由 CI 逐条执行（脚本只列出，不执行）|

## aisdlc_index.py

```
python3 -I scripts/aisdlc/aisdlc_index.py [--docs docs] [--out INDEX.md] [--check]
```

- 扫描 `docs/intent/active/*/intent.md` 与 `done/*/intent.md`（读标题、`Status`、`Lane`、`Date`）以及 `docs/lanes/*/reports/*.md`，生成 open / done 两张表。不指定 `--out` 就打印到标准输出。
- `--check`：校验并以退出码 1 报告问题——`done/` 里的变更必须是 `closed`、`active/` 里的不得是 `closed`；`intent/active`、`intent/done`、`lanes` 下所有 `.md` 的相对链接必须能解析到真实文件，且不得以 `/` 开头。代码块和行内代码里的示例链接不算。
  只扫这三处，所以旧布局的存量文档（并列的 `intent/`、`spec/`、`plan/` 里的文件）不会被误报。
- 索引是**派生物**，由 CI 生成并作为产物保存，不进人工提交——多人同时改一个状态文件会冲突，每个变更文件夹各改各的则不会。
