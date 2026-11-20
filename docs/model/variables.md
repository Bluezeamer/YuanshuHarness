# 隐私变量

Author: bluezeamer
Status: 现行
Date: 2026-11-06
Verified: 2026-11-19（对着代码核对：`packages/server/src/` 下 `store/{secrets,seal,workspace-variables,references,baseline}.ts`、`api/variables.ts`、`session/{extensions,variable-notice,delivery}.ts`、`permission/{placeholders,variables,extension,masking,masking-extension,sudo}.ts`、`env/{tools,ssh}.ts`、`hooks/runtime.ts`、`job/bash.ts`、`mcp/resolve.ts`，与 `packages/web/src/features/settings/variables/`、`features/workspace/dialogs/editors/VariablesEditor.tsx`；只读代码、未运行；未核实的项见 §10）

隐私变量让 agent 能「用」一个密钥而看不到它：名字与描述进上下文，值只在执行端出现。术语「目录」「工作区」见 [`workspace.md`](workspace.md)；代码里的 `directoryId` 指目录。

## 1. 原则与取舍

- **V1 值只在执行端出现一次**：清单通知（`session/variable-notice.ts`）只含名字、描述、范围、档位；REST 响应从不含值，只有遮罩后的 `valueMasked`（≥16 字符的值会露出末 4 位，`store/secrets.ts` 的 `maskValue`）与文件指纹。唯一出口是用户显式「看值 / 复制」（`POST /api/v1/variables/:id/reveal`，写审计，`no-store`，界面 8 秒后重新遮罩）。
- **V2 以环境变量注入，不做文本替换**：命令里的 `{{@名称}}` 改写成对 `"${YUANSHU_VAR_名}"` 的引用，值只进这一次进程的环境（`permission/placeholders.ts` 的 `substitute`）。值里的引号、`$`、换行因此无法破坏或注入命令；审批与会话记录里留的是占位符原文。
- **V3 占位符是 `{{@名称}}`**；单个 `@` 留给文件 mention（`user@host`、`@scope/pkg`、`HEAD@{1}` 不误判）。旧写法 `@名称` 仍识别，但只对旧文法的名字有效（§2）；`\{{@名称}}` 转义后保留字面量。
- **V4 隐私变量没有 `!command` 取值**。`${VAR}` 只出现在 MCP 登记的 env / headers / url 明文值里，取 Server 进程环境（`mcp/resolve.ts` 的 `expandVars`），与隐私变量无关。
- **V5 可见范围 = 工作区启用**：变量建出来**默认谁也看不到**，工作区把它「启用」了，这个工作区里的会话（含子代理会话）才看得到、才能引用。没有连接范围，也不把供应商 key、主机密码当变量（§9）。

## 2. 存储

- 与凭据同表：`secrets` 表 `kind='variable'`（建表语句在 `store/baseline.ts`）。**名称全局唯一，且与凭据共用同一个唯一约束**，重名返回 409 `name_exists`。凭据接口按 `kind != 'variable'` 过滤，两边互不可见。
- 值 AES-256-GCM 加密（`store/seal.ts`）。主密钥是数据目录下的 `secret.key`（32 字节，0600，缺失即新建，丢了所有值不可恢复）。解密结果按写入失效的内存快照缓存，每次工具调用复用。
- 限额：最多 64 个、明文合计 256 KB（`store/secrets.ts` 的 `VAR_COUNT_MAX`、`VAR_TOTAL_MAX`）；单值 4–16384 个字符。类型 `text` / `file`，创建后不可改；文件型只收文本，内容同样加密，元数据（文件名、字节数、行数、sha256）明文存列里，界面只显示指纹前 8 位。
- 名称文法有两套：新 `[a-z][a-z0-9_.-]{2,47}`（界面与带 `desc` 的新建请求只收它），旧 `[A-Za-z][A-Za-z0-9_]{0,63}`（只带 `purpose`、不带 `desc` 的新建请求仍按它收；库里已有的此类名字原样保留）。`{{@名}}` 只匹配新文法，旧文法里含大写或不足 3 位的名字只能写旧形式 `@名`（`permission/placeholders.ts` 的 `PLACEHOLDER_NEW` 与 `PLACEHOLDER_BARE`）。
- 描述（≤500 字符）在带 `desc` 的新建请求里必填，进上下文。其余列：`policy`（allow / ask / deny）、`expiry`（never / days / at）、`rotated_at`、`var_group`（变量组名，可空，1–32 个字符）、`last_used_at`，以及 `scope_kind` / `scope_target` / `tier`（§4 末）。接口缺省是 allow + 永久；界面新建默认「每次批准 + 30 天」。
- 有效期：days 从 `rotated_at`（缺省 `created_at`）起算，换值才重置（`store/secrets.ts` 的 `expiresAt`）。服务端 days 上限 3650，界面限 1–365。

