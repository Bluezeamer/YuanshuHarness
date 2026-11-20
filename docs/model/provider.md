# 供应商与模型

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`packages/server/src/provider/`、`store/{providers,baseline,session-configs}.ts`、`api/{providers,provider-login,default-model}.ts`、`server.ts` 的相关片段，以及 `packages/web/src/features/settings/{providers,defaults}/`、`features/workspace/dialogs/model/catalog.ts`、`features/chat/tab/models.ts`；只读代码、未运行；未核实的项文中已标）

设置页「供应商与模型」决定会话能选哪些模型、用什么凭据去连。页面是「左边已配置的供应商列表、右边选中那个的连接 / 模型 / 高级」；models.json 预览放在「高级」里的弹窗中，没有独立页签。全局默认模型不在这里设，在「默认值设置」页（即 [`workspace.md`](workspace.md) §3 的「全局默认」层）。本文的「模型目录」指 pi 自带的模型注册表（代码里叫 `catalog`），与 workspace.md 里的「目录」（主机 + 路径）无关。路径约定：服务端省略 `packages/server/src/`，前端以 `web:` 开头并省略 `packages/web/src/`。

## 1. 数据

供应商存在 `providers` 表，一行一家（建表语句在 `store/baseline.ts`，读写在 `store/providers.ts`）。模型清单、兼容项、上次测试是行内 JSON；API key 只存密码库条目的引用 `secretId`，任何响应都不含 key，只有 `hasKey` 与来源名。

| | 内置 | 自定义 |
|---|---|---|
| id | pi 的供应商 id | uuid；另有用户填的标识 `slug`（唯一，是 models.json 的键） |
| 名称 / 协议 | 取自模型目录，不可改（`builtin_immutable`） | 用户填，协议四选一 |
| 行 | 用户第一次保存或测试时才建；没有行即全部默认 | 创建即有 |
| baseUrl | 可覆盖（区域端点、代理），清空恢复 | 必填，http(s) |
| models | 只存用户添加的，**视图也只返回这些**（不带目录里的全部模型）；目录规格另见 `GET /providers/:id/catalog-models`；解析模型时仍是「目录条目叠上用户保存的同 id 规格」（§3） | 全部模型 |
| 认证方式 | 见下 | key / env / cmd |
| 删除 | `DELETE`：界面上对用户就是「删除」，内置供应商底层只是清除配置——删记录、密钥条目、自己添加的模型、地址覆盖，认证方式是订阅的顺带退出登录；204，不报错、不拦（环境变量不受影响） | 删除端点；有会话指定了它的模型时 409 `in_use`，见 §9 |

- **协议四种**：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。只有自定义供应商受此限制；内置的协议取自模型目录（取出现最多的一种），可能不在四种里（如 `mistral-conversations`）。
- **认证五种**：`oauth`、`key`、`env`、`cmd`、`ambient`。内置供应商：目录声明支持订阅时有 `oauth`，另有 key / env / cmd；`amazon-bedrock`、`google-vertex` 只有 ambient 和 key（`provider/catalog.ts` 的 `Catalog.methods`）。
- **思考七档**：off、minimal、low、medium、high、xhigh、max。沿用 pi 的规则：xhigh / max 必须显式映射才算支持（`provider/catalog.ts` 的 `levelsOf`）；models.json 预览里勾了而没填映射的，写成同名。
- **模型规格** `ModelSpec`：id、name、reasoning、levels、`defaultLevel`（可选；在选择器里**换到**这个模型时思考档位的起点，须是 levels 里的一档或 `off`，且模型要支持思考；只是预填、不改任何会话现有的档位，服务端建会话时不读它，也不会写进 models.json）、map（档位到端点参数值，留空即同名）、input、ctx、out、source（`catalog` 目录 / `probe` 端点列表 / `manual` 手填）。**没有成本字段，也没有 temperature / top_p**，这是有意的，不要加回来（`store/providers.ts` 里 `ModelSpec` 的注释同）。input 可含 audio / video，交给 pi 时只留 text / image。校验见 `api/providers.ts` 的 `parseModel`：没开 reasoning 就不能有 levels，map 的键须在 levels 内，input 必含 text，每家最多 1000 个。
- **待补全**：ctx 或 out 任一为 0 即算，按模型计（`web:features/settings/providers/model.ts` 的 `needsFill`）。
- **协议兼容 compat**（仅自定义）：`supportsDeveloperRole`、`supportsReasoningEffort`、`requiresThinkingAsText` 三态（键缺省 = 自动按 URL 推断），`maxTokensField`、`thinkingFormat` 选值或自动。只收白名单键。
- **自定义鉴权头**（仅自定义）：写成「头名」或「头名: 前缀」，密钥拼在前缀后；留空按协议默认（Bearer / x-api-key）。与默认头同名则取代，否则追加（`provider/auth-header.ts`、`provider/probe.ts` 的 `authHeaders`）。

