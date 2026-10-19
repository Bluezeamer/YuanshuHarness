# Spec: 权限规则与一档审批
Author: bluezeamer
Status: accepted
Date: 2026-10-18

> 判定口径见 [ADR-0030](../../../genesis/adr/0030-permission-rules.md)，此处只写可验证需求。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0030](../../../genesis/adr/0030-permission-rules.md)、[ADR-0006](../../../genesis/adr/0006-permission-tiers.md)、[ADR-0028](../../../genesis/adr/0028-prompt-wire-protocol.md)
下游: [plan.md](plan.md)

## Requirements
R1. 迁移 v4 建 `permission_rules`；删除 workspace 级联删除其规则；唯一约束防重复。
R2. 判定函数 `decide(action, ctx)` 为纯函数（路径已解析、规则与档位由调用方传入），按 ADR-0030 顺序返回 `allow` 或 `ask`（带 `rememberable` 与可记住的规则）。
R3. 档位 `full` 放行一切；`rules`/`auto` 下 cwd 内读写放行，cwd 外、符号链接逃出 cwd 的路径为规则外。
R4. 敏感路径（清单见 ADR）在任何档位下除 `full` 外都必须 `ask` 且不可记住；已记住的目录规则不得放行敏感路径；bash 命令里的敏感词同样处理（含 `--opt=值`、`-f值` 附值、大小写折叠、花括号展开超限按敏感）；`grep` 的 `glob`、`find` 的 `pattern` 同样做敏感与 cwd 边界检查。
R5. 只读白名单：纯词连接、每段在白名单内、且每个非选项词按相对 cwd 解析（含符号链接）后仍在 cwd 内才放行（出界或无法解析转规则外审批，这是对 Codex 旧版的收窄）；含重定向、`$`、反引号、子 shell、后台符、换行、被拒选项（如 `find -exec`、`git --output`）的命令不放行；解析不确定不放行。
R6. 规则外动作发审批弹窗（source `approval`）；选项 `allow`/`deny`/`remember`（仅可记住时提供）；`remember` 写入规则，后续同类动作放行（读规则只放行读，写规则放行读写；命令规则仅完全相等）。
R7. 首词（按 basename 归一化）为 `sh bash zsh dash ksh fish env sudo su doas eval exec xargs nohup`、含 `sudo`、无法解析的命令不可记住。
R8. 拒绝、超时、撤销、`tool_call` 处理内异常都以 `block` 返回，`reason` 回给 agent；绝不放行。
R9. 档位改动对运行中会话下一次工具调用即时生效；`auto` 且无审核方时行为同 `rules`。
R10. `ask_user` 不触发审批；其余未知工具（含自定义/MCP）视为规则外。
R11. REST：`GET /workspaces/:id/rules`、`DELETE /workspaces/:id/rules/:ruleId`（不存在 404）。
R12. WebUI：审批弹窗展示工具、目标/命令摘要与三个选项；设置里可查看与删除规则，可改档位。
R13. 既有测试不变；契约测试覆盖 SDK 工具 `path` 字段与阻断时序。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R2–R5、R7 | 表驱动单测（路径含 `..`、符号链接、敏感、变体命令） | 变异：去掉敏感优先、去掉符号链接解析、放宽白名单，各自必须变红 |
| R5 清单 | 移植自 Codex 提交 `1b450c79`（`is_safe_command.rs`、`bash.rs`），`bash.test.ts` 表驱动覆盖 | 同上 |

R5 实际清单摘要（`src/permission/bash.ts`）：
- 无参数限制：`cat cd cut echo expr false grep head id ls nl paste pwd rev seq stat tail tr true uname uniq wc which whoami`，Linux 另有 `numfmt tac`（以上同 Codex）。本项目额外：`date df du file sort basename dirname realpath readlink`（`printenv` 已移除：会读出环境里的令牌）。
- `base64`：拒 `-o`、`--output`、`--output=…`、`-oFILE`。
- `find`：拒 `-exec -execdir -ok -okdir -delete -fls -fprint -fprint0 -fprintf`。
- `rg`：拒 `--pre`、`--hostname-bin`（含 `=值`）、`--search-zip`、`-z`；本项目更严，前缀匹配并拒含 `z` 的合并短选项。
- `sed`：仅 `sed -n N[,M]p [文件]`。
- `git`：仅 `rev-parse`、`ls-files` 与 `branch` 的只读用法。已取消 `status diff blame log show` 的自动放行，这是对 Codex 旧版（`1b450c79`）的收窄，原因：仓库配置可触发 fsmonitor、外部 diff 等外部程序；拒 `--output --ext-diff --textconv --exec*`（含 `--exec-path`）、`-c`、`--config*`、`-O`/`--open-files-in-pager`，以及任何前置全局选项（`-C -p --git-dir --work-tree --namespace --paginate` 等）；`git branch` 仅接受 `--list -l --show-current -a --all -r --remotes -v -vv --verbose --format=…`。
- `sort`：拒 `-o`、`--output`、`--compress-program`、`-T`、`--temporary-directory`（含合并短选项与长选项缩写）；`date`：拒 `-s`、`--set`。
- 解析：只认纯词经 `&& || ; |` 连接；词内含 glob、花括号、`~`、`=` 开头、`$`、反引号、反斜杠一律不放行。
| R6、R8 | 对着 stub 模型：工具调用弹审批，allow 执行、deny 返回 reason、超时/stop 拒绝；remember 后第二次不弹 | 变异：超时当通过，必须变红 |
| R9、R10 | 改档位后再调用；`ask_user` 无审批 | 是 |
| R1、R11 | 迁移与 REST 测试 | 是 |
| R12 | web 组件测试；浏览器验证 | 不适用 |
| R13 | `scripts/check.sh`；契约测试 | 不适用 |

## Design
`src/permission/{decide,bash,paths}.ts`（`bash.ts` 用 web-tree-sitter 加 tree-sitter-bash 的 wasm 解析；白名单移植自 Codex 并署名，新增 LICENSE 副本与 NOTICE）、`src/permission/extension.ts`（`tool_call` 扩展，经池的 `ask` 发弹窗，读取 workspace 档位与规则）、`src/store/rules.ts`；池创建会话时把权限扩展与 `ask_user` 一并交给工厂。无存量数据迁移（新表）。

## Risks
解析用 tree-sitter-bash，只放行纯词连接的保守子集；不识别的构造一律不放行，代价是多弹窗。
