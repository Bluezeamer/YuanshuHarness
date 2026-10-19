# Review: 权限规则
Date: 2026-10-18

## 第一轮（整体实现，权限绕过 / 弹窗竞争 / 自动审核 / 迁移 / Proof）
Reviewer: codex exec（只读沙箱，空上下文）
Date: 2026-10-18

### 阻塞
1. paths.ts:13 悬空符号链接被当作 cwd 内的词法路径放行，实际写到外部。**处理**：悬空、循环、解析失败一律返回 null 按 cwd 外处理；补回归测试。
2. bash.ts uniq 第二个位置参数是输出文件，可覆盖外部文件。**处理**：限制为至多一个位置参数；补回归测试。
3. bash.ts 敏感词检查不覆盖 `.env*`、`bash -c 'cat .env'`。**处理**：通配符词保守匹配；bash/sh/zsh -c 与 eval 递归一层，无法分析则不放行且不可记住。

### 重要
1. bash.ts git 只读子命令可触发 fsmonitor、外部 diff 等外部程序。**处理**：自动放行去掉 git status/diff/blame/log/show，ADR-0030 与 spec 注明对 Codex 旧版的收窄原因。

### 建议
无。


## 第二轮（核对首轮 + 增量对抗性审查）
Reviewer: codex exec（只读沙箱，空上下文；未能执行测试，仅静态核对）
Date: 2026-10-18

首轮阻塞/重要项逐条核实均已消失。

### 阻塞
1. extension.ts:86 `grep/find` 的 `glob/pattern` 可选中敏感文件，权限层只看 `path`。**处理**：采纳。glob/pattern 做敏感与 cwd 边界检查，纯 `*` 段不算敏感。
2. bash.ts:231 只读白名单无 cwd 边界（`cat /etc/hosts`）。**处理**：采纳。路径操作数出界或解析失败转规则外审批（可记住）；对 Codex 旧版的收窄已写入 ADR-0030 与 spec。
3. bash.ts:170 `printenv YUANSHU_TOKEN` 泄露令牌。**处理**：部分采纳。移除 `printenv`；其余经审批放行的命令与 `full` 档仍能读到环境，记为 ADR-0030 已知限制，待第 7 条会话工厂落地后用 SDK 的 `spawnHook` 精简环境，本期不 fork、不猴补。
4. paths.ts:128 `--file=.env`、`-f.env` 绕过敏感词。**处理**：采纳。新增选项附值检查。

### 重要
1. bash.ts:310 绝对路径首词（`/bin/bash`、`/usr/bin/sudo`）绕过“不可记住”与 sudo 判断。**处理**：采纳，按 basename 归一化。
2. bash.ts:231 `sort -T` 可写外部目录。**处理**：采纳，拒绝 `-T` 及其长选项与合并写法。
3. paths.ts:116 花括号展开超过 64 个分支后漏掉敏感名。**处理**：采纳，超限按敏感处理。
4. paths.ts:116 花括号嵌套的指数级 CPU。**处理**：采纳但判为低风险（需 agent 构造恶意 glob）。已在递归中限额；不再追加。
5. paths.ts:42 敏感名区分大小写。**处理**：采纳但判为低风险（仅大小写不敏感文件系统有影响）。已折叠大小写；不再追加。
6. paths.ts:10 检查与执行之间的符号链接 TOCTOU。**处理**：不采纳，记为 ADR-0030 已知限制。利用前提是已有并发进程在 workspace 内改文件系统，该进程本身已有代码执行能力；根治需 fd/openat 语义或 fork SDK（违反 ADR-0001），再检查只是缩小窗口。部署上建议在容器内运行。
