# AGENTS.md

YuanshuHarness（元枢）：基于 Pi SDK 的常驻 Agent Server。愿景见 [docs/genesis/VISION.md](docs/genesis/VISION.md)，架构快照见 [docs/genesis/ARCHITECTURE.md](docs/genesis/ARCHITECTURE.md)，路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 变更流程（原型期，暂停 aisdlc）

- 第一个可用版本之前**不走 aisdlc**：不写 intent、spec、plan、review.md，不做 Proof 与变异验证，不做多轮独立评审，直接按 ROADMAP 往下做。
- 目标是尽快出可用版本，可用优先于防御：不为低概率场景加固，不追评审里的防御性建议。
- ADR 只作关键决策的 checkpoint：持久化数据形状、对外协议、权限边界、引入新依赖或运行时。短写即可。
- 原型期允许破坏性变更数据目录，不再写迁移与备份；表结构变了就重建数据目录。
- 测试跟着功能走，保持绿即可。重构、抽象、结构梳理放到功能通了之后。
- 已有的 `docs/intent/` 与 ADR 保留作基础，不回头删改。
- 第一个可用版本出来后，再回到 aisdlc 做规范化与约束（`aisdlc` 技能与 `docs/intent|lanes` 布局保留，到时恢复）。
- 评审只在版本出来前做一次整体评审，重点看权限绕过与数据损坏。

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
