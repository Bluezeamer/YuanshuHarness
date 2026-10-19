# ADR-0030: 权限规则：动作分类、判定顺序、记住粒度与 bash 解析

状态：已定稿
日期：2026-10-18
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」；ROADMAP 第 5 条

## 背景
[ADR-0006](0006-permission-tiers.md) 定了三档与出厂规则的意图，但留下具体口径：规则的数据形状、“通过并记住”存什么、bash 如何解析、拦截点在哪。记住的规则会写进用户数据，判定口径错了会静默放行或误拦，所以难逆。

## 候选方案
### 拦截点
- A. 经 pi 的扩展 `tool_call` 事件（可返回 `block`），由 Server 在创建会话时注入扩展工厂。公开接口，不 fork（[ADR-0001](0001-pi-sdk-no-fork.md)）。
- B. 包装每个工具。代价：重复实现、易漏新工具。

### 记住的粒度
- A. 文件类记目录、命令记完整命令行（本期选）。最保守，不会放行命令变体。
- B. 命令按前缀。代价：`git status` 之后 `git status; rm -rf x` 之类变体需额外防御。

### bash 解析
- A. tree-sitter-bash（本期选，遵循 [ADR-0006](0006-permission-tiers.md)）。接入用 `web-tree-sitter` 加 tree-sitter-bash 包自带的 `.wasm`，不带原生编译，不挑平台（含 musl 镜像）。代价：新增两个 MIT 依赖，运行时加载 wasm。
- B. 手写分词器。偏离 ADR-0006，已否决。

## 决定
拦截点 A，粒度 A，解析 A（依赖版本按精确版本锁定）。

**数据**（迁移 v4）：`permission_rules(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, kind TEXT NOT NULL, access TEXT, value TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id, kind, access, value))`。`kind=path` 时 `access` 取 `read`/`write`，`value` 为绝对目录（含其子树）；`kind=command` 时 `access` 为空，`value` 为规范化后的完整命令行。
REST：`GET /api/v1/workspaces/:id/rules`、`DELETE /api/v1/workspaces/:id/rules/:ruleId`；规则只经审批弹窗的“通过并记住”产生。

**动作分类**（来自 `tool_call` 事件）
- `read`/`grep`/`find`/`ls` 为读，`edit`/`write` 为写，目标取输入的 `path`（缺省为 workspace 的 cwd）；`grep` 的 `glob`、`find` 的 `pattern` 另作为“文件选择器”参与判定；`bash`/`powershell` 为命令；`ask_user` 恒放行；其余工具（含 MCP）视为规则外。路径相对 cwd 解析并解析符号链接（对尚不存在的路径取最近的已存在祖先），符号链接指向 cwd 外按 cwd 外处理。

**判定顺序**（纯函数，返回 `allow` / `ask`，`ask` 附是否可记住）
1. 档位 `full`：放行。
2. 敏感路径（任一目标命中）：`ask`，且**不可记住**，不吃任何放行规则。清单：路径任一段为 `.env`、`.env.*`、`.ssh`、`.aws`、`.kube`、`.gnupg`，或文件名为 `.npmrc`、`.netrc`、`id_rsa*`、`id_ed25519*`、`*.pem`、`*.key`。bash 命令里任一词命中同样处理（含 `--opt=值`、`-f值` 这类附值：等号后部分与短选项的各后缀都检查；花括号展开超过 64 个结果或词超过 4096 字符时无法逐个确认，按敏感处理；名字比较大小写折叠）。文件选择器同样检查（纯 `*` 段不单独算，免得 `**/*.ts` 永远被拦），可能命中清单即 `ask` 且不可记住；选择器为绝对路径、`~` 或含 `..` 段按规则外处理。
3. 路径动作：目标在 cwd 内放行；命中已记住的同类（读规则只放行读，写规则放行读写）目录规则放行。
4. 命令动作：整条命令是出厂只读白名单的纯词连接**且每个非选项词（路径操作数）按相对 cwd 解析（含符号链接）后仍在 cwd 内**，或与已记住的命令行完全相等，放行。出了 cwd、无法解析、或含 `/` 的选项词（如 `--files0-from=/x`）则不自动放行，转规则外（可按原规则记住）。保守取舍：`grep /etc x` 这类疑似路径的词也会因此被审批。这是对 Codex 旧版的收窄：Codex 的只读白名单没有目录边界。
5. 其余为规则外：档位 `rules` 弹审批；档位 `auto` 交审核模型（见 [ADR-0031](0031-auto-review.md)）；无审核方时同 `rules`。

