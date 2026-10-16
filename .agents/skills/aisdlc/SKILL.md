---
name: aisdlc
description: AI-native 变更循环的入口与判档器。项目已有宏观设计文档（VISION/ARCHITECTURE/ROADMAP/ADR，由 project-genesis 产出）之后，只要用户提出要改动代码或行为的请求——新功能、需求变更、bug、UI/手感调整、重构、性能优化、用户反馈或监控告警回流——就先用本技能判档（决策档 / 标准档 / 快车道），再按档位产出 intent、spec、plan 或走快车道，并安排独立评审。即使用户没提 aisdlc、intent、spec，只说"加个功能""这里有 bug""调一下样式"，也应使用。纯问答、只读代码、从零起新项目（用 project-genesis）时不用。
---
# aisdlc：按风险配重的变更循环

每个变更都走 intent → spec → plan 三件套，会让人的注意力耗在流转上，而不是耗在真正需要判断的地方。
本技能让审计强度跟着风险走：风险高的变更前置把关，风险低的变更放行、事后可查。
第一步永远是判档；档位决定后面产出什么、人在哪里把关。

## 判档

按顺序问三件事，命中即停：

1. **做错之后，revert 一个 commit 能恢复吗？** 不能 → **决策档**（`decide`）
2. **做错之后，会静默出错吗？**（没有报错、使用者当场看不出、测试难覆盖）会 → **标准档 + 加固**（`build`）
3. **改动在某条快车道章程的范围内吗？**（`docs/lanes/*/charter.md`）在 → **快车道**（`tune`）；不在 → **标准档**（`build`）

前两问对应两种不同的危险，防法也不同。难逆的错，必须在写代码之前由人拍板；静默的错，再详细的前置文档也拦不住，要靠事后验证（失败先行的测试、独立评审、真实运行时验证）；
响亮且可逆的错，使用者一眼就能看到、一次 revert 就能收拾，前置审批只会增加等待。

第 3 问有一种特殊情形：改动属于"响亮且可逆"，但项目里还没有适用的章程。此时按 [references/tune.md](references/tune.md) 起草章程交人批准，批准后进入快车道；
人暂时不想建通道，这一次就按标准档处理，spec 写短。章程批准一次即可，之后同类改动直接进快车道，所以这笔成本只付一次。

### 速判信号

**难逆**（命中任一 → 决策档）：

- 改变持久化数据的形状或语义，或需要迁移存量数据
- 改变对外契约：接口、通信协议、消息或文件格式
- 触及鉴权、权限、隐私边界
- 引入新的外部依赖、运行时或部署形态
- 与现有 ADR 冲突，或要做一个日后难以撤销的技术选择

**静默**（命中任一 → 标准档 + 加固，详见 [references/hardening.md](references/hardening.md)）：

- 写入、修改或删除用户的持久化数据（含迁移、去重、级联删除、批量操作）
- 多方并发或乱序的状态：同步、重连、重放、队列、缓存与存储双写、定时器与去抖
- 依赖外部系统的真实行为：跨进程或跨网络调用；对第三方库、运行时、平台的回调参数、事件时序、生命周期（进程可能随时被回收或重启）的假设——这类假设只有真实运行才能证实
- 判定依赖多处约定一致（键、ID 空间、坐标系、时区）
- 带熔断、告警、兜底逻辑（误触会造成假告警，或吞掉真故障）

**响亮且可逆**（可进快车道）：只影响呈现或局部行为、出错时使用者当场就能看到、没有数据副作用。
例如视觉、间距、文案、动效、交互手感、布局，以及局部范围内无状态的 bug 修复与性能调优。

信号冲突或拿不准时，**往上升一档**。多走几分钟流程，比静默损坏数据便宜得多。
更多边界案例，以及一个真实项目的回溯校准，见 [references/routing.md](references/routing.md)。

### 判档的记录与确认

- agent 提议档位，写进 intent 头部的 `Lane:` 和 `Why:`（一句话理由）；人在接受 intent 时确认。**档位是整个循环里最关键的人工判断**，因为判错会让审计强度整体错位，所以由人拍板，不由 agent 自批。
- **一个 intent 一个档位。** 用户一次提出多条诉求时按档位拆开，不要捆成一个 intent——否则要么把轻活拖进重流程，要么让重活蹭到轻流程。
  intent 是判断单元，MR 是交付单元：多个 intent 可以进同一个 MR。
- **中途升级**：快车道改动越过章程边界（CI 会拦）、标准档实现中发现要改 ADR 或数据形状、评审连续三轮仍有阻塞级问题，都停下来，向人说明并升档。

## 三档一览

