# 技能库

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`packages/server/src/skills/`、`store/skills.ts`、`api/skills.ts`、`api/skills-library.ts`、`session/pool.ts` 的技能同步入口，以及 `packages/web/src/features/settings/tools/skills/`）

技能库是 Server 持有的一份技能内容与元数据：来源怎么装、版本怎么跟与锁、怎么分发到各环境、怎么批量处理。**技能怎么写进提示词、模型怎么用它**不在本文，见 [`prompt.md`](prompt.md)（能力求值）与 [`prompt-delivery.md`](prompt-delivery.md)（送达）。术语「目录」「工作区」见 [`workspace.md`](workspace.md)。下文服务端路径省略 `packages/server/src/`，前端路径省略 `packages/web/src/features/settings/tools/`。

## 1. 库里有什么

- 内容在 `<数据目录>/skills/<名>/`，元数据在 SQLite `skills` 表：描述、来源 `origin`、版本、锁定版本、上次查到的最新版、启用、内容哈希（`store/skills.ts`）。设置页不表达作用域，不显示安装位置。
- 名称与描述取自 `SKILL.md` 前置信息，不手填。名称须匹配 `^[a-z0-9]([a-z0-9]|-(?=[a-z0-9])){0,63}$`（1–64 个字符，不以连字符开头或结尾，无连续连字符；与 pi 加载器一致），重名拒绝（409）（`skills/source.ts` 的 `SKILL_NAME_RE`、`skills/library.ts` 的 `assertName`）；前置信息的 `name` 须与库名一致、`description` 必填（≤1024 字符）；体量上限 200 个文件、单文件 1 MiB、总计 8 MiB（`skills/spec.ts`）。
- 内容哈希只看「相对路径 + 文件内容」集合，与位置无关；点开头的文件不进库、不计哈希（`skills/spec.ts` 的 `hashFiles`）。分发对账靠它。
- 经来源安装的技能是来源的镜像，库里文件只读：写文件路由（`PUT /api/v1/skills/:name/file`）对 `origin` 非空返回 409 `read_only_source`。
- **两层：全局与工作区**（主机上不另设一层）。每个技能的 `scope` 就是「是否全局」，详情页里「对所有会话生效」开关改它（`PATCH /api/v1/skills/:name {scope}`，进草稿、点保存才落）。**新装默认 `project`（不全局）**，`skills/library.ts` 的 `install` 与 `installObserved` 都是。
  - `global`：每个会话默认带上，文件镜像到各主机用户目录 `~/.agents/skills/yuanshu/`（§4）。
  - `project`：只在被**勾选给某个工作区**时才生效，会话创建与切换目录时同步进该工作区各目录的项目技能目录；勾选在工作区弹窗「技能与 MCP」里，存 `workspace_capabilities`（`GET/PUT /api/v1/workspaces/:id/capabilities`）。
  - 会话实际生效的技能 = 全局 ∪ Agent 基线里的 `skill:` 引用 ∪ 工作区勾选，再去掉已禁用的（`skills/resolve.ts` 的 `resolveSkills`，顺序即此）。

## 2. 来源

用户的习惯是「丢一个仓库地址就装」，所以安装只有一个输入框，**粘贴任何常见写法都行**（请求里 `source: {kind: "auto", spec, subdir?}`），由服务端识别（`skills/source.ts` 的 `detectSource`，纯函数，顺序即下表）；显式的 `npm` / `git` / `dir` 种类仍然可用，跳过识别。识别不了就报错并列出支持的写法。

| 粘贴的写法 | 识别成 |
|---|---|
| `./` `../` `/` `~/` 开头 | dir（**Server 机器上**的路径） |
| `git@host:owner/repo[.git]` | git（一律改走 https，私有仓库没有凭据就明确失败，不做 SSH 认证） |
| `https://…`：github.com 只取前两段作仓库；其余主机取 `/tree/` 或 GitLab 的 `/-/tree/` 之前的全部路径；`/tree/<ref>/<目录>` 的 ref 取第一段、其余是 `subdir`；末尾可带 `@ref` | git |
| `host/owner/repo[@ref]`（host 含点） | git |
| 恰好两段的 `owner/repo[@ref]` | git，主机补成 github.com |
| `@scope/包名[@版本]`、`包名[@版本]` | npm（版本可省，省了取 latest） |

登记下来的来源形态仍是四种，卸载行为不变：

