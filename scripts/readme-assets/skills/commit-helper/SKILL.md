---
name: commit-helper
description: 按 Conventional Commits 整理改动并生成提交信息；提交前检查暂存区与关键路径。
---

# 提交助手

用户要求「提交」「写 commit message」「整理一下提交」时使用。

## 步骤

1. 运行 `scripts/check-staged.sh`，看清暂存区里有什么、有没有遗漏的文件。
2. 语义不内聚的改动拆成多个提交；同一批互相依赖的文件放进同一个提交。
3. 提交信息写成 `<type>(<scope>): <description>`：
   - `type` 取 `feat` `fix` `docs` `refactor` `test` `chore` `ci` `build` 之一（见 `references/types.md`）；
   - `description` 用英文祈使句，不超过 72 个字符。
4. 破坏性变更在 `type` 后加 `!`，并在正文末尾写 `BREAKING CHANGE:` 说明。

## 不要做

- 不 push，不改写已经存在的历史。
- 不把无关的格式化改动混进同一个提交。
- 提交信息里不写密钥、内部地址等敏感信息。
