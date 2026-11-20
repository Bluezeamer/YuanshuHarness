# 远程连接

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`packages/server/src/` 下 `env/{activation,hub,ssh}.ts`、`ssh/{connection,fingerprint}.ts`、`store/{connections,environments,secrets,seal,baseline}.ts`、`api/{connections,environments}.ts`、`session/directory-resolver.ts`，与 `packages/web/src/features/settings/remote/` 下的 store、model、errors、ConnList、ConnDetail、AddressSection、AuthPolicySection、Mounts、KeysTab、LogTab、NewConnModal；只读代码、未运行；未核实的项文中已标）

设置页「远程连接」管理 server 能 ssh 到的主机：登记、激活、断开、主机密钥核对、跳板、密钥。术语：本文的「目录」= 主机 + 固定路径（代码里叫 `directories`；指向连接的列是 `environment_id`）；「工作区」是顶层概念，见 [`workspace.md`](workspace.md)。文中不带目录的 `model.ts`、`store.ts` 指 `packages/web/src/features/settings/remote/` 下的同名文件。

## 1. 数据：连接就是环境表的一行

- 没有独立的连接表。连接 = `environments` 表的一行，除 `host / port / username / os / secret_id / host_key` 外还有 `jump_id`、`policy_json`、`host_key_pending`、`host_key_changed_from`、`host_key_accepted_at`、`last_active_at`（建表语句在 `store/baseline.ts`；读写在 `store/connections.ts`、`store/environments.ts`）。
- 本机（id `local`）不入表；虚拟环境（附件区 `attachment`、协作区 `collab`）不登记、不进列表（`store/environments.ts`）。`GET /api/v1/connections` 只列 ssh 连接，另带 `server` 字段指向本机，页面的跳板链从它开始画（`api/connections.ts`）。
- 名称唯一（库约束，409 `name_exists`）。「同主机 + 端口 + 用户不得重复」只有前端拦（`model.ts` 的 `validateForm`），服务端不查。
- 状态不落库，由三处派生（`env/activation.ts` 的 `Activator.status`）：有进行中的激活为 `activating`；`host_key_pending` 非空为 `verify-required`；否则看 `hub.isConnected`，即 `active` 或 `inactive`。页面再叠加「激活失败」（最近一次激活过程为 failed，`model.ts` 的 `stateOf`）。
- 激活过程（六步进度、错误）与「暂停」「钉住」都只在内存。服务端重启后所有连接回到未激活，没有启动时恢复；只有 `host_key_pending` 和指纹记录在库里。

## 2. 激活

`POST /connections/:id/activate` 立即返回 202，页面每 400ms 轮询 `GET /connections/:id` 的 `activation`。`start` 依次拒绝（409）：

- `activating`、`already_active`。
- `busy`：同时只允许一条连接在激活。这是全服务端一个，不分用户；多标签页以服务端为准，返回正在激活的那条。
- `verify_required`：指纹待核对时不再发起，必须先 trust，以保证核对前不发凭据。
- `jump_inactive`：直接跳板未激活，返回是哪一条。只查直接上一级，更上游由它自己的激活保证。

六步（`env/activation.ts` 的 `ACTIVATION_STEPS`）：解析主机、TCP 连接、主机密钥、认证、远端探测、控制通道；线上取值是英文 id（`resolve / tcp / hostkey / auth / probe / channel`，步骤里的 `id` 与失败时的 `failedStage`），中文名只用于展示。耗时与细节是真实测量值。

- 解析主机：直连且 host 不是 IP 时在 server 上做 DNS；经跳板则跳过，由跳板去解析。
- 第 2 至 4 步对应 `SshConnection.connect` 的 `tcp / hostkey / auth` 三个阶段（`ssh/connection.ts`）。就绪超时 15 秒，保活间隔 20 秒，都写死（同文件的 `readyTimeout`、`keepaliveInterval`）。
- 远端探测：只读，`uname -sr; uname -m`，`os=windows` 时用 `ver`，8 秒超时（`env/ssh.ts` 的 `SshEnv.probe`）。不在远端装任何东西。探测到的一行由 `hub.setFacts` 缓存（只在内存；每次激活开始时随 `forget` 丢掉、探测成功后重写，断开不丢），给提示词的「环境信息」段用（`prompt.md` S4）。
- 控制通道：取远端家目录（SFTP `canonical(".")`），之后文件原语与命令都复用这一条连接。
- 失败停在对应步并带错误码（`dns_failed`、`tcp_refused`、`auth_failed`、`hostkey_changed` 等，文案在 `web:features/settings/remote/errors.ts`）。最后一步完成的同时被取消，不算成功。

成功后 `hub.pin`、写 `last_active_at`，审计记「激活成功」。「取消」就是对进行中的连接做断开：审计记「已取消激活」，不当作失败，也不再多记一条「已断开」。