## 3. 可见范围与变量组

- **启用关系**存在 `workspace_variables` 表（`workspace_id` + `variable_id`，变量删除时级联删，工作区删除时由 `WorkspaceStore.remove` 清；`store/workspace-variables.ts`）。会话看到哪些变量 = 它所属工作区启用的那些（`session/extensions.ts` 的 `visibleVars`，**每回合现查**，改了启用关系后下一回合的清单与替换立即跟着变；子代理会话与父同属一个工作区，自然沿用）。会话没有所属工作区一律看不到任何变量。
- 看不见的变量对这个会话等于没登记：不替换、不进上下文清单、不做引用检查，引用只留一条 `unknown`。
- 清单是一条隐藏的尾部消息（`customType: variables-notice`），名单变化才追加，不动前缀；清单写的是描述、`scope_kind` 与 `tier`，**不含引用策略与有效期**，所以 `deny` 与已过期的变量模型仍看得到，试用时才被拦。
- **变量组**：变量上的一个组名（`var_group`），**没有独立的组实体**，组靠成员「长出来」。一个变量只属一个组。服务端只提供改组名（改到已有的组名 = 合并）与解散（成员的组名清空）。**组与启用关系无关**：「勾一个组 = 批量勾成员」是界面的事，工作区里存的永远是具体勾了哪几个变量；之后新加进组的变量不会自动被已勾过该组的工作区拿到（决定：符合「默认全不开」）。
- **接口**：`PUT /api/v1/variables/:id/workspaces`（整份替换启用它的工作区）、`GET` / `PUT /api/v1/workspaces/:id/variables`（某个工作区启用的变量，id 清单升序；PUT 整份替换）、`PUT /api/v1/variable-groups/:name`（body `{name}` 改组名，返回 `{renamed}`）、`DELETE /api/v1/variable-groups/:name`（解散，204）；`POST /api/v1/variables` 可带 `group` 与 `workspaces`（先校验工作区都存在，否则 400 `invalid_workspace`，什么都不创建）；变量视图含 `group`、`workspaces`、`maskable`，没有 `scope` 字段。启用关系与组的改动都不记审计。

## 4. 引用与拦截

只有命令类工具做引用检查与替换：`bash`（后台跑也是 `bash`：`job_start` 的内层调用同一套；见 `permission/extension.ts` 的 `COMMAND_TOOLS`；其中的 `powershell` 在会话里从不声明，见 `session/delivery.ts` 的 `EXCLUDED_TOOLS`，所以没有替换逻辑）。顺序（`permission/extension.ts` 的 `gate`）：

1. 未登记（或不可见）的 `{{@x}}`：记 `unknown`，命令照常走，免得模板语法里的字面量被拦。
2. 已过期：拦截，记 `expired`。
3. 策略 `deny`：拦截，记 `denied`。
4. 其余按会话当前的审批档与目录规则判。策略 `allow` 只是不额外加严，**不等于免审批**，命令本身弹不弹窗仍看档位与规则；策略 `ask` 强制交人工且不可「记住」，已记住的规则也不放行。
5. 子会话没有审批通道，需要人工的一律拒绝（`unattended`）。
6. 放行记 `ok`；被拦（用户拒绝、超时、审核否决等）记 `dropped`。一次调用里同名只记一条，同一变量写多处也只是同一个环境变量。

范围约束（`permission/variables.ts`）：`scope_kind=domain` 的变量，用到它的每一条简单命令都要自己提到该域名；`sudo` 的只能写成 `printf '%s\n' {{@名}} | sudo -S …`；越界一律交人工。`tier` 与会话当前审批档取更严的一档，仅对策略非 allow 的变量参与，而 ask 最终总是交人工，实际影响很小。`scope_kind`、`scope_target`、`tier` 三项目前界面没有入口（缺口与影响见 §10）。

## 5. 替换与注入

