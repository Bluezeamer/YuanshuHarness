# Intent: 目录选择器：按目录新建会话
Author: bluezeamer
Status: accepted
Date: 2026-10-19
Lane: decide
Why: 命中"难逆"——新增对外接口，把本机目录结构暴露给 WebUI，触及授权边界；接口一经发布就是契约。会话与 workspace 契约不变。

## Links
来源: 人工提出（手上测试 ROADMAP 第 5 条时发现手填路径不直观）
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0029](../../../genesis/adr/0029-minimal-workspace.md)、[ADR-0032](../../../genesis/adr/0032-directory-browse-api.md)
下游: [spec.md](spec.md)、[plan.md](plan.md)

## Problem
设置页要手填绝对路径登记 workspace，路径对不对、能不能读写，提交后才知道；默认工作区还是 Server 的启动目录。

## Proposed outcome
新建会话时：选主机（本期只有本机）、逐级展开目录选目标、看到该目录是否可读写、选权限档位、创建会话；未登记的目录自动登记。设置页的新增工作区复用同一选择器。

## Out of scope
文件预览与创建目录；非本机主机（第 6 条）；改变会话与 workspace 的既有接口。

## Constraints
[ADR-0029](../../../genesis/adr/0029-minimal-workspace.md)：登记是授权动作，只经已认证 REST；[yuanshu-webui-style](../../../../.claude/skills/yuanshu-webui-style/SKILL.md) 的视觉规范。

## Decisions needed
- 起点为用户 home、可上溯到 `/`；默认隐藏点目录，可切换；未登记目录默认「规则审批」；不可读写则不允许创建：决定 2026-10-19，bluezeamer 确认。

## Open questions
无
