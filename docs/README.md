# 元枢 Harness · 文档

Author: bluezeamer
Status: 现行
Date: 2026-11-19

这里是元枢的设计文档与部署指南。项目简介见仓库根的 [README](../README.md)，参与方式见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 先读什么

- **想用起来**：[`deployment.md`](deployment.md)（[English](deployment.en.md)）：启动参数、访问控制、Docker、不用 Docker 的装法、手机访问。
- **想理解系统**：[`philosophy.md`](philosophy.md)（最上位的原则）→ [`model/overview.md`](model/overview.md)（前提、不变式、系统结构、状态归属）→ 按主题读 `model/` 里的其他文档。
- **想改代码**：先读仓库根的 [AGENTS.md](../AGENTS.md)，再读 `.agents/skills/` 下对应的 skill，最后读 `model/` 里与你要动的部分相关的设计。

## 文档与 skill 的分工

- **文档回答「系统是什么、为什么这样设计」**：`model/` 是设计的现行真相。
- **skill 回答「怎么写、项目的风格与习惯」**：视觉与交互规范、前端结构、后端分层、手机端、收尾与验收，在仓库根的 `.agents/skills/ys-*`（`ys-ui-design`、`ys-ui-build`、`ys-server`、`ys-mobile`、`ys-delivery`）。skill 可以指向 `model/` 里的设计依据，文档不依赖 skill。
- 判断一条内容归哪边：改了它**只影响写代码的方式**，归 skill；改了它**产品行为变了**，归文档。

## 权威顺序

冲突时以前面的为准：

1. [`philosophy.md`](philosophy.md)：最上位的原则。
2. [`model/`](model/)：现行设计。
3. 代码与守卫：文档与代码不符时以代码为准，并同时改文档；视觉与交互规范与守卫冲突时以守卫为准。

## model/ 目录

按主题一份，从 `overview.md` 读起。每份文档末尾的「未实现与未决」写着还没做的设想与没回答的问题。

- 总览：[`overview.md`](model/overview.md)（前提、不变式、系统结构、状态归属）
- 工作区与界面：[`workspace.md`](model/workspace.md)（工作区模型、会话操作、状态、左轨）；[`layout.md`](model/layout.md)（窗口、窗格、标签与全局壳）；[`chat-tab.md`](model/chat-tab.md)（消息流、右栏、输入栏、审批与提问）；[`chat-render.md`](model/chat-render.md)（代码块卡片、mermaid、内嵌图片）；[`audit.md`](model/audit.md)（模型调用记录与审计页）
- 文件与终端：[`files.md`](model/files.md)（文件、预览、变更推送、git 面板、改动追踪）；[`terminal.md`](model/terminal.md)（终端生命周期）
- 提示词与能力：[`prompt.md`](model/prompt.md)（Agent、模式、卡片、能力求值、权限）；[`prompt-delivery.md`](model/prompt-delivery.md)（接管、冻结物、状态通知、占位工具）
- 子代理与编排：[`subagent.md`](model/subagent.md)、[`team.md`](model/team.md)、[`workflow.md`](model/workflow.md)；[`goal.md`](model/goal.md)（目标：自主续跑、模型自设、轮数上限）
- 画布与插件：[`canvas.md`](model/canvas.md)（灵感画布）、[`plugin.md`](model/plugin.md)（pi 插件兼容）
- agent 浏览器：[`browser.md`](model/browser.md)（页面与操作权、工具、网络与授权、登录态、画面流与回放、部署与镜像）；[`browser-content.md`](model/browser-content.md)（页面内容怎么交给 agent：机械层、辅助模型指针与投影、基线与元素级 diff、只读阅读 agent）
- 服务转发：[`forward.md`](model/forward.md)（把环境里的服务经 Server 的独立端口给用户自己的浏览器用）
- 手机端：[`mobile.md`](model/mobile.md)（`/m/` 第二入口、设备令牌配对、Web Push、回前台重连、PWA 壳）
- 设置页背后的东西：[`provider.md`](model/provider.md)（供应商与模型）、[`remote-connection.md`](model/remote-connection.md)（远程连接）、[`variables.md`](model/variables.md)（隐私变量）、[`skills.md`](model/skills.md)（技能库）、[`mcp.md`](model/mcp.md)（MCP 登记）

**`brand/`**：反白标记与横排 logo（SVG，生成产物；生成脚本是 `scripts/brand/gen.mjs`，运行时用的图标在 `packages/web/public`）。

## 写文档的规则

- **一个事实只写一处**，其余用链接。
- **文档头**写 `Author`、`Status`、`Date`；描述代码现状的文档另加 `Verified: <日期>（对着代码核对：<文件或目录>）`，表示最后一次对着代码核对的时间与范围。`Status` 取：现行、草稿、非权威。
- 设计文档按主题拆，别让一份无限长；没做的设想与没回答的问题集中写在文末的「未实现与未决」，不要散在正文里。
- **不写进度日志与过程叙述**：`git log` 就是日志；文档只写现在的设计和为什么这样设计。
- 不为可逆的选择写决策记录；不做逐功能的 spec / plan。
- 仓库公开：不写凭据、内部地址、个人信息（细则见 [AGENTS.md](../AGENTS.md)）。
