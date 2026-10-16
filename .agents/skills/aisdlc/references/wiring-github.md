# 接线：GitHub 落地

目标平台是 GitHub 时读。原则与顺序见 [wiring.md](wiring.md)，触点契约见 [wiring-touchpoints.md](wiring-touchpoints.md)。
经验来自 GitHub.com 上一个 Free 账号的**公开**个人仓库，只做了机械校验（CI）与主干保护，**没有接评审、评论命令、监控**，所以本文只覆盖这两件事。标记含义：

- ✅ 在该环境实测过。
- ⚠️ 查过文档或推断，没有实测，或需按你的账号类型、版别核实。

目录：[A. 带用户做的平台设置](#a-带用户做的平台设置) · [B. agent 写配置](#b-agent-写配置) · [排障速查](#排障速查)

## A. 带用户做的平台设置

骨架 PR 的 CI 跑绿**之前**不要配主干保护：必需检查只有在该作业成功运行过一次之后，才能在设置页里选中 ✅。所以顺序是：骨架 PR → CI 跑绿 → 合并 → 配保护 → 负向验证。

### 主干保护：用 ruleset，不用经典分支保护

GitHub 有两套并行的机制：**ruleset**（Settings → Rules → Rulesets）与**经典分支保护规则**（Settings → Branches）。选 ruleset ⚠️（官方文档的对比，未与经典规则做过实际对照）：

- Free 账号的**公开**仓库能用 ruleset，不用升级 ✅（本次实际建成并生效）。官方文档写明：ruleset 在 Free 与 Free 组织的公开仓库可用，私有仓库需要 Pro、Team 或 Enterprise Cloud ⚠️（取自官方"About rulesets"页 Who can use this feature，没有在私有仓库实测）。所以 **Free 账号建私有仓库，就用不上这一套**；仓库公开与否会直接决定这里的做法，创世阶段定仓库可见性时要想到。
- 同一分支可以叠加多条 ruleset，经典规则只能有一条；叠加时取最严的。两者同时存在也都生效。
- 可以只改生效状态而不删规则；任何有读权限的人都能查看生效中的规则。
- 规则能用只读 API 读出来核对（见下），agent 因此能核对用户的配置，而不是只听用户说"配好了"。

没有历史规则要兼容就直接用 ruleset。

**建一条 ruleset**（用户做，Settings → Rules → Rulesets → New branch ruleset）：

| 项 | 设置 | 说明 |
|---|---|---|
| 名称 | 写"保护什么"，如 `protect-main` | 不把类型或做法写进名字；每条 ruleset 只管一件事，以后叠加 |
| Enforcement status | Active | 默认可能是 Disabled，建完要确认 |
| Bypass list | **留空** | 留空即"管理员同样受限"；把仓库所有者加进去就等于没有保护 |
| Target branches | Include default branch | API 里显示为 `~DEFAULT_BRANCH` |
| Restrict deletions | 勾 | 禁止删除 |
| Block force pushes | 勾 | 禁止强推 |
| Require a pull request before merging | 勾 | 单人仓库批准人数设 0：作者无法批准自己的 PR，要求批准会让合并不可能 |
| Require status checks to pass | 勾，Add checks 选作业名 | 选到的是**作业名**（如 `check`），所以作业名要固定、不要改；来源应显示为 GitHub Actions |

不勾：Restrict updates（拦住所有更新，含 PR 合并）、Require linear history、"Require branches to be up to date"——骨架阶段没有这些需求，只增加摩擦。

**页面里还有一项含义没查明** ⚠️：PR 规则里的 `require_extra_approval_for_unattributed_changes` 网页默认带上。批准数为 0 时，用它建出的规则合并了两个 PR（单人、无他人批准），没有被挡；但没有找到官方文档对它的解释，换一种仓库设置（多人、要求批准）时先查清。

### agent 用只读 API 核对 ✅

用户建好后，agent 不要让用户贴截图，直接读（`gh` 已登录即可，不需要写权限）：

```bash
gh api repos/<owner>/<repo>/rulesets                       # 列表：id、名称、enforcement
gh api repos/<owner>/<repo>/rulesets/<id>                  # 详情：bypass_actors、conditions、rules
gh api repos/<owner>/<repo>/rules/branches/<分支>          # 该分支实际生效的规则（合并视图）
gh api repos/<owner>/<repo>/branches/<分支>/protection     # 经典保护：没有则 404 "Branch not protected"
```

逐项对照：`enforcement` 为 `active`；`bypass_actors` 为空数组；`conditions` 指向默认分支；规则类型含 `deletion`、`non_fast_forward`、`pull_request`、`required_status_checks`；必需检查的 `context` 等于作业名，`integration_id` 对应 GitHub Actions（可用 `gh api apps/github-actions` 取其 id 来核对）。

注意两个容易误判的点 ✅：

- 分支 API 的 `protected` 字段在**只有 ruleset、没有经典规则**时也会显示 `true`。判断"有没有经典保护"要看 `.../protection` 的 404，不要看 `protected`。
- 经典保护查询返回 404 是"没有"的意思，不是出错。

### 负向验证：真去试一次直推

规则配置对不对，只有真推一次才算数。做法（agent 可以直接做，前提是该账号本来就有推送权限）：

```bash
git fetch origin
git switch -c tmp-neg-test origin/<主干>
git commit --allow-empty -m "test: direct push must be rejected"
git push origin HEAD:<主干>        # 期望被拒
```

用**空提交**加一次性分支：万一规则没生效，落到主干上的也只是一个空提交，不会改动内容。✅ 实测输出（脱敏）：

```
remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: - Changes must be made through a pull request.
remote: - Required status check "check" is expected.
 ! [remote rejected] HEAD -> main (push declined due to repository rule violations)
```

要点：

- **验证用的账号要是管理员。** 本次用的账号对仓库是 `admin=true`（`gh api repos/<owner>/<repo> --jq .permissions` 可查），被拒才证明"对管理员同样生效"。用低权限账号被拒，说明不了绕过名单为空。
- 被拒之后核对远程主干的提交没变（`git ls-remote origin refs/heads/<主干>`），再删掉一次性分支。
- **删除与强推没有实测**：失败的后果是删掉或改写主干，不值得冒险。这两条只核对了规则配置，如实记录为"未实测"。

## B. agent 写配置

### 工作流 ✅

- 触发：`pull_request` 与 `push` 到主干。PR 上跑的是**合并后的结果**，主干上的 push 再跑一遍，确认合并结果本身是绿的。
- 权限：`permissions: contents: read`，不使用 `pull_request_target`，不引用 secret。公开仓库上任何人的 PR 都会触发流水线，只读权限加无 secret，后果止于"这次检查被放过"。
- 第三方 action 按**提交 SHA** 固定，行尾注释写标签。核对 SHA 与标签的对应用只读 API：`gh api repos/<owner>/<action>/git/ref/tags/<标签> --jq .object`。✅ 本次用到的两个 action 都是轻量标签，`object.type` 为 `commit`，`sha` 直接就是要固定的提交。若显示 `type` 为 `tag`（带注解的标签）⚠️，`sha` 是 tag 对象，还要再取一层（`git/tags/<sha>`）才是提交，这种情形没有实测。
- 作业名固定（它就是必需检查的名字），逻辑全放仓库脚本里，工作流只起环境并调脚本，本地与 CI 因此跑同一份。
- 开 PR 之前，**CI 从未真正跑过**：runner 上的工具、环境准备步骤的行为，本地一律无法等价验证。把"未经真实 runner 验证"写进计划，PR 的首次 CI 就是验证。

### 失败检查要真的变红 ✅

- 开一个一次性**草稿 PR**，目标分支设为骨架分支（不要指向主干），里面放一个会让检查失败的改动（如类型错误），确认 CI 在对应步骤变红、后续步骤未执行，然后关闭 PR 并删除分支。这是"CI 不会假绿"的反向验证。
- 关闭并删除分支一步：`gh pr close <编号> --delete-branch`，再核对远程分支列表。

## 排障速查

| 症状 | 先查什么 |
|---|---|
| 设置页里选不到必需检查 | 该作业是否至少成功运行过一次；作业名是否与工作流里一致 |
| `gh api .../branches/<分支>` 显示 `protected: true`，但经典保护查询 404 | 正常：ruleset 也会让它显示 true，见上文 |
| 推送被拒，但输出里没有预期的规则 | 先看 `gh api repos/<owner>/<repo>/rules/branches/<分支>` 的合并视图，确认哪些规则在生效，再看是否有别的 ruleset 或经典规则叠加 |
| 设置了保护，管理员仍能直推 | Bypass list 是否为空；该账号是否在名单里或属于被豁免的角色 |

## 没有经验的部分

以下**没有做过**，按 [wiring.md](wiring.md) 的原则与 [wiring-touchpoints.md](wiring-touchpoints.md) 的契约实现，并标明未经验证：

- MR（PR）评审、评论命令、监控回边这三个 harness 触点。
- 令牌与权限：bot 账号、细粒度令牌、GitHub App 的选择与权限范围。
- fork 来的 PR 对 secret 与令牌的可见性。
- CD：发布、部署凭据。
- GitHub Enterprise、组织仓库、私有仓库：规则可用范围随账号类型而变，本文只对应 Free 账号的公开个人仓库。
