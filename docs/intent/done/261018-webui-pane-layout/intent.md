# Intent: WebUI 多 pane 布局
Author: bluezeamer
Status: closed
Date: 2026-10-18
Lane: decide
Why: 命中"难逆"——布局文档是写进用户数据的新形状（带版本、要迁移），pane 类型标识一经持久化就成了契约；同时命中"静默"（pane 跨 window 移动或切换时被卸载重建，状态悄悄丢失；多端写同一份布局）。不是 build 档，因为有多处难逆点要先出 ADR。

> 位置：`docs/intent/active/261018-webui-pane-layout/intent.md`。

## Links
来源: 人工提出，原稿 [webui-workspace-grid](../../inbox/done/webui-workspace-grid.md)（原稿用词是随手写的，名词以本文为准）；ROADMAP 第 4 条（WebUI 基础）的一块
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0013](../../../genesis/adr/0013-tech-stack.md)、[ADR-0020](../../../genesis/adr/0020-transport-websocket.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)；依赖尚未关闭的 [webui-conversation](../../done/261017-webui-conversation/intent.md)（chat pane 复用它）
下游: 定稿后回填

## 名词
本文、后续 ADR、spec 和代码统一用 tmux 的两个词 window 与 pane，不再使用原稿的"工作区""Tab""面板"。
- **window**：对话页内的一整屏布局，装一棵 pane 树；在 window 栏里切换，pane 可以在 window 之间移动。原稿的"Tab / 工作区"。
- **pane**：window 内的一块矩形，装一个 pane 类型的实例。原稿的"面板"。
- **pane 类型**：chat、filediscovery、terminal、file_preview、web_preview。
- **window 栏**：对话页内、顶栏之下的一排 window，可新建、关闭、重命名、切换。顶栏的 tab 仍是页面级导航（对话、环境……），不变。
- **布局文档（layout document）**：一个 window 的 pane 树加尺寸，是持久化的单位。**已存布局（saved layout）**：命名后存下来、可套用到新 window 的布局文档。