## 2. 凭据

- **解析链四档**，从高到低，第一个命中的生效，设置页如实列出每档是否命中（`provider/credentials.ts` 的 `inspectCredential`）：`--api-key`（会话档）→ `auth.json`（pi 自己存的凭据，含订阅登录；或保存位置选「密码库」的 key）→ `models.json`（保存位置选 models.json 的 key，或命令）→ 环境变量 / 云凭据。内置供应商的 auth.json、环境变量、云凭据状态问 pi（`runtime.checkAuth`）；自定义供应商没注册进 pi，由元枢自己判。
- **保存位置三档** `keyStorage`：
  - `auth`（默认，界面标「密码库」）与 `models`：**都**存进元枢的加密密码库（AES-256-GCM，`store/secrets.ts`），既不写 pi 的 auth.json，也不写 models.json；区别只在解析链落哪一档、预览里是否出现占位 `••••`。值 `auth` 只是取值名，密钥实际存在密码库，并不在 pi 的 auth.json 里。
  - `session`：只在进程内存（`ProviderStore.sessionKeys`），重启即失。
- 只改保存位置、不给新 key 时，旧 key 自动搬过去；换 key 时旧条目在记录保存成功后才删；被供应商引用的密码库条目不能单独删（`server.ts` 里给 `SecretStore` 登记的 `addReferrer` 检查）。条目名 `provider:<标识>:<8 位随机后缀>`。
- **环境变量**：自定义供应商填变量名，读元枢进程的环境；内置的由 pi 决定，WebUI 只读。
- **命令**：在 Server 主机上 `/bin/sh -c` 执行，取输出第一行，超时 5 秒；**每次解析都重新执行，不缓存**（`provider/credentials.ts` 的 `runCommand`）。
- **订阅（oauth）**：登录由服务端调 pi 的 `ModelRuntime.login` 完成，界面在弹窗里走完（授权链接 + 粘回授权码，或设备码），见 §7；登录成功后供应商的 `method` 记为 `oauth`，退出登录改回默认（API Key）。凭据存在 pi 的 auth.json，元枢不碰令牌。
- **云凭据（ambient）**：只用于 bedrock / vertex，取自 Server 主机的环境，不读不存。

## 3. 会话怎么取到模型

会话的 `{provider, model}` 按此顺序解析（`provider/resolve.ts` 的 `ModelResolver.buildOne`）：

1. **旧的「模型登记」**（`/api/v1/models`，`store/models.ts`）：provider 命中旧登记 id 就用它。设置页没有入口（web 里只剩 API 客户端封装、没有调用方），服务端仍参与解析，见 §9；两边 id 不会撞（旧的与自定义是 uuid，内置是 pi 的供应商名）。
2. **供应商登记**：
   - 内置：目录条目叠上用户保存的同 id 规格（上下文、输出、思考映射、模态），不叠的话设置页里改了只是摆设。目录里没有的模型（手加或从端点导入）借同家目录的第一个模型合成，用它的协议与端点；ctx / out 为 0 时回落 128000 / 16384（`ModelResolver.builtinModel`）。设了 baseUrl 覆盖就换端点。
   - 自定义：每次构造都 `registerProvider` 进**共享** runtime（重复登记会替换模型清单）。共享是因为会话运行中换模型（`setModel`）时，目标供应商必须被同一个 runtime 认得。
