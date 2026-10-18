# AGENTS.md

YuanshuHarness（元枢）：基于 Pi SDK 的常驻 Agent Server。愿景见 [docs/genesis/VISION.md](docs/genesis/VISION.md)，架构快照见 [docs/genesis/ARCHITECTURE.md](docs/genesis/ARCHITECTURE.md)，路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 变更流程（aisdlc）

- 任何要改代码或行为的请求，先调用 `aisdlc` 技能判档，再动手。新项目起步用 `project-genesis`。
- 文档布局：`docs/genesis/`（宏观，慢变量）、`docs/intent/active|done/<YYMMDD>-<slug>/`（变更）、`docs/lanes/<lane>/`（快车道）。
- 链接：变更文件夹内用同目录相对路径；指向宏观文档用 `../../../genesis/...`；不带开头斜杠。
- 评审一律交给新开的、空上下文的 subagent；写代码的 agent 不批准自己的代码。
- `Status` 字段是事实，目录是视图：closed 的变更整夹移入 `done/`。

## 协作原则

- 发现设计不合适，直接指出并建议修改，不要为了守住既有设计或规则而硬套；改动涉及已定契约或 ADR 时，先说明理由再由人决定。

## WebUI 风格

- 写或改 `packages/web` 的任何界面、样式、动效、弹窗，先用 `yuanshu-webui-style` 技能；风格取向是改良版瑞士国际主义，视觉参考见该技能的 `assets/reference.html`。

## 协作文件里的敏感信息

协作文件指git追踪的仓库里的一切，以及 MR 与评论里的文字：`docs/`、intent、spec、review、AGENTS.md、提交信息、MR 描述。

- 不写入：凭据与令牌、内部地址与 IP、个人信息、客户或用户标识、未披露的漏洞细节。
- 需要引用证据（日志、命令输出、监控数据）时，写脱敏后的摘要，加上原件的存放位置，不贴原文。贴之前先过一遍。
- 安全漏洞不在协作文件里描述细节，走私有渠道处理，披露之后再补记录。
- 发现已经写进去了：先告诉人，不要自己悄悄改。只删文件内容不够，git 历史里还在；凭据类视为已泄露，需要轮换。
- 拿不准是不是敏感信息，就当作敏感，问人。