- 改写按占位符所处的引号环境：无引号 `"${K}"`、双引号内 `${K}`、单引号内 `'"${K}"'`、heredoc 内 `${K}`；注释里的不动；`$(…)` 里重新判断。环境变量名是 `YUANSHU_VAR_<名>`，名字含 `.` 或 `-` 时编码成 `YUANSHU_VAR_0<名字的 hex>`（`permission/placeholders.ts` 的 `envKey`）。
- 本机：只对这一次调用的进程环境生效（`env/tools.ts` 的 `spawnHook`），不进会话环境。
- ssh：Server 本机环境不带去远端，只转发 `YUANSHU_VAR_` 前缀的（`env/tools.ts` 的 `sshBashOperations`）；值经 stdin 喂给远端的 `eval "$(head -c N)"`（N 是要读的字节数，stdin 不关），每个值做 shell 单引号转义，远端 `ps` 看不到（`env/ssh.ts` 的 `exec`）。
- 后台任务（`job_start` 里的 `bash`，或阻塞的 `bash` 到提醒时间转成的后台任务）与前台走同一条路径：登记的命令是占位符原文；日志写在 Server 数据目录的 `jobs/<任务 id>.log`，写盘前已经过 bash 输出流的遮罩；值留在已启动进程的环境里，过期或删除变量不会终止它（按代码推断）。
- 文件型变量按内容替换，**不落临时文件**：`cat {{@名}}` 这类要路径的用法用不了。

## 6. 回显遮罩

输出里出现的真值精确匹配后换回 `{{@名称}}`（凭据换成 `[凭据 名]`）。覆盖面：

- bash 输出流，含截断落盘的全文，只对当前可见的变量（`env/tools.ts` 的 `wrap`）；
- 所有工具的 `tool_result`，含 `details`、`structuredContent`，对全部变量与凭据，图片块不动（`permission/masking-extension.ts`）；
- hook 的入参与输出（`hooks/runtime.ts`）、后台任务的日志在写盘前已遮罩（`job/bash.ts` 包在遮罩层外面，收到的就是遮罩后的输出）。

限制：只遮不少于 `MASK_MIN = 8` 个字符的值，更短的（如 sudo 密码）可登记但不遮，视图里 `maskable=false`；只做确定性精确匹配，编码、拆分后的回显匹配不到；后台任务的日志只有遮罩后的内容。

## 7. 引用记录

表 `variable_refs`（`store/references.ts`，只追加，无清理策略，不随变量或目录删除而删）：变量名、目录 id、主机（环境）id、run id、tool call id、时间、结果（`ok` / `denied` / `expired` / `unknown` / `dropped`）、命令。

- 命令列先用**全部真值**遮罩（门槛取登记下限 4 个字符，比回显的 8 更严），再截成含该占位符的 ≤500 字符一段，所以库里不存真值；构造时没给遮罩源就不存命令。顺序不能反：先截后遮，被切在窗口边界的值会漏。
- 写入失败不影响命令；`ok` 时顺带更新变量的 `last_used_at`。
- 接口 `GET /api/v1/references`：按目录、变量名、结果筛，`before` 游标翻页，默认 100 条、上限 500。
- 只有 agent 发起的引用才记。

## 8. 设置页与审计

页面在 `web/src/features/settings/variables/`，用设置页框架的标准件（skill `ys-ui-build` 的 components §5）：页签「变量」「引用记录」；「变量」页是主从布局——左列表按变量组分段（组头可折叠，悬停出「重命名 / 解散变量组」菜单，没分组的在最后的「未分组」），行上只有名字、描述一行与状态（过期 / 禁止 / 未启用才出字），悬停浮出「⋯」菜单（复制引用写法、删除）与只读详情卡片（描述全文、变量组、类型、策略、有效期、启用于哪些工作区、最近引用）；右侧是选中变量的全部设置：

- **值**：遮罩显示、「显示」（8 秒后自动重新遮挡）、复制、轮换，以及有效期。这些除有效期外都是**操作**，立即执行。值太短（不足 8 个字符）的变量提醒「回显遮挡不住」。
- **启用于工作区**：勾选清单（默认都不勾）。
- **引用与说明**：引用策略（自动放行 / 每次批准 / 禁止）、变量组（下拉，可新建）、描述。
- **保存**（skill `ys-ui-design` 的 X06）：有效期、启用的工作区、策略、变量组、描述进草稿，改了才在底部浮出保存条；保存只发有变化的字段（`PATCH` 基本信息，再 `PUT` 启用关系，前一个失败就不发后一个）；成功 / 失败都在右下角提示，失败保留草稿；切换变量、切页签、点设置导航、返回工作区时有未保存的修改会先问。
- **添加变量**弹窗：名称、描述、值（文本 / 文件）、变量组直接填；引用策略 / 有效期 / 启用于工作区折成摘要行（默认「每次批准 · 30 天 · 都不启用」），点进去是二级页。
- **编辑工作区**弹窗里有一行「隐私变量」（`features/workspace/dialogs/editors/VariablesEditor.tsx`）：点进去按变量组三态勾选（组行带「n / m」，勾组 = 勾上组里现有的全部，展开后可单独取消；一开始只展开勾了一部分的组，之后展开 / 收起由用户决定），保存工作区时一并 `PUT /workspaces/:id/variables`；新建工作区先创建再写清单。变量读不到时这一行只说「还没有隐私变量」，保存不会发覆盖请求。
- **引用记录**页签：筛选「全部 / 放行 / 拒绝」、目录下拉；从变量详情的「查看记录」进来只看这个变量（按 `name` 查，可点芯片清除）。目录 · 环境两列的主机名取自连接列表。
- **审计**：看值与复制都先走 reveal，写 `audit_log`（`kind=secret`，detail 只有 id 与名称）；轮换（`POST /api/v1/variables/:id/rotate`，换值、days 重新起算）也写；新建、PATCH、删除、启用关系、变量组改动不写。这些都不进引用记录。
- **删除**：历史引用记录保留但不再对应变量，它在各工作区里的启用随之取消。
- **没有吊销**：它与策略「禁止」重复，服务端也没有吊销态。要让引用失败用策略「禁止」，要让值失效用轮换或有效期。