3. 都找不到就回落全局默认（§4），再没有则返回 null，沿用 SDK 默认配置。

自定义登记的硬约束（`provider/resolve.ts` 的 `customProviderConfig`）：

- 每个模型必须给占位 cost（全 0）：`registerProvider` 不像 models.json 会补默认成本，缺了它，每轮结算用量时抛错、整轮 `run.failed`。这是 pi 的内部要求，不是产品里的成本字段。
- `apiKey` 填占位 `"none"`，否则无鉴权的本地服务会被 SDK 判为未配置；真实 key 另由 `setRuntimeApiKey` 注入。设置页改 / 删 key 后同步，只撤销元枢自己设过的，不碰 pi 自己的来源（`applyKey`）。
- 自定义鉴权头的值里带密钥，写进 pi 的 headers 前要转义 `$` 与开头的 `!`，否则会被当成变量引用或命令。
- 「测试连接」用同一份配置，但登记进临时 runtime，不碰共享的，免得测试替换正在运行的会话用的模型清单（`api/providers.ts` 的 `sendFirstToken`）。

## 4. 全局默认模型

- 存在 `meta` 表的 `default_model`：`{provider, model, thinking}`。`PUT /api/v1/default-model` 要求该模型可解析（否则 404 `unknown_model`），thinking 须是七档之一或 null。
- 在「默认值设置」页选供应商 / 模型 / 启动思考级别，即时保存。**换模型 / 供应商时**：该模型声明了 `defaultLevel` 就落在它；否则当前档位仍受支持就保留，不支持取启动档位（不能思考为 off，有 low 取 low，否则取第二档，`web:features/settings/defaults/model.ts`）。只改档位本身时不动用户的选择。会话 / 工作区弹窗（`web:features/workspace/dialogs/model/catalog.ts` 的 `settleModel`）与聊天输入栏（`features/chat/tab/models.ts` 的 `levelOnSwitch`）换模型时同样先看 `defaultLevel`；没有则沿用当前档位，当前档位不被支持时的回落略有不同（前者取声明的第一项，后者取最近的一档）。
- 读取顺序（`provider/resolve.ts` 的 `ModelResolver.default()`）：已设且仍有效 → 旧登记里标默认的那条 → **最早登记的、带有用户选入模型的供应商的第一个模型**（thinking 为 null）→ null。默认指向的模型或供应商被删后同样回落，不报错。
- 添加模型**不会**改写已设的默认，也没有「首次添加就设为默认」的写入逻辑；没设过默认时靠上面的回落，让第一次配好的模型直接可用，所以添加第一个模型会让默认「凭空出现」。（供应商页不标「默认」，更改只在「默认值设置」页。）
- 会话的模型配置是 `follow-default` 或 `explicit`（`store/session-configs.ts` 的 `ConfigModel`）。聊天里的模型选择器只列状态不是「未配置」、且上次测试没失败的供应商（`web:features/chat/tab/models.ts` 的 `selectableProviders`）。

## 5. 状态与测试连接

**状态**（`provider/view.ts` 的 `statusOf`）：

- 没有任何凭据命中 → 未配置。例外：自定义供应商选了 API Key 却没填，视为无鉴权的本地端点，不算未配置。
- 上次测试失败 → 连接失败；自定义供应商没测通过 → 待核验（无鉴权端点没有凭据可证明连得上，所以必须测通才算已连接）；其余 → 已连接，即内置供应商有凭据就算。
- 界面：绿已连接、琥珀待核验、红连接失败、灰未配置。

