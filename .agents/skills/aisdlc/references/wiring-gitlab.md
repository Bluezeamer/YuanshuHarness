# 接线：GitLab 落地

目标平台是 GitLab 时读。原则与顺序见 [wiring.md](wiring.md)，触点契约见 [wiring-touchpoints.md](wiring-touchpoints.md)。
经验来自自部署 GitLab 19.x + docker executor 的一个真实项目。标记含义：

- ✅ 在该环境实测过。
- ⚠️ 推断、未验证，或需按你的版本、界面语言核实。
- 【建议】本技能补充、没有实践过。

目录：[A. 带用户做的平台设置](#a-带用户做的平台设置) · [B. agent 写配置](#b-agent-写配置) · [令牌暴露面](#令牌暴露面) · [版本差异](#版本差异) · [排障速查](#排障速查) · [危险操作](#危险操作)

## A. 带用户做的平台设置

按阶段推进，每阶段末尾的"期望结果"没看到就不进入下一阶段。令牌由用户创建并直接存进变量，不要贴进对话。

**新项目的起点**：骨架合并之前，只需要阶段 0 的第一项（runner 就绪），骨架的流水线才跑得起来。骨架合并、流水线跑绿之后，先做阶段 1 的"保护主干"与"合并检查"；
bot 账号、令牌、Webhook、计划任务等其余阶段，随各触点的 intent 逐个做，不阻塞骨架。

### 阶段 0：前置条件

- **runner 已注册且 executor 为 docker** ⚠️。shell executor 会**静默忽略** `image:`，安装命令直接跑在 runner 宿主上，污染宿主且作业随机失败。
  期望：项目 → 设置 → CI/CD → Runner 里看到绿色"在线"的 runner；推一个空提交，流水线被创建并跑完。
- **管理员权限** ⚠️：建 bot 账号、改出站请求白名单都要。检查：能否打开左侧"管理"区域。
- **模型服务从 runner 容器网络可达** ⚠️（评审与命令需要）。期望：用 runner 所在网络对模型服务的列表端点发请求，得到 200。
- **GitLab 能反向访问中继** ⚠️（评论命令需要）。在 GitLab 所在主机对中继发一个空载荷 POST。期望：被**拒绝验签**，说明中继活着且验签生效；连不上才是失败。
- **出站请求白名单放行中继地址** ⚠️：自部署 GitLab 若限制出站请求，私网地址默认拒绝投递，Webhook 静默失败。管理 → 设置 → 出站请求 → 本地 IP 白名单，加入中继地址。

### 阶段 1：账号、角色、保护

- **建 bot 账号** ⚠️。GitLab 没有叫"bot 用户"的按钮：17.1+ 推荐用服务账户（不能登录，正合 bot），否则建普通用户。期望：管理 → 用户里出现该账号。
- **把 bot 加入项目** ✅：项目 → 管理 → 成员。接入 fix 时角色为开发者（只能推非保护分支，即 MR 源分支）；不接入 fix 则用报告者（只读加评论）。期望：成员列表里角色正确。
- **保护主干** ✅：项目 → 设置 → 仓库 → 受保护的分支，添加主干：允许推送 = 无，允许合并 = Maintainers，**允许 force push = 关**。
  force push 是独立开关，漏关则"force push 被拦"的结论不成立。期望：列表里主干受保护，force push 列显示禁止。
- **合并检查：流水线必须成功** ✅：项目 → 设置 → 合并请求 → 合并检查。它**不在**受保护分支页，很多人因此找不到。期望：流水线未绿时合并按钮不可用。
- **章程路径的负责人批准** ⚠️：按路径要求代码负责人批准（CODEOWNERS 加"要求代码负责人批准"）按 GitLab 文档属 Premium 及以上版别，Free 版没有，请先确认版别。
  没有时用"只有 Maintainer 能合并 + 合并前人审 MR"兜住，并告诉用户这一档较弱。

**Owner 对普通 push 透明** ✅（19.4.1，配置为"允许推送 = 无"）：Owner 仍可直接 `git push origin main`，只有 force push 被拦。Owner 本就能改保护规则，分支保护对"持有 Owner 钥匙者"是纪律提示，不是安全边界。
所以 agent 不能持有 Owner 的 SSH key 或令牌。

### 阶段 2：令牌与变量

- **先让 agent 做一次参数化检查**：环境相关的值（GitLab 地址、项目路径、模型名、bot 名、探测地址）全部来自环境变量或一处集中配置，grep 确认没有残留的硬编码。
  原经验里这些值写死在代码里，换环境后出现过"MR 里没有评审评论""命令返回 404""监控探到别人的域名"。bot 名曾写死在三处，改名必须同步。
- **bot 的细粒度令牌** ⚠️：头像 → 编辑个人资料 → 访问令牌 → 添加新令牌 → 资源和权限选择器 → "组和项目"页签 → 选目标项目。（旧的 scope 型令牌在 19.x 是否可用未验证。）

  | 资源 | 权限 | 用途 |
  |---|---|---|
  | Merge Request | 读取 + 创建 | MR 评论（讨论串）、读 MR 与 diff |
  | Work Item | 读取 + 创建 | 建 issue（监控）、MR 顶层评论 |
  | Code | push | 仅 fix；只能推源分支 |

  不给 Merge / Approve / Update / Delete。有效期必填，令牌值只显示一次，立刻存进变量。
  烟测（用户运行，只贴状态码）：对 MR 的 discussions 端点和 issues 端点各发一次请求，期望 200；403 或 404 说明缺 Merge Request 读取或 Work Item 读取。
- **CI 变量** ✅：模型密钥、bot 令牌。类型为字符串，**掩码开，保护关**。保护变量只对保护分支的流水线可见，而 MR 流水线跑在 merge ref 上，勾了保护就读不到，变量为空，脚本失败。
  期望：变量列表里在，掩码列显示已启用。
- **项目触发令牌** ✅：项目 → 设置 → CI/CD → 触发器 → 新建。它**只能**调 `/trigger/pipeline`，泄漏面远小于个人令牌。值直接配进中继的环境，不进 CI 变量。

### 阶段 3：Webhook 与中继（评论命令）

**顺序不能错**：建 Webhook → 抄签名令牌 → 起中继。先起中继、密钥随便编，会验签失败，而 GitLab 的投递日志按中继返回的状态码显示结果，返回 200 就显示"成功"，事件却永远被丢弃。

- **建 Webhook** ✅：项目 → 设置 → Webhook → 添加。URL 填中继地址；触发来源**只勾"评论"**（别勾推送、流水线，否则每条流水线都轰中继）；内网 HTTP 则关 SSL 校验；签名令牌创建时生成。期望：列表里出现该条，签名令牌可查看。
- **签名令牌配进中继的环境**，不进 CI 变量：中继不在 CI 里跑。
- **常驻运行**。前台跑通后必须做成服务，否则关终端或宿主重启后命令静默全哑。示例：

  ```ini
  [Unit]
  Description=aisdlc webhook relay
  After=network-online.target

  [Service]
  WorkingDirectory=<中继所在目录>
  EnvironmentFile=<存放环境变量的文件，权限 600>
  ExecStart=<启动中继的命令>
  Restart=always
  RestartSec=5

  [Install]
  WantedBy=multi-user.target
  ```

  期望：服务状态为 active，日志里有启动记录。

### 阶段 4：计划任务（监控回边）

项目 → 设置 → CI/CD → 计划任务 → 新建 ✅：cron 如 `*/30 * * * *`，目标分支为主干，**变量不填**。期望：列表里有这条，下次运行时间有值。
失败路径演练（推荐）：构建 → 流水线 → 运行流水线，选任意分支，加变量把探测地址设成必然失败的地址。期望：监控作业建出一个真实的发现 issue；验证后关闭它。

### 阶段 5：回路验证

| 回路 | 做法 | 期望 |
|---|---|---|
| MR 评审 | 开一个 MR，等评审作业跑完 | MR 上出现 bot 身份的评审评论 |
| ask | 评论 `@<bot> ask 这个项目是干什么的` | bot 在该线程内回复 |
| fix | 评论 `@<bot> fix <小改动>`，再由 MR 作者回复「确认」 | 先出现 `[fix 待确认]`，确认后源分支出现 bot 的提交 |
| 监控 | 在计划任务上点"播放" | 作业绿，状态 issue 最新 note 为 up |

负向验证（各做一条）：

| 层 | 测试 | 期望 |
|---|---|---|
| 服务端 | 用 bot 令牌推主干 | 受保护分支拒绝 |
| 流程 | 非 MR 作者回复「确认」 | 不触发 fix |
| 章程 | 开一个越出章程范围的快车道 MR | 机械校验作业失败 |
| 进程级 | 让 agent 执行推送主干的命令 | 被拦；注意它只是软约束 |

## B. agent 写配置

### 流水线结构

- 用 `include: local:` 拆分文件，主文件保持可读 ✅。
- `workflow:rules` 显式列出所有允许的来源 ✅。默认只放行 MR 事件和默认分支推送，手动（web）、定时（schedule）、触发（trigger）都要显式加；触发来源用 `$CI_PIPELINE_SOURCE == "trigger" && $TASK`，只放行带形态变量的触发。
- 每个作业的 `rules` 独立控制，不依赖默认值 ✅。
- `default.before_script` 会被作业级的 `before_script` **整体覆盖**，不是合并 ✅：不需要的作业写 `before_script: []`，自带的作业要自己带上引导步骤。
- 需要 diff 或 merge-base 的作业设 `GIT_DEPTH: "0"` ✅，并 `git fetch` 目标分支（浅克隆会断掉三点 diff）。
- 脚本行里含 `: `（冒号加空格）会被 YAML 当成映射，作业非法，流水线 0 个作业秒挂；整行加引号 ✅。
- 部署类作业的 `rules` 要排除 `schedule` 与 `web` 来源 ✅，定时与手动流水线不得部署。
- 触发来源的流水线里，命令作业不要 `needs` 无关的检查作业 ✅：检查一挂，线程里就一条回复都没有。
- 信任链 = 官方基础镜像 + 钉死版本的 harness 运行时；安装期的脚本钩子能禁则禁；不放宽 runner 的镜像拉取策略 ✅。镜像需要 git 与 Python ≥3.11（机械校验用）。

### 作业骨架 ⚠️

下面的片段**没有在真实 runner 上跑过**，机械校验用的脚本本身有单测。接入时按镜像和分支策略调整。`<harness-run>` 与 `scripts/post-comment.sh` 是占位：前者是项目 harness 的无头命令，后者是你写的、用 API 发评论的脚本。

```yaml
aisdlc-docs:
  stage: test
  script:
    - python3 -I scripts/aisdlc/aisdlc_index.py --check
    - python3 -I scripts/aisdlc/aisdlc_index.py --out INDEX.md
  artifacts:
    paths: [INDEX.md]
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

aisdlc-lane:
  stage: test
  variables:
    GIT_DEPTH: "0"
  script:
    - LANE="${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME#lane/}"
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - python3 -I scripts/aisdlc/aisdlc_check_lane.py "docs/lanes/$LANE/charter.md" --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --report
  rules:
    - if: $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^lane\//

ai-review:
  stage: review
  variables:
    GIT_DEPTH: "0"
  allow_failure: true
  script:
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - <harness-run> "$(cat prompts/review.txt)" > review.txt
    - scripts/post-comment.sh "$CI_MERGE_REQUEST_IID" review.txt
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

cmd-task:
  stage: task
  script:
    - scripts/run-task.sh "$TASK"
  rules:
    - if: $TASK
```

### API 要点 ✅

- 项目 id 可用 URL 编码的路径（`group%2Fproject`），这样令牌不需要 Project 读取权限。令牌自检别用 `GET /projects/:id`，会得到 403 或 404 而误判令牌坏了；改查 MR 的 discussions 或 issues。
- 读 MR 的 discussions 需要 Merge Request 读取权限。
- MR 的**顶层**评论（`POST …/merge_requests/:iid/notes`）在 19.x 归 Work Item 资源，令牌需要 Work Item 的读取 + 创建；只给 Merge Request 创建会得到 403。
- 作业日志端点叫 `/jobs/:id/trace`，没有 `/logs`。
- `/pipelines/:id` 要的是**全局** pipeline id；列表里的 `#N` 是项目内的 iid，不是同一个数。按 sha 从列表里定位。
- `curl --data-urlencode` 不展开 `@文件`（那是 `--data` / `-F` 的语法）。
- 推送选项（如 `-o merge_request.create`）只在有 ref 更新时处理，`Everything up-to-date` 时被丢弃。
- 评论的 Webhook 载荷（19.x）：正文与讨论串在 `object_attributes`，MR 的 iid 在顶层 `merge_request`；`noteable_id` 是内部 id，不能当 iid 用。

### Webhook 与触发 API

- 19.x 的签名：请求头 `webhook-signature: v1,<base64>`；待签消息 = `{webhook-id}.{webhook-timestamp}.{原始请求体}`；签名 = base64(HMAC-SHA256(消息, 密钥)) ✅。
  密钥形如 `whsec_<base64>`，作 HMAC 密钥时是否要先去掉前缀并 base64 解码，经验里没有记录 ⚠️，以平台文档和一次实测为准。
- 16–18 的旧实例用明文共享密钥头 `X-Gitlab-Token`，原中继不认，投递会全部判为验签失败 ⚠️（未在这些版本上验证）。
- 触发 API：`POST /projects/:id/trigger/pipeline`，表单字段 `token`、`ref`、`variables[KEY]` ✅。
- 两条变量注入路径：**静态变量**在项目设置里配，所有流水线可见（模型密钥、bot 令牌）；**动态变量**由触发 API 每次传入（形态、内容、MR iid、评论 id、讨论串 id），只有被触发的流水线有。
- File 类型变量：`$VAR` 是**文件路径**，不是内容，要用重定向读（如 `ssh-add < "$VAR"`），不能当环境变量内容用 ✅。
- 把密钥注入配置模板时用字符串替换，别用 sed（值里含 `|`、`&`、`\` 会损坏）✅。

### 提交身份与推送（fix）

- 推送用 HTTPS + 令牌：`https://oauth2:${TOKEN}@<主机>/<组>/<项目>.git`，只推源分支 ✅。
- 提交身份与推送身份一致（都是 bot）才可审计 ✅；bot 名放一处配置，换令牌时一起换。
- 推送后用 `git ls-remote origin <分支>` 核对 ✅。

## 令牌暴露面

**MR 流水线本身就是令牌暴露面** ✅：它执行的是**源分支**的 `.gitlab-ci.yml`，同时注入模型密钥与 bot 令牌（fix 形态下该令牌还能 push）。
任何能向仓库开 MR 的人，都能改流水线脚本把令牌外带。fork 是否继承变量取决于实例设置，未验证 ⚠️。

缓解，强度递增：

1. 不接受外部 MR（单人或小团队自托管项目的实际选择）。**fix 默认开的前提就是这一条**；接受外部 MR 的项目关掉 fix。
2. 评审与 ask 作业用只读令牌，把 push 权限拆到独立的令牌变量，只有 fix 的执行作业引用它【建议】。同项目的 MR 流水线仍读得到两者，所以这只降低、不消除暴露。
3. 令牌设有效期并定期轮换；轮换时同步更新中继的环境与写死的提交身份。

## 版本差异

| 项 | 19.x | 16–18 | 影响 |
|---|---|---|---|
| Webhook 签名 | `webhook-signature: v1,<base64>`，消息含 id 与时间戳 | 明文共享密钥头 `X-Gitlab-Token` | 中继需按实例版本支持对应的头 |
| 令牌 | 细粒度资源选择器 | `api` / `read_api` 等 scope | 老实例建令牌的界面不同 |
| 作业日志端点 | `/jobs/:id/trace` | 同名 | 无 |

## 排障速查

| 症状 | 先查什么 |
|---|---|
| MR 里没有 AI 评论 | ① 评审作业是否跑了（规则只在 MR 事件）② 模型密钥变量是否为空（是否误设成了保护变量）③ 模型服务从 runner 是否可达 ④ 配置里的 GitLab 地址与项目路径是否已替换 |
| 评论命令完全没反应 | ① Webhook 投递记录里的**响应体**，不是状态码：写明"验签失败"是密钥不符，写明"已接收"是通了但被忽略 ② 有没有 trigger 来源的流水线 ③ 中继是否常驻 |
| 有 trigger 流水线但命令作业没跑 | 命令作业 `needs` 了检查作业，检查失败则任务阶段整体不跑 |
| 有作业但没有回复 | 看作业日志末段；回复脚本失败即终止 |
| 监控从不建 issue | ① 计划任务是否建了 ② 探测地址是否还活着 ③ 状态 issue 是否被删（删了会重建、计数归零） |
| 流水线 0 个作业秒挂 | YAML 解析失败，多半是脚本行含 `: ` 没加引号 |
| 作业第一步就挂在下载或引导上 | 网络抖动；加缓存与重试 |
| 工具或浏览器验收假绿 | 找不到工具时脚本自行 SKIP；在 CI 里硬断言工具存在，找不到就失败 |

## 危险操作

| 操作 | 后果 |
|---|---|
| 删或关监控状态 issue | 状态丢失，失败计数归零，最坏延迟一个周期才重新检测 |
| 轮换 bot 令牌 | 中继的令牌与写死的提交身份都要同步改，否则 401 或身份漂移 |
| 在主干 force push | 连 Owner 也会被拦；且会破坏他人基于该分支的工作 |
| Webhook 面板"重新发送" | 中继无幂等时会重复触发，ask 与 review 会重复评论 |