| 来源 | 版本 | 内容 | 卸载 |
|---|---|---|---|
| npm | 包版本 | 复制进库 | 清各环境副本 |
| git（`url`、可选 `ref`、可选 `subdir`） | **tag 存 tag 名，其余（分支、缺省 ref、提交号）存取回时的 40 位提交号**；来源里的 `ref` 保持用户写的（缺省就不存），不会被改写成提交号，否则永远查不到更新 | 复制进库 | 清各环境副本 |
| dir | 不跟踪 | 复制进库 | 清各环境副本，原目录不动 |
| observed | 不跟踪 | 不复制，只登记；每次读环境上的原件 | 清其他环境的副本，原件保留 |

分支名里带 `/` 的 `/tree/` 链接不处理（ref 会被当成第一段）。前端 `skills/model.ts` 的 `describeSource` 只做预览，最终以服务端为准。

- **取回**（`skills/fetch.ts`、`skills/git-fetch.ts`）：**npm** 复用 pi 的 `DefaultPackageManager`，装到 `<数据目录>/skill-fetch`，命令带 `--ignore-scripts`；**git 不走包管理器，只取文件、不跑任何 install**（monorepo 里的 `catalog:` 工作区依赖在 `npm install` 下会直接炸，如 context7）：临时目录里 `git init` → `fetch --depth 1 origin <ref|HEAD|提交号>` → `checkout FETCH_HEAD` → `rev-parse HEAD`，`GIT_TERMINAL_PROMPT=0`（没有终端，私有仓库直接失败并带 git 的报错）。取回串行；查询 15 秒、取回 3 分钟超时。
- **发现技能**：用 pi 的加载器在取回根（有 `subdir` 就在 `根/subdir`，越界直接拒绝）下递归找 `SKILL.md`。只有一个就是它；多个时：与来源推断名**恰好一个**同名才取它，**同名多份不算**；否则 409 `ambiguous_skills`，响应带 `candidates: [{name, path, description}]`（`path` 相对仓库根，按路径排序，最多 50 条，超出在 message 里写「还有 N 个未列出」），界面让用户选一个，再带 `subdir` 提交一次。一个都没有报 `no_skill`。例：`upstash/context7` 里有 10 处技能、其中 6 份同名 `context7-mcp`。
- **observed 的范围**：用户目录与该环境上各目录的 `.pi/skills`、`.agents/skills`（不含上级目录），且不在 `yuanshu` 命名空间内（`skills/env.ts` 的 `rootDirs`、`skills/library.ts` 的 `installObserved`）。
- 装完停在「待分发」，不自动分发。

## 3. 版本与锁定

- **候选版本**（`skills/fetch.ts` 的 `versions`）：npm 用 `npm view`，剔除含 `-` 的预发布，`latest` 标签排第一；git 看 `ref`：**没写或是分支 → 只有一个候选，就是该分支（缺省为默认分支）当前的提交号**；40 位提交号 → 就是它；其余当 tag，`ls-remote --tags`，只取 `v?数字` 开头的，**不剔预发布**，新到旧。列表接口不联网，「可更新」只看上次查询缓存的最新版（两边都是提交号时只判不等，提交号之间没有先后，`skills/view.ts` 的 `isNewer`）；界面「检查更新」对所有 npm/git 技能各查一遍（3 路并发），只刷新缓存、不改库（前端 `skills/store.ts`）。
- **自动检查更新（仅前端）**：首次进入技能页签、读完列表后，后台静默对所有 npm / git 技能查一遍最新版（与手动「检查更新」同一个函数，不弹提示、不更新任何东西），6 小时内不重查，全部没查到不记时间；时间戳在浏览器 localStorage（`tools/common/autoCheck.ts`）。Server 启动时与定时都不查。
- **更新 = 跟最新**（`skills/library.ts` 的 `update`）：库里的内容与版本换成最新版，**不推送到环境**。dir 与 observed 的「更新」是重读原件（版本仍为空；界面只对「可更新」项给更新，这条路径只能走接口）；来源里技能名变了则拒绝（`name_changed`）。
- **锁定**（`lock`）：选一个版本，库里换成该版本并记为锁定版（锁分支会落成当时的提交号，所以也能锁在某个提交上）；再选另一版即重新固定；dir / observed 不能锁（`version_not_tracked`）。解除锁定只清标记，不动内容。
- **锁定后拒绝更新**（409 `locked`）、不计入「可更新」；补齐与分发只推库里现有内容、从不联网换版本，所以不会越过锁定版（库里版本与锁定版不一致时直接拒绝推送，`lock_mismatch`）。