**测试连接**（`provider/diagnose.ts`、`api/providers.ts` 的 `POST /providers/:id/test`）依次四阶段：凭据 → 端点 → 模型列表 → 首 token。前一阶段失败，后面标「未执行」；每阶段超时 15 秒（`api/providers.ts` 里 `timeoutMs` 的缺省值）。

- 凭据：没有就失败，并按认证方式给出怎么配的指路文案。
- 端点：不带凭据请求 baseUrl，任何 HTTP 应答都算可达；不跟随重定向，免得自定义鉴权头被带去别的主机（`provider/probe.ts` 的 `get`）。
- 模型列表：`GET {baseUrl}/models`，只取 id；401 / 403 记 `unauthorized`，空列表算失败。Anthropic / Gemini 的内置 baseUrl 不带版本段，探测时补 `/v1`、`/v1beta`（`provider/probe.ts` 的 `modelsUrl`）。**能力（上下文、模态、思考档位）无法探测**，只能用户补全。
- 首 token：**真实发一次推理请求**（用户消息 `ping`，`maxTokens: 16`），收到第一个文本或思考增量即通过。测试用哪个模型：指定的 → 用户选入或目录里、且端点也有的第一个 → 端点列表第一个；不可探测的供应商没有端点列表，取用户选入或目录里的第一个。
- 不可探测的供应商（`probeable=false`：协议不在四种里，如 bedrock、mistral，或没有 baseUrl）跳过端点与模型列表两步，只验凭据与首 token。
- 结果只留最近一次 `lastTest`（时间、是否通过、首 token 耗时、总耗时、止于哪一阶段、错误码），没有历史、没有「连接诊断」页签。错误文本回显前遮掉本次涉及的 key（`provider/diagnose.ts` 的 `redact`）。改了连接相关字段（协议、地址、认证、key、鉴权头、compat 等）会清空 `lastTest`；改模型清单不清。

## 6. models.json 预览

- **只读预览**加与磁盘文件的差异，**不写盘**（`GET /api/v1/models-json`）；入口在供应商页「高级」里的「将生成的 models.json」，在弹窗里展示。元枢自己的运行时不读 models.json（`Catalog.create` 传 `modelsPath: null`），预览的意义是「若导出给 pi 会是什么样」。没有 auth.json 视图。
- 内容（`provider/models-json.ts` 的 `liveModelsJson`）：自定义供应商以 slug 为键，输出 baseUrl、api、apiKey、headers、compat、models；内置供应商只输出有变动的部分（baseUrl 覆盖、`modelOverrides`、目录外新增的 models），不重写目录。apiKey 写法：保存位置选 models.json → 占位 `••••`；环境变量 → `$变量名`；命令 → `!命令`；其余不输出（`apiKeyOf`）。
- 磁盘文件里手写的明文 apiKey 回显前遮成 `••••`（`$`、`!` 开头的引用不遮）；差异按路径列出叶子变化，数组里带 id 的元素按 id 对齐。

## 7. 设置页行为

**版式**：