## 9. 服务端凭据

供应商的 key 与主机的连接信息**不注册成变量，也不聚合展示**，变量页只有用户自己建的变量。这些凭据由 Server 自己用（API key 随请求附带、ssh 密钥建连），值只参与回显遮罩（`[凭据 名]`，`SecretStore.maskVars`），模型引用不了、变量页也看不到——要看它们去「供应商与模型」「远程连接」页。

## 10. 未实现与未决

未实现（有设想或决定、没有对应代码）：

- 文件型变量落 0600 临时文件（设想的路径形如 `/run/od/<run>/<名称>`）：没做，按内容替换，`cat {{@名}}` 这类要路径的用法用不了。
- 「仅本次会话」不落盘的档位：变量没有，一律加密落库；该档位只属于供应商 key 的存放方式（文案「仅本次运行」，见 `web/src/features/settings/providers/model.ts`）。
- 轮换后追溯旧指纹：没做，轮换只覆盖 `file_meta` 与 `rotated_at`。
- 引用记录的保留与清理策略：没做。
- 变量组的「按组实时跟随」没做，是有意的（§3）。

已知缺口：

- **`scope_kind`（域名 / sudo）、`scope_target` 与 `tier` 界面没有入口**，界面新建的变量恒为 `any` / `rules`，只有直接调 REST 才能设。该项暂缓，理由是它不是最影响体验的部分。影响面：
  - **sudo 要密码是唯一的功能缺口**。`sudo -n -l` 探测（`permission/sudo.ts`）分三类：免密 → 照常审批并标注；认不出 → 照常弹窗；**要密码** → 命令里没按规定写法提供 sudo 范围变量时不弹窗、直接拦下，理由里让模型去找 sudo 变量，没有就说「请让用户在设置里登记 sudo 密码，或配 NOPASSWD」（`permission/extension.ts` 里探测结果为 `password` 的分支；完全允许档也拦，免得命令去卡 tty）。**要密码的唯一通道是 sudo 范围的隐私变量**（模型写 `printf '%s\n' {{@名}} | sudo -S -p '' 命令`、用户批准、密码只传给这一条命令），而界面建不出 sudo 变量，所以要密码的主机上 agent 会被拦，眼下只能靠 NOPASSWD 或直接调 REST。
  - **没有「手工临时输入」这条路**：代码里没有让用户临时输一次密码的弹窗，也没有这样的设计。用户可以在终端标签里自己敲 sudo，但那不是 agent 流程。
  - **只有单测，没真机验证**：`permission/sudo-flow.test.ts` 的探测结果是假的，没有在真实主机上跑过要密码的 sudo。
  - 域名绑定：不影响功能，是「变量只出现在提到该域名的命令里」的防泄露保险；界面建的变量一律 `any`，这层没开，但变量默认「每次批准」，用到时本来就要人点。`tier`：基本没影响（只对策略非 allow 的变量生效，而 ask 最终总是交人工），不管。
  - 补法有两条（都没排期）：①变量页加「使用范围」（任意 / 域名 / sudo），走现有通道，改动最小；②弹窗时现输一次密码、不落库只用这一次，要新做。
- 带引号分隔符的 heredoc（`<<'EOF'`）里的占位符同样被改写成 `${…}`，而 shell 不会在这种 heredoc 里展开，值进不去；测试只覆盖不带引号的写法，按代码推断，未实测。

未核实：

- 会话没有所属工作区时看不到任何变量，这一条只由间接用例覆盖，没有专门的测试。