## 4. 分发到环境

- **目标位置**：全局技能写进各环境用户目录的 `~/.agents/skills/yuanshu/<名>/`，目录里放同步清单 `.yuanshu-sync.json`（哈希 + 版本）（`skills/sync.ts` 的 `targetDir`、`MANIFEST`）。只写 `yuanshu` 命名空间，不碰其他位置。
- **不另建账本表**：每次读技能列表，并行探测所有环境，读清单哈希与库对比（`skills/library.ts` 的 `distribution`、`skills/dist.ts`）。每台环境三态：`in-sync`、`behind`（有副本但与库不同）、`missing`（没有副本；探测不到也是 `missing`，并带原因）。单台探测 5 秒超时，失败后 30 秒内不再重试（`skills/dist.ts` 的 `HostGuard`）。无清单的同名目录按内容算哈希对比；observed 原件所在环境视为一致。
- **推送**有两个动作：「分发」推到指定环境，「补齐」默认只推 `behind` 的环境。都只推库里现有内容；整目录重写（库里删掉的文件同步清掉），清单最后写，中途失败下次重来；各环境并行，单台失败不影响其他（`skills/library.ts` 的 `sync` / `distribute`、`skills/sync.ts` 的 `syncSkills`）。
- **冲突**：目标目录已存在却没有清单，记 `conflict`、不覆盖。约定根下已有同名的非元枢技能（只探测 `<根>/<名>` 这一层，不全树扫描）：内容相同则沿用（`unchanged`，不写副本），不同则 `conflict`。探测的根：分发时是用户目录两个约定根（`~/.pi/agent/skills`、`~/.agents/skills`）；会话同步时再加上该目录的 `<目录>/.pi/skills`、`<目录>/.agents/skills`（`skills/env.ts` 的 `rootDirs`）。结果只出现在接口响应与按目录保留在内存里的最近一次 `SyncReport`，不落库。读代码推断：沿用环境里已有那份时库不写副本，该环境的分发状态仍显示 `missing`。
- **项目级技能不按环境分发**（409 `project_scope`；`distribution` 对它们不探测、`dist` 为空，界面状态是「就绪」，没有「待分发 / 补齐」）：它们随工作区勾选在会话里同步。改成全局后才有各环境的分发状态。
- **何时落到环境**：更新与锁定只改库，免得运行中的会话被改动。环境只在这几处被写：会话创建或载入内存时（`SessionPool.prepareSkills`）、会话内切换目录时（`switchSkillNotice`）、会话开着时每次运行前技能集合的指纹变了（`refreshSkills`，见 §7），以及手动「补齐 / 分发」；同步的是该会话用到的技能，失败只记进 `SyncReport`，不阻断会话。压缩后的重建（`SessionPool.rebase`）只重渲染提示词文本，不重新同步技能。读代码推断，并未隔离：环境上的 `SKILL.md` 可能被另一个会话的同步或手动补齐重写，运行中的会话下次 `read` 会读到新内容；提示词里的技能清单（名称、描述）在会话启动时定下，之后的新增 / 下掉 / 改描述与切目录新增的技能走尾部通知（`skills/runtime.ts` 的 `skillNotice`，见 §7）。

## 5. 状态、启停与详情

行状态由前端合成（前端 `skills/model.ts` 的 `statusOf`），优先级自上而下：

| 状态 | 条件 |
|---|---|
| 同步中 | 该行有进行中的操作（文案：同步中 / 分发中 / 卸载中） |
| 已禁用 | 库里标记为禁用 |
| 锁定 | 有锁定版；同时有 N 个环境落后时显示「锁定 · 落后 N」 |
| 可更新 | 无锁定版，且上次查到的最新版高于库版本 |
| 落后 N | 有 N 个环境副本与库不同 |
| 待分发 | **所有**环境都没有副本 |
| 一致 | 其余（项目级技能显示「就绪」） |

- 服务端只给 `ready / update-available / disabled`（`skills/view.ts` 的 `statusOf`），分发情况是列表里附带的 `dist`。「环境落后」与「未分发」是两个概念：只在部分环境有副本时，其余环境的 `missing` 不计入落后，行状态仍是「一致」；锁定且尚未分发的行显示「锁定」，不是「待分发」。分发情况在详情的「分发」一节里按环境各列一行（一致 / 落后 / 未分发 / 原件所在 / 探测不到，落后与未分发的行带「补齐」「分发」），列表行只写「一致数/环境数」。
- 启用 / 禁用只改库里的标志：禁用的技能退出会话（不注入、不同步），环境里已有的文件不动（`skills/resolve.ts` 的 `resolveSkills`）；界面对禁用项不给分发 / 补齐。
- 详情只读：左文件树、右预览（默认 `SKILL.md`），二进制文件不预览（`api/skills.ts` 文件读取路由返回 415）。