- **左边只列用户添加过的供应商**（`ProviderView.added`）：自定义端点全部；内置的要么库里有记录，要么是本次刚在「添加」里挑出来的、或正在看的（刷新页面后才消失）。**只有环境变量里有凭据的内置供应商不上架**（理由：它的凭据来自环境变量，元枢删不掉，删除后状态仍是已连接，列在左边会像删除失败；例如环境里有 `ANTHROPIC_AUTH_TOKEN` 的 Anthropic）；想用它就在「添加供应商」里挑出来，模型解析本来就能用到环境凭据。每行：字母标记、名称、「N 个模型」或状态、状态点。自定义端点在「更多操作」里「删除」，内置供应商在同一处也叫「删除」（用户侧不区分，底层只是清掉元枢保存的密钥、订阅登录、地址覆盖和自己添加的模型），都要弹窗确认；弹窗写明会删什么，环境变量里的凭据不归元枢管、不受影响。
- **「添加供应商」弹窗**：自定义端点固定排第一，下面是全部内置供应商（可搜索，已在左边的灰着点不了，支持订阅登录的标出来）。选内置的立刻出现在左边并选中，不写任何东西；选自定义端点进「添加自定义端点」表单（名称、标识随名称生成、协议、Base URL、可选 API Key，标识规则见下）。
- **右边详情**：页头（字母标记、名称、协议、状态点、「测试连接」、「更多操作」（一律是「删除」））；页头下给测试结果（成功一行摘要，失败给原因与下一步，上次失败的原因在重新打开页面后仍显示）；然后是「连接」「模型」「高级」三块。字号、间距、控件全部用 `ui/` 与字样角色，没有区块标题旁的英文标记。

**连接**：

- 「登录方式」分段只有在供应商同时支持几类方式时才出现：**订阅登录 / API Key**（bedrock、vertex 是「环境凭据 / API Key」）。`env`、`cmd` 也是取得 API Key 的方式，归在 API Key 这一类，选择放在「高级」的「密钥来源」里。内置供应商**默认 API Key**（跟服务端的 `defaultMethod`）。
- **订阅登录**：行里只有「已登录」+「退出登录」，或「还没有登录」+「登录」。「登录」打开弹窗，由服务端在后台跑 pi 的登录流程，前端每秒轮询状态：有授权链接就摆出来（复制 / 打开），要用户粘回授权码就给输入框，设备码流程显示设备码并等着，结束由服务端给出（成功 / 失败带原因 / 取消）；没走完就关掉弹窗会通知服务端取消。已登录与否看解析链里 auth.json 那一层是否命中，不显示账号（pi 的凭据里没有统一的账号字段）。
- **API Key**：已保存显示成一行（「更换」「移除」），要换才出输入框；保存后不再回显。env / cmd 方式下是只读的来源说明，「改为直接填写」切回。
- 自定义端点另有名称、请求协议；地址一行（内置供应商可覆盖，「恢复默认」发 null）。
- 改动即时保存（输入框失焦或回车提交），没有防抖；写操作在 store 里串行，payload 轮到时才基于最新数据构造，连续快速编辑不会互相覆盖（`web:features/settings/providers/store.ts`）。

**模型**：

- **上下文长度与最大输出**可写纯数字，或带 K / M 单位（不分大小写，可带小数，如 `256K`、`1M`、`0.5m`），K、M 按 1024 算（256K = 262144，1M = 1048576）；列表里读回来按十进制显示（262k）。
- **列表里只有「已添加的模型」**，新对话里选得到的就是它们。每行：名称，右侧标记「思考」（有档位）、「视觉」（input 含 image）、上下文长度（ctx 或 out 为 0 显示「待补全」）。超过 5 个先收起，超过 8 个出搜索框。内置供应商也一样只列已添加的，**每个都能移除**（移除 = 取消添加）；目录里的模型要先在「从端点获取」里挑出来才算添加。
- **「从端点获取」与「手动添加」是两件事**：前者打开只读弹窗，`GET /models` 取回端点上有什么（只有 id，没有规格），已添加的灰着，勾选后点「添加所选」才进已添加列表（`source=probe`，标「待补全」，上下文等事后点开补全）；单纯获取不改动任何已添加的模型。没有凭据时弹窗里直接给服务端的指路文案。**内置供应商也走这条路**：探测到的 id 在目录里有就复制目录规格添加（不标「待补全」），协议不能探测的内置供应商（`probeable=false`）改为直接列目录模型当候选；自定义端点不能探测（没有 Base URL）时按钮禁用，只能手动添加。
- **编辑弹窗**（点一行）：模型 ID（目录模型与已建的不能改）、上下文、最大输出（可留空稍后补）、支持图片输入、支持思考；开思考后勾**思考档位**（off 到 max 七档，默认先勾 off / minimal / low / medium / high，xhigh / max 要用户自己勾；至少留一档，全取消等于关闭思考）、**默认档位**（只能从勾选的档位里选，取消那一档自动清掉）、折叠的「各档发给端点的取值」（留空按档位名发）。编辑一个模型保留它原有的 `source`，「手动添加」新建的是 `manual`。

