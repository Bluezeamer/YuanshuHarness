# ADR-0027: WebUI 多 pane 布局：保活机制、布局文档、存储与 pane 类型注册

状态：已定稿
日期：2026-10-18
可逆性：难逆
取代：——
被取代：——
引用入口：ARCHITECTURE「技术选型」；[变更 261018-webui-pane-layout](../../intent/active/261018-webui-pane-layout/intent.md)

## 背景
WebUI 要做成 Web 端的 tmux：对话页内有多个 window，每个 window 装一棵 pane 树，pane 可在 window 之间移动。名词以变更 intent 为准（window、pane、布局文档）。
2026-10-18 用 flexlayout-react 与 react-mosaic-component 各做了一个实验：同一 window 内换位、分割都保留 pane 状态；flexlayout 跨 window 移动时 pane 被卸载重建（mount id 变化、输入框内容丢失），Mosaic 按 window 切换时整棵树重建。chat 的连接与半截输入、终端回滚区、网页预览的 iframe 都不能在重建后保留，所以"移动与切换不重挂载"是硬需求，现成库满足不了。
布局文档会写进用户数据，pane 类型标识一经持久化就是契约，改动要迁移，所以难逆。

## 候选方案
### 保活机制
- A. 所有 window 的 pane 常驻挂载，非活动 window 用 CSS 隐藏。pane 在 React 树里换父节点仍会重挂载，跨 window 移动照样丢状态。
- B. pane 层与布局树分离：所有 pane 实例平铺挂在一个固定的 pane 层，布局树只算每个 pane 的矩形，pane 按矩形定位。移动、分割、切 window 只改矩形，pane 不换父节点。代价：定位、可见性、焦点顺序与无障碍顺序要自己维护。
- C. 状态外置到 store，接受重挂载。终端回滚区与 iframe 无法外置。

### 布局存哪
- A. 浏览器 localStorage。换设备、清缓存就丢。
- B. Server 存。代价：新增带令牌的端点与结构版本迁移，多端同时改要定冲突规则。

## 决定
**保活：选 B。** 实例化 pane 由 pane 层持有，以稳定的 `paneId` 为 key；布局树只描述矩形划分，不持有 pane 实例。非活动 window 的 pane 保持挂载，只做不可见且不可聚焦（`visibility: hidden` 加 `inert`），不用 `display: none`（iframe 与滚动位置在不同浏览器里对它的处理不一致）。本决定依赖一个尚未验证的事实：在真实浏览器里拖动、切换后 mount id 不变且 iframe 不重载。该验证是 spec 阶段的必测项，做不到则回到本 ADR 重议。

**布局文档**：带版本号的 JSON，范围是整个工作台（全部 window 加当前 window），单文档存取。
- `version`：整数。读到高于当前代码版本的文档，只读展示并拒绝覆盖，沿用 [ADR-0025](0025-data-dir-layout-and-versioning-revised.md) "高于则拒绝"的思路。
- 每个 window：`id`、`name`、一棵树。树节点是分割（`dir`: `row` 或 `column`，`children`，`ratios`）或叶子（`paneId`）。占比用比例，不用像素。
- 所有 pane 放在文档的 `panes` 表里：`paneId → { type, configVersion, config }`。树里只引用 `paneId`，所以跨 window 移动只是改树，不改 pane 条目。
- 已存布局（命名后可套用到新 window）是单个 window 的树加其引用的 pane 条目，套用时给 pane 分配新 `paneId`。

**存储：存 Server。**
- 数据目录的 SQLite 新增表，`PRAGMA user_version` 加一，走 ADR-0025 的迁移（迁移前备份、每步一个事务）。
- Server 不解析布局文档内部结构，只校验：是合法 JSON、`version` 是整数、大小不超过 256 KiB。
- 工作台文档只有一份，带单调递增的 `revision`；写入必须带上自己读到的 `revision`，不一致返回冲突，由客户端重新读取后决定如何合并。已存布局各自一行，同样用 `revision`。
- 端点在 `/api/v1` 下，带令牌，经 [ADR-0026](0026-access-token-and-source-network.md) 的检查顺序。具体路径与载荷在 spec 定。

**pane 类型注册契约**
- 类型标识是持久化字符串，一旦写进布局就不能改名。第一期：`chat`、`filediscovery`、`terminal`、`file_preview`、`web_preview`。
- 注册项至少包含：类型标识、显示名、渲染组件、默认配置、当前配置版本。新增类型只增加注册项，布局代码不改。
- 载入时遇到未知类型（旧版本打开新布局，或类型被移除），渲染"未知 pane"占位并原样保留其 `config` 与 `configVersion`，保存时写回，不得丢弃。
- 配置版本低于注册项的当前版本时，由该类型自己的迁移函数升级；高于时按未知类型处理，保留原样。

## 理由
- 现成库的实例与一棵树绑定，保活需求下无法使用；自己持有布局树后，跨 window 移动是对树的纯函数操作。
- 只要 pane 实例不随布局变化换父节点，就不会被卸载；B 是满足这一点的唯一候选，A 与 C 都有明确的不可行处。
- 跨设备保留布局是已确认的需求（2026-10-18，bluezeamer），所以选 Server。Server 不解析内部结构，使 pane 类型增加时不需要改 Server。
- 保留未知类型的配置，避免旧客户端保存时悄悄删掉用户的 pane，这是静默丢数据。
- 用 `revision` 比对而不是后写覆盖，避免两个浏览器同时改时一方的修改无提示地消失。

## 影响
- 前端要自己实现：矩形计算、分割线拖动、pane 定位、焦点与键盘顺序。这是自建的主要工作量。
- 所有 window 的 pane 常驻，内存随 pane 数增长；常驻上限（pane 数、终端回滚行数）在 spec 实测后定。
- 数据目录结构版本加一；旧版本 Server 读到新结构会拒绝启动（ADR-0025）。
- 冲突时的合并界面本期不做，只提示并重新读取。
- 排除：引入布局库；把 pane 状态外置到 store；浏览器 localStorage 作为布局的唯一存放处。