## 6. 批量与卸载

- 批量动作 `update / disable / enable / uninstall`（`POST /api/v1/skills/batch`）：名称去重、一次最多 100 个；逐项执行，单项失败不影响其余、也不回滚已成功的，逐项返回结果（`skills/library.ts` 的 `batch`、`api/skills-library.ts` 的 `BATCH_MAX`）。服务端对锁定技能的批量更新按项报 `locked`。
- 界面：**不提供批量**——没有复选框与批量条，是左列表 + 右详情，更新、禁用 / 启用、卸载都是对当前这一个技能的操作（列表行的「⋯」菜单也能直接做）；「卸载」二次确认，写明将清理几个环境的副本、原件是否原地保留（前端 `skills/SkillRemoveDialog.tsx`）。批量接口保留。列表头「⋯」里是「检查更新」。
- **卸载**（`skills/library.ts` 的 `uninstall`）：先清各环境上的副本，再删库条目。只清带同步清单的目录，无清单的同名目录视为用户手写、不动。清不掉的环境列入 `failed`，库条目仍照常移除。observed 的原件与 dir 的原目录都不动；库里复制的那份随之删除。卸载同时删去工作区勾选（`SkillStore.remove`）；Agent / 预设里对它的引用不删，运行时跳过并记审计（`store/capability-refs.ts` 的 `auditSkipped`）。

## 7. 与会话、与 pi 自动发现的关系

- **会话开着时新增 / 下掉 / 改了技能**：每次运行前按「全局 ∪ Agent 基线 ∪ 工作区勾选」的指纹判断，变了就同步到会话当前所在环境，并用尾部通知告诉模型（名字、描述、SKILL.md 路径），前缀不动；见 [`prompt-delivery.md`](prompt-delivery.md) §3.3「技能栏」。

- 会话用哪些技能由能力选用决定（`skill:<名>` 引用，Agent 基线与会话增减，见 [`prompt.md`](prompt.md) §2）。`skills/runtime.ts` 的 `SkillRuntime.prepare` 是会话与库之间的胶水：解析应生效的技能、同步到会话所在环境、产出提示词里的技能条目与切目录通知。提示词侧的写法与送达不在本文。
- pi 自己会扫 `~/.agents/skills` 与项目 `.agents/skills`，也就扫得到 `yuanshu` 命名空间里我们的同步产物。`mergeSkills`（`skills/runtime.ts`）把这类条目去掉，换成本会话分配到的那几个，免得没分配的技能也进提示词。pi 自动发现与信任开关的关系见 [`plugin.md`](plugin.md) §3「信任」。

## 8. 未实现与未决

**已定未做**
- 来源「插件」（[`plugin.md`](plugin.md) PL1 的原设想：pi 包里的 skills 登记进库、随插件置灰 / 移除）：代码里没有，来源只有 §2 四种；开着的插件包里的 skill 现在由 pi 自己扫。

**决定不做**
- 技能自带脚本需要的运行时（node、python 等）：Server 不探测也不装，技能的依赖由 agent 运行时自己发现解决；详情页只按文件扩展名列出「含脚本」，作静态提示。
- 清不掉的环境上的残留副本：库条目已删，没有后续清理入口。理由：只在卸载时主机正好连不上才会出现；会话里的技能列表来自我们注入的清单，不会扫到这份残留，只占一点磁盘。卸载后界面会弹出清理失败的主机名与原因（`SkillRemoveDialog`），用户可自行去那台主机删。

**未支持**
- 来源「本地目录」不支持 `subdir`；`/tree/` 链接里分支名带 `/` 的写法；SSH 认证的私有仓库。
- 会话里单独去掉某个全局技能：没有（没有对应的数据结构，要时再设计）。
- 旧路由（手写 `POST /api/v1/skills`、环境纳入 `POST …/import`、`DELETE /api/v1/skills/:name`）：服务端保留、前端无入口；其中 `DELETE` 只删库条目，不清环境副本，新界面走 `batch` 接口的卸载。