写法约定：
- window 在文档里一律写英文，不写中文"窗口"。仓库里"窗口"已经是"快照窗口 / 最近窗口"（最近 50 条消息，[ADR-0005](../../../genesis/adr/0005-client-protocol.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、`pool.ts` 的 `WINDOW`），两者必须分开。界面上 window 的中文标签留给 spec 定。
- 代码里不用裸标识符 `window`（会遮蔽浏览器的全局对象），用 `LayoutWindow`、`windows`、`windowId` 这类带限定的名字。pane 相关用 `pane`、`PaneType`、`LayoutDoc`、`SavedLayout`。
- tmux 里 session 包含 window；这里的会话（session）是 agent 会话，与 window 没有包含关系，chat pane 通过自己的配置引用一个会话。

为什么不用原有的词：
- workspace：[ADR-0003](../../../genesis/adr/0003-concept-model.md) 里是"环境内带 cwd 的目录"，权限档位挂在它上面，ADR-0006、0007、0008、0009、0010 都在用。
- tab：风格规范与 skeleton 里指顶栏的页面导航。
- 面板：风格规范里 `panel` 是表面色令牌，字面太近。
- 预设：[ADR-0008](../../../genesis/adr/0008-capability-sets.md) 明确"不另设预设概念"，[ADR-0009](../../../genesis/adr/0009-prompt-assembly-injection.md) 里 build、plan 模式也叫预设。

查过仓库，`pane`、`PaneType`、`LayoutDoc` 和中文"窗格"目前没有任何占用；英文 window 除浏览器全局对象外也没有。

## Problem
WebUI 现在是"左侧会话列表 + 单个对话窗口"（`packages/web/src/Shell.tsx`）。后续要同时看对话、终端、文件、网页，单窗口会逼用户在页面间切换。目标是做成 Web 端的 tmux：对话页内有多个 window，每个 window 是一块可分割、可拖动的 pane 网格，布局刷新后还在。

选型过程中做了两个库（flexlayout-react、react-mosaic-component）的实验，事实如下：
- 同一 window 内换位、分割：两个库都保留 pane 内状态（mount id 与输入框内容前后一致，flexlayout 为 h3w7/hhv2/i4dh，Mosaic 为 uzgl/445g/51c7）。
- flexlayout 跨 window 移动：a 的 mount id 由 h3w7 变成 zof7，输入框内容丢失，即卸载后重建。库的实例与一棵树绑定，跨 window 只能自己在两个 Model 之间搬节点。
- Mosaic 的跨 window 移动没有单独量化。它同样一个实例只渲染一棵树，实验里按 window 切换时整棵树重建（实验代码按 `key={active.id}` 写，这是实验的写法，不是库的强制要求）。
- 对 chat（WebSocket、半截输入、滚动位置）、终端、网页预览来说，pane 一重建就丢状态；这种丢失在界面上看不出来，只有输入框里打了一半的字、终端回滚区没了才会发现。
- 实验产物在 `tmp/spike/`（已被 gitignore，不随仓库保留）；结论由 ADR 记录。

## Proposed outcome
- window 栏：新建、关闭、重命名、切换。
- window 内由 pane 组成网格：在现有 pane 上水平或垂直分割，拖动分割线调尺寸，任意嵌套；可关闭 pane。
- pane 可拖到另一个 window，**移动、切换 window、分割、调整尺寸都不得让 pane 重新挂载**：chat 的连接、输入缓冲、滚动位置保持。
- 布局持久化：刷新后恢复所有 window、pane 及尺寸；可把当前 window 的布局存为已存布局并快速唤起。
- pane 类型可注册：新增类型只声明"是什么、渲染什么"，布局代码不改。
- 第一期只有 chat 是真实内容；filediscovery、terminal、file_preview、web_preview 注册为占位类型，显示"尚未可用"。
- 键盘可切换焦点 pane；拖拽有键盘等价操作。
- 会话列表：固定左栏，点击后绑定到当前焦点的 chat pane。多个 chat pane 可同时显示，同一个会话也可以开在多个 pane 里，这些 pane 互为镜像：消息、运行态、输入栏内容完全同步。左栏可折叠，宽度不足时默认折叠、展开时悬浮。
- 输入导航：对话页右侧，以用户发出的消息为锚点，点击跳转。同样可折叠或固定常驻，响应宽度。

## Out of scope
- pane 间状态感知（选中的代码、终端输出给 chat 用）：只保证契约不堵路，不定义消息形状。
- 四个占位 pane 的真实内容：依赖 ROADMAP 第 6 条的环境与文件传输。
- 触屏与移动端布局；多用户共享布局；布局的导入导出文件。
- 会话的创建、重命名、删除（沿用现有能力）。
- 自动重连、统一弹窗：各有独立变更，见下面"与进行中工作的关系"。

## Constraints
- 技术栈 React 加 Tailwind（[ADR-0013](../../../genesis/adr/0013-tech-stack.md)）；样式遵循 `yuanshu-webui-style`。
- chat pane 沿用每会话一条 WebSocket 的协议（[ADR-0020](../../../genesis/adr/0020-transport-websocket.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)）。
- 若布局存 Server：新增的 `/api/v1` 端点必须带令牌（[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)），数据目录结构版本走 `user_version` 迁移（[ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md)）。

## 与进行中工作的关系
结论：不冲突，排在 skeleton、conversation、reconnect 之后做。依据是 2026-10-18 读代码的结果，没有运行验证：
- conversation：`useConversation(sessionId)` 自己持有一条连接，`Conversation` 是纯 props 组件，输入缓冲与滚动位置在组件内部。这正是 pane 层要保活的对象，不需要为本变更改它们。
- reconnect：断线条（`SyncBar`）与重连按钮在 `Conversation` 内，随 pane 走；重连逻辑在 `Stream` 与 `useConversation`，与布局无关。唯一牵连是 `Shell.tsx:58-61` 顶栏的"Server 在线"是写死的：pane 各有连接，它最多表示 REST 可达，不代表任何一条会话连接。reconnect 那一步要定它的含义。
- dialog：弹窗盖在整个外壳之上、背景 inert，与布局正交；弹窗要写明来源会话，会话归属以 pane 配置为准。
- skeleton 的 spec R7（"刷新页面不记忆选中"）会被本变更改写：会话选中从 `Shell` 的 `useState` 挪进 chat pane 的配置，随布局持久化。skeleton 按现有 spec 关闭，本变更的 spec 以 delta 写明改了 R7。
- Server：`pool.ts` 的订阅者是集合（`subscribers`），同一会话开多条连接在代码上可行；但 ADR-0020 写的是"一个会话一条 WebSocket 连接"，这句话更像是在说"连接按会话划分，不做多路复用"，是否也限制了同一会话的客户端数，文字上不明确。没有测过多条连接同时订阅一个会话的行为，见 Open questions。

## Decisions needed
已定（2026-10-18，bluezeamer 确认）：
- 档位：decide。
- 名词：window 与 pane（效仿 tmux），写法约定见"名词"。
- 不引入布局库，自己实现。依据是上面的实验：两个库都不能让 pane 跨 window 保活，而保活是硬需求；自己持有布局树后，跨 window 移动只是对树的纯函数操作。
- 第一期范围：布局骨架、pane 类型注册表、chat pane；其余四类注册为占位。
- ROADMAP 位置：并入现有第 4 条（WebUI 基础），不新增条目，其余编号与引用不变。第 4 条的文字改写与 ADR 链接单独走批准，并记入调整记录。
- 在 ROADMAP 第 4 条内的次序：skeleton、conversation、reconnect、本变更、dialog。

难逆（已出 [ADR-0027](../../../genesis/adr/0027-webui-pane-layout.md)，四项均按下面的建议定，布局存 Server 经 bluezeamer 确认，2026-10-18）：
1. **保活机制**。候选：
   - A. 所有 window 的 pane 都常驻挂载，非活动 window 用 CSS 隐藏。代价：内存随 pane 数增长；pane 在 React 树里换父节点仍会重挂载，所以跨 window 移动仍丢状态。
   - B. pane 层与布局树分离：所有 pane 实例平铺挂在一个固定的"pane 层"，布局树只算每个 pane 的矩形，pane 按矩形定位。移动、分割、切 window 都只改矩形，pane 不换父节点。代价：自己做定位与可见性，焦点与无障碍顺序要自己维护。
   - C. 状态外置到 store，接受重挂载。代价：终端回滚区、网页预览（iframe 在 DOM 里换位置会重新加载）无法外置，不满足需求。
   - 建议：B。能否真的做到"拖动后 mount id 不变、iframe 不重载"需要在真实浏览器里验证，列为 spec 阶段的必测项。
2. **布局文档的形状与版本**。树结构（分割节点含方向、占比、子节点；叶子是 pane 引用）、pane 引用含稳定 id、类型标识与该类型自己的配置、文档带版本号。读到高于当前版本的文档时拒绝覆盖，沿用 [ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md) 的"高于则拒绝"思路。建议：树结构加版本号，占比用比例而不是像素。
3. **布局存哪**。候选：
   - A. 浏览器 localStorage。代价：换设备、换浏览器就没了；清缓存丢布局。
   - B. Server 存（数据目录）。代价：新增带令牌的 REST 端点和数据目录结构版本迁移；多端同时改要定冲突规则。
   - 建议：B，布局整体作为带版本号的 JSON 文档存取，Server 不解析内部结构，只校验大小与版本；已存布局同理。需要你确认是否要求跨设备同步，若不要求可降为 A，ADR 范围随之缩小。
4. **pane 类型注册契约**。类型标识是持久化的字符串，一旦写进用户的布局就不能改名。契约至少包含：类型标识、显示名、渲染组件、默认配置、配置版本。载入时遇到未知类型（旧版本打开新布局，或类型被移除）必须渲染"未知 pane"占位并保留原配置，不得丢弃，否则下次保存就把用户的 pane 悄悄删了。建议：按此定。

易逆（推迟到 spec）：拖拽用 HTML5 DnD 还是 pointer 事件；分割线最小尺寸；快捷键具体键位；已存布局的界面；动效；界面上 window 的中文标签；pane 间状态感知的接口形状（本期只保证不堵路）。

## Open questions
已定（2026-10-18，bluezeamer 确认）：
- 同一个会话可开在多个 chat pane 里，状态完全同步（含输入栏），做镜像处理（bluezeamer 2026-10-18 确认，取代此前"一会话至多一个 pane"的写法）。镜像怎么实现（共享一条连接，还是每个 pane 各一条）留给 spec；滚动位置是否同步待 spec 定，倾向各 pane 独立。
- 会话列表保留为固定左栏，点击后绑定到当前焦点的 chat pane。
- **新增范围：对话页右侧的"输入导航"**，以用户发出的消息为锚点，点击跳转到该条消息的位置。左栏与右侧导航都要能折叠，也都能固定常驻；宽度足够时默认固定显示，宽度不足时默认折叠，需要时展开并悬浮在内容之上。导航属于 chat pane 还是对话页，spec 定。

待定：
- 非活动 window 里 pane 常驻的资源上限（pane 数、终端回滚行数）：spec 阶段，实测后定。
- 多端同时修改布局的冲突规则：已由 ADR-0027 定为 `revision` 比对。
