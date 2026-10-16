# Spec: <变更标题>
Author: <起草者（人或 agent）>
Status: draft | accepted | closed
Date: YYYY-MM-DD

> 写成 delta：只写本次变更相对既有约定新增或改变了什么。ARCHITECTURE / ADR 已讲过的内容只链接，不复述。
> 本文件只在 Requirements 变化时修改；评审发现写进 review.md。

## Links
来源: [intent.md](intent.md)
上游: <约束本变更的 ARCHITECTURE 条款 / ADR（链接）>
下游: <plan.md / PR>

## Requirements
R1. <可验证的一条。涉及不变量时用"必须 / 不得"句式>
R2. <……>

## Proof
| 需求 | 证明（测试名 / 命令 / 截图） | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | <……> | 是（入口不存在）/ 变异验证：<去掉什么保护后必须变红> / 不适用 |

## Design
<仅当引入新设计时写；沿用既有架构的部分只链接。决策档须包含迁移与兼容策略。没有就删掉本节>

## Risks
<已知风险与取舍理由；无则写"无">