**出厂只读白名单与解析**：以 Codex 旧版只读命令判定（`is_safe_command` 一类）与 shell 解析（只接受纯词命令的 `&&`、`||`、`;`、`|` 连接）为蓝本翻译为 TypeScript，按 Apache-2.0 署名：附许可证副本、NOTICE 注明来源、标注修改过的文件（见 ADR-0006）。具体命令清单以移植时的 Codex 版本为准并写入 spec 的 Proof。
**纯词连接**：词为裸字、单引号串或不含展开的双引号串；出现重定向、子 shell、命令替换、变量展开、后台符、换行、解析树含 ERROR 节点或其他无法确定的构造，整条不放行。

**记住**：审批选项为 `allow`（仅此次）、`deny`、`remember`（仅在可记住时提供）。路径动作记住的是目标所在目录（文件取其父目录，目标本身是目录则取它）；命令动作记住规范化命令行（词之间单空格）。首词（按 basename 归一化，`/usr/bin/sudo` 等同 `sudo`）为 `sh bash zsh dash ksh fish env sudo su doas eval exec xargs nohup` 的命令、含 `sudo` 的命令，以及无法解析的命令**不可记住**。
被拒绝（含超时、撤销）时，工具调用以 `block` 返回，`reason` 说明原因并回给 agent；`tool_call` 处理中的任何异常一律按拒绝处理。

## 理由
- 在官方扩展点拦截，覆盖所有走 `tool_call` 的工具，新工具默认落入“规则外”而不是被放行。
- 无法确定即不放行，使解析器的缺陷只会多弹窗，不会漏拦；用 tree-sitter 而非手写分词，避免引号、转义等边角的自制解析缺陷。
- 命令按完整命令行记，没有变体放行的静默风险；代价只是多点几次“记住”。
- 敏感路径不可记住，避免一次手滑把凭据目录永久放行。

## 影响
- 迁移 v4 建 `permission_rules`；规则随 workspace 删除级联删除。
- 实现时须验证 SDK 1.3.0 各工具 `path` 字段名与 `tool_call` 的阻断时序（契约测试）。
- git 自动放行收窄为 `rev-parse`、`ls-files` 与 `branch` 的只读用法，去掉 `status diff blame log show`：仓库配置可触发 fsmonitor、外部 diff 等外部程序。这是对 Codex 旧版清单的收窄；这些命令仍可经审批执行或记住。
- 白名单与敏感清单是代码常量，改动要在 spec 与测试里同步；新增 `web-tree-sitter` 与 `tree-sitter-bash`，仓库需新增 LICENSE 副本与 NOTICE。
- 只读白名单去掉了 `printenv`：Pi SDK 的 bash 工具把整个 `process.env` 交给子进程，Server 的 `YUANSHU_TOKEN` 等变量因此能被命令读出（`env`、`echo $X` 本就不在放行内，仍须审批）。
- **已知限制（环境变量）**：经审批放行的命令（或 `full` 档）仍可读到 Server 进程环境里的 `YUANSHU_*`。SDK 虽公开了 `spawnHook`（`createBashTool` 选项）和用同名 `customTools` 覆盖内置 bash 的做法，但本仓库尚无真实会话工厂（随第 7 条接入），且用户 `!` 命令走另一条执行路径，本期不做精简环境，也不 fork 或猴补 SDK；待工厂落地时再接。
- **已知限制（竞态）**：权限检查与 SDK 实际执行之间存在时间窗，期间把检查过的路径换成指向 cwd 外的符号链接，SDK 仍会按原路径操作。本期不处理（需 fd/openat 语义或 SDK 配合）。
- 模式（plan 等）与 subagent 继承不在本期。
- 排除：手写分词器；命令前缀规则；agent 自行写规则。
