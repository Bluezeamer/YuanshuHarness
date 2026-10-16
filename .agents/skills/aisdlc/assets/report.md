# 快车道报告：<通道名> <YYYY-MM-DD>
Branch: <分支>　Range: <base 起点 sha>..<HEAD sha>

## 机械层（命令或脚本生成，不经模型）
- commits：粘贴 `git log --oneline <base>..HEAD`
- 文件分布：粘贴 `git diff --stat <base>...HEAD`
- 章程越线检查：通过 / 未通过（附清单）
- 必过检查：<命令> → 通过 / 未通过
- 截图：<视觉改动的前后对比；无则写"无">

## 叙述层（agent 归纳）
### <主题 1>
<改了什么、为什么；对应哪几个 commit>

## 复核层（新开的空上下文 subagent，对照实际 diff）
<叙述与机械层是否一致；抽查了哪几个 commit；一行结论。协议见 references/review.md>