| 档位              | 产出                              | 人把关的地方                                           | 独立评审                                     | 流程细节                                    |
| ----------------- | --------------------------------- | ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------- |
| 决策档 `decide` | intent → [ADR] → spec → plan   | intent+档位、每份 ADR 定稿、spec、plan（代码生成之前） | 实现完成后，每轮新开一个                     | [references/decide.md](references/decide.md) |
| 标准档 `build`  | intent + spec（delta），plan 按需 | intent+spec **一次评审**                         | 实现完成后至少一轮；命中静默信号则多轮并加固 | [references/build.md](references/build.md)   |
| 快车道 `tune`   | 章程 + 汇总报告，不逐项出文档     | 章程批准一次；之后审报告                               | 只复核汇总报告                               | [references/tune.md](references/tune.md)     |

进入某一档前，先读对应的参考文件；模板在 `assets/` 下。

## 目录与链接

```
docs/
├── genesis/                    # 宏观文档：VISION / ARCHITECTURE / adr/（project-genesis 产出）
├── ROADMAP.md                  # 团队级方向文档，慢变量（较早的项目里可能在 genesis/ 下，以项目实际位置为准）
├── intent/
│   ├── active/<YYMMDD>-<slug>/ # 进行中：intent.md [spec.md] [plan.md] [review.md]
│   └── done/<YYMMDD>-<slug>/   # 已关闭：整夹搬入，不改内容
└── lanes/<lane>/               # 快车道：charter.md + reports/<YYMMDD>.md
```

- **一个变更一个文件夹**，文件夹内的链接用同目录相对路径。
- 指向宏观文档的链接一律写相对路径，不带开头斜杠；默认布局下是 `../../../genesis/...`、`../../../ROADMAP.md`。`active/` 与 `done/` 深度相同，所以归档时出向链接不会断。
  带开头斜杠的路径在不同平台的渲染器里解析不一致（相对仓库根还是站点根），在编辑器里又是文件系统绝对路径，不要用。
- **`Status` 字段是事实，目录是视图。** `Status: closed` 的变更整夹移入 `done/`。归档、索引、校验的脚本见 [references/automation.md](references/automation.md)。

## 通用纪律

- **评审一律交给新开的、空上下文的 subagent**，协议见 [references/review.md](references/review.md)。
- **spec 只在 Requirements 变化时修改。** 评审发现记在 `review.md`，不追加进 spec。否则 spec 会退化成评审日志，历史读者分不清哪些是需求、哪些是修补。
- **plan 是活的。** 实现中偏离计划，把偏离写进 plan 的 `Deviations`，与对应代码**同一次提交**，不需要重新审批。只有偏离触及 spec 的 Requirements 时才回头改 spec。
- **宏观文档同步。** 变更触及 ARCHITECTURE 时，更新与代码同一个 MR。决策只追加 ADR（新 ADR 取代旧 ADR），不改写已定稿的 ADR。
- **ROADMAP 是方向，不是看板。** 它是团队级的能力演进序列，变得慢；"现在做到哪了"不记在里面，由 `done/` 与派生索引对照它推出。个人的待办或看板属个人约定，不入库，本技能不管。
  - 读：起草新能力类 intent、有人问"下一步做什么"、判断新请求是否与已规划的能力块重叠时先看它，intent 的 `上游` 写对齐的能力块。
  - 写：只在方向变了才改，且由人决定。① 新请求是新能力、不在方向内：在 intent 里写明，请人选"调整路线图 / 作为方向外的例外 / 不做"，调整与该变更同一个 MR；
    ② 已完成的工作改变了剩余能力块的范围或顺序：人单独发小 MR。影响路线的取舍链接 ADR。
  - bug、样式、性能、重构等维护类变更不必对齐，`上游: 无` 是常态；变更关闭时不回写 ROADMAP。
- **机器能校验的交给机器。** 链接有效、`Status` 与目录一致、快车道越线，这些靠 CI，不靠自觉。

## 参考文件

| 何时读                                   | 文件                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 判档拿不准、遇到边界案例                 | [references/routing.md](references/routing.md)                                                                 |
| 进入决策档                               | [references/decide.md](references/decide.md)                                                                   |
| 进入标准档                               | [references/build.md](references/build.md)                                                                     |
| 标准档命中"静默"信号                     | [references/hardening.md](references/hardening.md)                                                             |
| 进入快车道、或建立新章程                 | [references/tune.md](references/tune.md)                                                                       |
| 任何需要评审的时候（含快车道报告复核）   | [references/review.md](references/review.md)，提示词模板 [assets/reviewer-prompt.md](assets/reviewer-prompt.md) |
| 归档变更、生成索引、用脚本做越线检查     | [references/automation.md](references/automation.md)                                                           |
| 接入 CI 与平台、让 harness 介入循环（评审、命令、监控） | [references/wiring.md](references/wiring.md)，触点契约 [wiring-touchpoints.md](references/wiring-touchpoints.md)，GitLab 落地 [wiring-gitlab.md](references/wiring-gitlab.md) |
| 精简项目的 AGENTS.md                     | [assets/agents-md-snippet.md](assets/agents-md-snippet.md)                                                     |