**钉住**：激活成功的连接继续使用现有连接，之后改登记只让 `dirty` 为真，下次激活才生效（`env/hub.ts` 的 `getSsh`）；每次激活开始时 `prepareActivation` 丢掉旧连接并解除暂停。这样改配置不会踩到正在跑的会话。比较用的签名含 host、port、user、os、secret、jump 与整个 `policy`（`env/hub.ts` 的 `signature`），所以连不生效的两个策略开关也会置 dirty；改名不算。

- 激活期间 `host / port / user / os / auth / jump` 被锁，`PATCH` 返回 409 `activating`（`api/connections.ts` 的 `LIVE_FIELDS`）。已激活时服务端不拦，页面也允许直接改（§7）。
- 改 host 或 port 会清空指纹记录，含待核对与历史指纹（`ConnectionStore.update`）；改名、换用户、值没变都不动。

## 3. 主机密钥

校验在 ssh2 的 `hostVerifier` 里（`ssh/connection.ts`），发生在认证之前，所以阻断时没有发过任何凭据：

- 与记录一致：放行。
- 无记录：策略 `tofu`（页面「自动记录」）直接记下并放行；策略 `ask`（页面「询问」，新建连接的默认）把看到的指纹写进 `host_key_pending` 并阻断，错误码 `hostkey_unknown`。
- 有记录但不符：**与策略无关，一律阻断**，写 pending，错误码 `hostkey_changed`。可能是主机重装，也可能是中间人，所以永不自动信任。
- 策略是每条连接各自的（`policy.hostKey`），不是全局开关，在连接详情的「连接策略」里改。没有 `policy_json` 的环境（经环境接口 `POST /api/v1/environments` 建立的）按 `tofu` 处理（`store/connections.ts` 的 `LEGACY_POLICY`）。

`POST /connections/:id/trust` 只做转正：pending 变成 `host_key`，旧值写进 `changed_from`，记 `accepted_at`；没有 pending 时 409 `nothing_to_trust`。**服务端不会自动继续被阻断的激活**，必须再调一次 `activate`。「自动继续」只在页面里成立：连接详情里的核对条「信任并继续」是先 `trust` 再 `activate`（`store.ts` 的 `trustAndActivate`）；页面上没有只信任不激活的入口。pending 在下一次校验通过时清掉。

指纹对外是 OpenSSH 写法 `SHA256:<base64>`，库内是 `算法:sha256 hex`，两者在 `ssh/fingerprint.ts` 互转，所以能直接和 `ssh-keygen -l` 比对。

## 4. 断开、掉线与删除

- **断开**：对自己与所有递归下游，先下游后自己依次 abort 并 `hub.pause`（`Activator.deactivate`；先断下游是为了免得下游在跳板消失时报一堆连带错误）。暂停之后任何用法都不会自动建连，会抛英文报错（点名主机、说明是用户断开的、让模型别重试并转告用户去「设置 · 远程连接」激活），直到再次激活（`env/hub.ts` 的 `getSsh` 守卫）。`hub.isPaused` 还会被提示词的「环境信息」段读去，把这台主机标成 `DISCONNECTED by the user`，下一次运行前由状态通知告诉模型；掉线不标。审计记「已断开」并带上连带的下游。
- **掉线**（对端或网络断开，非主动）：只写一条 system 审计「连接已断开」，状态回到未激活，**不做后台重连**。但没有被暂停的连接，之后若有会话或接口再用到该主机，`SshEnv` 仍会按需建连（`env/ssh.ts` 的类注释），只有「断开」置的暂停拦得住；激活失败后也不会恢复暂停。跳板掉线时经它的下游随之掉线、各记一条。网络中断后不自动重连、跳板掉线连带下游，`api/connections.test.ts` 的「已激活的连接掉线」组有用例；按需建连这一条来自代码阅读，没有专门的测试。
- 页面上的「N 个会话会暂停」是前端按「目录 → 会话」算的（`mountsOf`），服务端没有「暂停会话」状态。
- **删除**（`DELETE /api/v1/connections/:id`）依次拒绝（409）：`active`（激活中或已激活，须先断开）、`referenced`（被别的连接当跳板，带引用者）、`in_use`（还有目录挂在它上面，带条数）。成功后释放连接、丢进度，审计记「删除连接」与地址（登记没了，审计留着）。
- 环境接口 `DELETE /api/v1/environments/:id` 同样能删，只查目录与跳板引用，**不要求先断开**；页面不调它。

## 5. 跳板链

- 一个连接至多一个跳板：`jump` 虽是数组，长度大于 1 即 400 `invalid_jump`；`jump_id` 外键指向自身，被引用的跳板删不掉。
- 保存时 `checkJump`（`store/connections.ts`）：跳板必须存在（`jump_not_found`）、不得成环，深层环路也算（`jump_cycle`）、改动后整棵树里最长的一条链，跳板数不超过 `MAX_JUMP_DEPTH = 4`（`jump_too_deep`）。三者都返回 409，页面先拦一遍（`model.ts` 的 `jumpChoices`）。
- 链是真正在用的，不只是展示：下游经上游的 `forwardOut` 通道拨号，代替直连 TCP（`env/hub.ts`）。复制的 ssh 命令用 `-J` 把整条链串起来（`model.ts` 的 `sshCommand`）。