**高级**（默认折起）：标识（自定义）、密钥来源（直接填写 / 读环境变量 / 运行命令取得）、保存位置（密码库 / 仅本次运行；不提供 `models.json` 一档，因为预览不写盘）、鉴权头（自定义）、最大并发请求数，以及三行进弹窗的：协议兼容（自定义，三态 + 两个选值，每改一项就保存）、凭据解析顺序（四层，标出生效的）、将生成的 models.json（只读预览）。

- 新建自定义端点：标识须匹配 `^[a-z0-9][a-z0-9-]{0,62}$`，且不能与任何内置供应商 id 或其他自定义标识重复，否则 409 `slug_taken`（`api/providers.ts`）。保存后状态为待核验。

## 8. 订阅登录接口

`provider/login.ts`、`api/provider-login.ts`：

- `POST /providers/:id/login` 发起（立即返回 `LoginState`，登录在后台跑）、`GET /providers/:id/login/:loginId` 轮询、`POST …/answer` 回答提示（`{promptId, value}`）、`DELETE …/login/:loginId` 取消（幂等）、`POST /providers/:id/logout` 退出并改回默认方式。
- `LoginState` 是拍平后的 `{loginId, status: running|done|failed|cancelled, link, device, message, prompt, error}`，不暴露 pi 的原始事件流。
- 同一供应商再发起会取消旧的；10 分钟超时；结束后保留 5 分钟供最后一次轮询。只对目录声明支持订阅的内置供应商可用（否则 400 `oauth_unsupported`）。

## 9. 未实现与未决

未实现（没有对应代码）：

- **登录成功后显示账号名**：pi 的凭据里没有统一的账号字段。
- **models.json 落盘**：应用 / 保存前重读校验 / 与 TUI 共享同一文件都没做；保存位置选 models.json 目前只是预览里的占位，key 仍在密码库。
- **auth.json 视图、核验历史与诊断记录页签**：没有，只留最近一次 `lastTest`。
- **测试连接的提示**：按钮旁没有「会产生一次极小的真实调用」的提示；测试结果只显示一行摘要或失败原因，没有按阶段展开的明细。
- **移除自定义端点前列出在用会话并确认**：现状是硬拦：任一会话（含池内未落库的）配置为 `explicit` 且指向该供应商，就返回 409 `in_use`（`server.ts` 里传给 `providersApi` 的 `inUse`），要先把会话换到别的模型；`follow-default` 的会话不拦，回落到默认。前端提示文案写的是「Agent」，实际检查对象是会话。

明确不做：

- **成本字段、供应商页上的审核模型设置**。审批模型在全局设置里配一个，见 [`prompt.md`](prompt.md) §3 P5（设置 · 默认值）。

未决：

- **旧 `/api/v1/models` 登记**：服务端仍在并参与解析（§3），设置页没有入口；是否清理未定。
- **`in_use` 的检查范围**：只看会话配置；工作区默认配置、全局默认模型指向被删供应商时的行为没有逐一核对（全局默认的回落见 §4）。
- **解析链与 pi 内部优先级的对照**：「运行时 key 先于 auth.json」对照过 pi 的实现；其后各档（models.json、环境变量 / 云凭据）的相对顺序，按元枢代码的注释与实现写，未逐一对照 pi 源码。

已知缺口（读码推断、未运行）：

- `session` 档的 key 重启丢失后，自定义供应商按「无鉴权端点」处理；若 `lastTest` 仍是通过，状态会继续显示已连接，直到真实请求 401。