## 6. 凭据与密钥

- 认证只有私钥与密码两种，都在 `secrets` 表里，AES-256-GCM，主密钥是数据目录下的文件（`store/secrets.ts`、`store/seal.ts`）。值只进不出，连接上只存 `secret_id`。
- 私钥：导入时当场解析，带口令或格式不认识就拒绝，400 `invalid_private_key`，以免激活时才失败又被误报成连不上。密钥页只能导入、查看（指纹、类型、被几条连接引用）、复制指纹、删除。被引用的删不了（外键，409 `in_use`），页面点名引用者。
- 密码：页面为每条连接新建一条名为「<连接名> 密码」的凭据（`store.ts` 的 `newPasswordSecret`）。换认证方式或删连接时由页面把旧密码凭据删掉，服务端不级联。
- 连接审计（`kind=env`）的 `detail` 只放指纹、地址、阶段、错误信息，不放凭据值。

## 7. 页面与日志

页面在 `packages/web/src/features/settings/remote/`，三个页签：连接、密钥、连接日志；主机密钥并在连接详情里，没有单独页签。

- 连接：主从页，左边 `RailList` 不分组，已激活在前、待核对次之、其余在后，行右侧是状态点，悬停卡片给跳板、认证方式、目录与会话数、上次激活；行与详情头共用一份「⋯」菜单（复制 ssh 命令、删除连接，被守卫挡住时置灰并写原因）。详情头只有名字、地址、状态与「激活 / 断开」；平时往下依次是地址（跳板链图、主机、端口与用户、跳板机、主机密钥一行：状态、指纹、记录时间、复制指纹）、认证、连接策略、目录挂载。有事才出现的几条（改动待激活、密码输入、六步激活、主机密钥核对）排在头与地址之间。
- **保存**：地址、认证、连接策略进草稿，页面底部的保存条点保存才一次 PATCH（只带改动的字段；换密码时先建凭据再改指向，失败回收）；已激活的连接也直接可改，保存后提示「下次激活生效」；激活进行中地址类字段置灰（服务端本来就拦）；有未保存的修改时「激活」置灰，切换连接 / 页签先问。激活、断开、信任、删除是即时动作，不进草稿。
- 连接策略只列真生效的两项（首次连接的主机密钥策略、保持连接）；`reuseSession` 与 `proxyJumpFallback` 服务端只存不执行，界面不露出（字段还在）。
- 新建与导入私钥用 `FormDialog`；新建连接的两个出口是「创建并激活」（主）与左侧的「仅创建」；断开确认与删除确认用 `ConfirmDialog`，删除密钥同理。
- 密钥页是表格（名称、类型、指纹、引用，行尾「⋯」：复制指纹、删除密钥；被连接引用的置灰并写几条在用）。
- 连接日志：取各连接审计里的 `kind=env`（见 [`audit.md`](audit.md) §4），每页 50 条按游标翻页；按 `op` 归并成激活、失败、断开、主机密钥、配置五类，取消与掉线都归「断开」（`api/connections.ts` 的 `/log` 路由）。
- 已激活的连接，页面可见时每 5 秒巡检一次状态，用来发现掉线（`store.ts` 的 `watch`）。

## 8. 与目录的关系

目录的主机就是某个环境：本机、ssh 连接或虚拟环境（附件区、协作区），见 [`workspace.md`](workspace.md)；库里是 `directories.environment_id` 存连接 id。新建远程目录时经该连接解析真实路径，连不上返回 502 `env_unreachable`（`session/directory-resolver.ts`）。连接页的「目录挂载」只显示引用，增删在工作区页做；删连接前必须先清空这些引用。

## 9. 未实现与未决

未实现（没有对应代码）：

- 自动重连：没有，掉线只记日志。
- 保活秒数 / 次数、空闲断开、最大复用通道的可配置：没有；`keepAlive` 只有开关，间隔写死 20 秒。
- `reuseSession`、`proxyJumpFallback`：只存不执行，页面不显示这两项。生效的策略只有 `keepAlive` 和 `hostKey`。
- 从 `~/.ssh/config` 导入：没有，仓库里没有对应的解析代码。
- 生成密钥、复制公钥：没有；只能导入无口令私钥，复制的是指纹。
- 密码「仅本次激活」：没有；密码一律加密存进服务端。
- 延迟、重连次数、复用会话数等事实条：没有，`ConnectionView` 里无对应字段。
- 自动判断远端操作系统类型：没有；`os` 靠登记，页面不能改（新建默认 posix，windows 只能走 API）。激活时的「远端探测」只取内核与架构一行，不据此改 `os`。
- 激活进度、暂停状态的持久化与启动恢复：没有，全在内存。

未决 / 未验证：

- Windows 目标的 shell 分支（`env/ssh.ts` 的 `openShell`）代码自称未验证。
- 断开时运行中的调用如何收尾：未核实。
- ssh 密码是否可能经连接以外的路径进入对话记录：只核对过连接这条路径。
