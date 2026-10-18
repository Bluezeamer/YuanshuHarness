# Spec: WebUI 多 pane 布局
Author: bluezeamer
Status: draft
Date: 2026-10-18

> 写成 delta：只写本次变更相对 [skeleton](../../done/261017-webui-skeleton/spec.md) 与 [conversation](../../done/261017-webui-conversation/spec.md) 新增或改变了什么。
> 名词（window、pane、布局文档、已存布局）以 [intent](intent.md) 为准；保活、文档形状、存储、注册契约已由 [ADR-0027](../../../genesis/adr/0027-webui-pane-layout.md) 定，本文不重复理由。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0027](../../../genesis/adr/0027-webui-pane-layout.md)、[ADR-0020](../../../genesis/adr/0020-transport-websocket.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0025](../../../genesis/adr/0025-data-dir-layout-and-versioning-revised.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)
下游: 定稿后回填

## 改动的既有 spec
- skeleton R7（刷新不记忆选中）：会话选中从 `Shell` 的 `useState` 挪进 chat pane 的配置，随布局持久化，刷新后恢复。
- conversation R14（草稿按会话保留）：保持，草稿仍按会话存，所以同一会话的多个 chat pane 共用一份，这正是镜像输入栏的实现。
- conversation R1（切换会话关闭旧连接）：连接改为按会话共享、引用计数，最后一个使用它的 pane 释放时才关闭（见 R12）。

## Requirements
### 布局与保活
R1. 对话页有 window 栏：新建、关闭（至少保留一个）、重命名、切换。window 的名字可重复。
R2. window 内是一棵 pane 树：在任一 pane 上按水平或垂直分割出新 pane；拖动分割线调尺寸（比例，每块不小于最小尺寸）；可嵌套；可关闭 pane，其兄弟占满空出的位置。关闭 window 内最后一个 pane 时 window 变空，显示"空 window"和新建 pane 的入口。
R3. 保活：移动 pane（同一 window 内换位、跨 window）、切换 window、分割、调整尺寸，都不得使 pane 重新挂载。可观察的判据：chat 的输入框内容与滚动位置不变，连接不重连；挂载计数不增加。所有 window 的 pane 平铺在一个固定的 pane 层，按布局树算出的矩形定位；非活动 window 的 pane 保持挂载，只设 `visibility: hidden` 与 `inert`，不用 `display: none`。
R4. 以上由真实浏览器复核（见 Proof）：拖动与切换前后，同一 pane 的 DOM 节点标识不变，iframe 类 pane 不重新加载。做不到则回到 ADR-0027 重议，不在 spec 里绕开。
R5. 拖动 pane：用 pointer 事件（不用 HTML5 DnD，后者在 iframe 上方丢事件）。可放到另一个 pane 的上、下、左、右边缘（分割并插入）、放到 window 栏的某个 window 标签上（移动到该 window）。拖动中显示落点预览；松手前按 `Esc` 取消，pane 回到原位。
R6. 键盘：`Alt+方向键` 在当前 window 内按位置移动焦点 pane；焦点 pane 有可见焦点框。每个 pane 的标题栏有菜单按钮（可聚焦），菜单项：向右分割、向下分割、移动到其他 window、关闭，是拖拽的键盘等价操作。
R7. 窗格标题栏显示 pane 的类型显示名与自己的状态（chat 显示所绑定会话名），标题栏可作为拖动手柄。

### pane 类型
R8. 注册表以类型标识为键，注册项含：类型标识、显示名、渲染组件、默认配置、当前配置版本、配置迁移函数。第一期注册 `chat`、`filediscovery`、`terminal`、`file_preview`、`web_preview`。后四个渲染"尚未可用"。新增类型只改注册表，布局代码不动（用一个测试类型证明）。
R9. 载入时未知类型，或配置版本高于注册项：渲染"未知 pane"占位，原样保留 `config` 与 `configVersion`，保存时原样写回。配置版本低于注册项时调该类型的迁移函数后再用。迁移函数抛错时按未知类型处理，不丢弃。

### chat pane、会话列表、镜像
R10. 会话列表仍是固定左栏。点击会话：绑定到当前焦点的 chat pane（更新其配置里的会话 id）；当前 window 没有 chat pane 时，新建一个。同一会话可以同时开在多个 pane 里。焦点 pane 不是 chat 时，点击会话改为聚焦当前 window 内最近一个 chat pane，没有则新建。
R11. 镜像：绑定同一会话的所有 pane，消息、工具、队列、运行态、连接态、历史、提示都一致；输入栏内容同步（一个 pane 里打字，另一个立刻出现）；在任一 pane 发送，两边的输入栏同时清空。滚动位置各 pane 独立，"加载更早"的结果共享。
R12. 连接按会话共享：同一会话不论开几个 pane，只有一条 WebSocket 和一份历史/对话状态（放在按会话的 store 里，conversation 的 `useConversation` 改为订阅它）。引用计数归零时关闭连接并释放状态；有 pane 在，隐藏的 window 里的连接也保持。未确认发送的结算（conversation R8、R14）不变，放回的仍是该会话的那一份草稿。
R13. 输入导航：对话页右侧，以所属 chat pane 里用户发出的消息为锚点列出，点击滚动到该条并使其可见。导航跟随焦点 chat pane；没有 chat pane 焦点时为空态。每条锚点显示消息前若干字，长度截断。
R14. 响应宽度：左栏与右侧导航各有"折叠"和"固定"两态。对话页内容区宽度不足阈值时默认折叠，需要时展开并悬浮在内容之上（不挤压 pane 层、不改变 pane 矩形，不触发重新布局）；宽度足够时默认固定。用户手动切换后，记住该选择，不被宽度变化覆盖（宽度变化只影响尚未手动设置过的默认值）。阈值初值：左栏 960px、右栏 1280px，spec 阶段用真实浏览器调整并记入 Proof。
R15. 顶栏"Server 在线"仍是写死的绿点，不属于本变更（沿用 conversation Risks，留给 reconnect）。

### 持久化
R16. 布局文档按 ADR-0027 的形状存取：`version`、window 列表（`id`、`name`、树）、`panes` 表（`paneId → { type, configVersion, config }`）、当前 window id。树的分割节点 `{ dir, children, ratios }`，叶子 `{ paneId }`；`ratios` 之和为 1，读入时不为 1 或长度与 `children` 不符则按等分修复，并提示一次。
R17. 刷新后恢复所有 window、pane、尺寸、当前 window、各 chat pane 绑定的会话。拖动、分割、改名等布局变更防抖后保存（延迟初值 800ms），关闭页面前尽量冲刷（`pagehide`）。保存失败显示可见提示并保留本地改动，不静默丢。
R18. Server 端点（均在 `/api/v1`，带令牌，走 ADR-0026 的检查顺序）：
  - `GET /api/v1/workbench` → `{ revision, document }`；还没有时 `revision: 0`、`document: null`（客户端用默认布局）。
  - `PUT /api/v1/workbench`，请求体 `{ baseRevision, document }`：`baseRevision` 等于当前值则写入并返回新 `{ revision }`；不等返回 409 与当前 `{ revision, document }`。
  - `GET/POST /api/v1/saved-layouts`、`PUT/DELETE /api/v1/saved-layouts/{id}`：已存布局（名字加单个 window 的树及其引用的 pane 条目）。`PUT` 同样用 `revision`；`DELETE` 不校验 `revision`，按 id 直接删除（2026-10-18 决定：误删代价只是重新保存一次布局）。
  - 校验：请求体是合法 JSON、`version` 是整数、大小不超过 256 KiB（超出返回 413）。Server 不解析文档内部结构。
R19. 数据目录：SQLite 新增存放工作台文档与已存布局的表，`PRAGMA user_version` 加一，按 ADR-0025 迁移（迁移前备份、每步一个事务）。
R20. 读到 `version` 高于当前代码的文档：只读展示，禁止保存（不覆盖），提示"布局来自更新的版本"。
R21. 冲突（409）：显示"布局已在别处修改"，提供"采用服务器版本"（丢弃本地未保存改动）与"以本地覆盖"（用新 `revision` 重新提交）。不做合并。
R22. 已存布局：把当前 window 存为已存布局（输入名字）；套用到新 window 时，所引用的 pane 全部分配新 `paneId`，chat pane 的会话绑定保留。已存布局的列表可删除。

### 样式与可访问性
R23. 遵循 [yuanshu-webui-style](../../../../.agents/skills/yuanshu-webui-style/SKILL.md)：不写死色值，动效在 `prefers-reduced-motion` 下近 0。window 栏为 `role="tablist"`，每项 `role="tab"` 与 `aria-selected`；pane 层中每个 pane 是 `role="region"` 且 `aria-label` 为其标题；分割线 `role="separator"` 带 `aria-orientation` 和 `aria-valuenow`，可聚焦，方向键调整比例（步长 2%）。
R24. 常驻资源上限：待实测后定（pane 总数、终端回滚行数）。先给软上限提示：pane 总数达到初值 12 时，新建前显示提示，不强行阻止。数值在 spec 阶段实测后修订。

## Proof
组件测试用假 WebSocket 与 `fetch` 桩（沿用 conversation 的 `fakes.ts`）；服务端测试在 `packages/server`。"旧实现"指本变更前的 `Shell` 单窗口。

| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | `workbench.test.tsx`：新建、重命名、切换；关到只剩一个时关闭不可用；重名允许 | 是（旧实现没有 window 栏） |
| R2 | `tree.test.ts`：分割、关闭后兄弟占满、嵌套、最小尺寸；`workbench.test.tsx`：空 window 的入口 | 是 |
| R3 | `panelayer.test.tsx`：移动、切 window、分割、调尺寸前后 pane 的挂载计数不变、输入框内容不变；真实浏览器见 R4 | 变异：移动时按 window 重建 pane（`key` 随 window 变），必须变红 |
| R4 | 真实浏览器（见下），写入 review.md | 无单测；jsdom 不能证明 iframe 不重载 |
| R5 | `drag.test.tsx`：四边落点、落到 window 标签、`Esc` 取消回原位；真实浏览器复核 iframe 上方不丢事件 | 是 |
| R6 | `workbench.test.tsx`：`Alt+方向键`、菜单项四个动作 | 是 |
| R7 | `workbench.test.tsx`：标题栏显示类型名与会话名 | 是 |
| R8 | `registry.test.ts`：五个类型已注册，后四个渲染"尚未可用"；注册一个测试类型，布局代码不改 | 是 |
| R9 | `registry.test.ts`：未知类型、高版本、迁移抛错三种往返不丢 | 变异：载入时丢弃未知 pane，必须变红 |
| R10 | `sessions.test.tsx`：点击绑定焦点 chat pane；无 chat pane 时新建；焦点不是 chat 时聚焦最近的 chat pane；同一会话可开两个 pane | 是 |
| R11 | `sessions.test.tsx`：两个 pane 同会话，一边输入另一边同步，一边发送两边都清空，历史与提示一致；各自滚动独立 | 变异：每个 pane 各持一份草稿，必须变红 |
| R12 | `sessions.test.tsx`：两个 pane 只有一条 WebSocket；关掉一个连接仍在，关掉最后一个才关闭；隐藏 window 里连接保持；未确认发送放回同一份草稿。conversation 的现有用例整体通过 | 变异：每个 pane 各开一条连接，必须变红 |
| R13 | `nav.test.tsx`：只列用户消息、截断、点击滚动到该条；跟随焦点 chat pane；无焦点为空态 | 是 |
| R14 | `responsive.test.tsx`：宽度跨阈值时默认折叠或固定；手动设置后宽度变化不覆盖；展开悬浮时 pane 矩形不变。阈值在真实浏览器里调整并记入 review.md | 是 |
| R15 | 不适用（沿用 conversation Risks） | — |
| R16 | `tree.test.ts` 或 `document.test.ts`：往返、`ratios` 之和不为 1 或长度不符时等分修复并提示一次 | 是 |
| R17 | `persist.test.tsx`（假计时器）：防抖 800ms 后保存、`pagehide` 冲刷、保存失败提示并保留本地改动、刷新后恢复所有 window / pane / 尺寸 / 会话绑定 | 变异：去掉冲刷，`pagehide` 用例必须变红 |
| R18 | `packages/server` 集成测试：无令牌 401、`GET` 空态 `revision: 0`、`PUT` 基线相符与不符（409 带当前文档）、已存布局增删改、非法 JSON、`version` 非整数、超 256 KiB 返回 413 | 是 |
| R19 | `packages/server` 迁移测试：旧库升级后 `user_version` 加一、迁移前备份、失败回滚；多端并发写走 `revision` | 是 |
| R20 | `persist.test.tsx`：高版本文档只读展示、保存按钮禁用、不发出 `PUT` | 变异：允许保存，必须变红 |
| R21 | `persist.test.tsx`：409 提示；"采用服务器版本"丢弃本地改动；"以本地覆盖"带新 `revision` 重提 | 是 |
| R22 | `saved.test.tsx`：存为已存布局、套用后 `paneId` 全部是新的、chat 会话绑定保留、删除 | 是 |
| R23 | `tokens.test.ts` 静态检查（沿用）；组件测试断言 `tablist` / `tab` / `region` / `separator` 及其属性、分割线方向键步长 2% | 变异：写入 `#fff`，必须变红 |
| R24 | `workbench.test.tsx`：第 12 个 pane 之后新建前出现提示且不阻止。数值待实测，记入 review.md | 是 |

必测项的补充说明：
- R3、R4：真实浏览器，起 Vite + 假 Server，记录拖动前后 pane 的 DOM 节点标识（`WeakRef` 加唯一标记）、输入框内容、滚动位置、iframe 的 `load` 次数，写入 review.md。上一轮 `tmp/spike/LayerSpike.jsx` 已有原型，结论要重做。
  这两条 jsdom 管不到，由 [browser-verify.md](browser-verify.md) 的真实浏览器步骤证明；可用 `playwright-cli`，但需确认 `drag` 发出的是 pointer 事件（R5 不用 HTML5 DnD）。
- R11、R12：同一会话开两个 pane，一边输入、发送，另一边的输入栏同步；连接数始终为 1。变异：每个 pane 各开一条连接，镜像用例必须变红。
- R9：未知类型往返不丢；变异：加载时丢弃未知 pane，必须变红。
- R18、R19：`packages/server` 的集成测试（令牌、409、413、版本迁移）；多端并发写走 `revision`。

## Design
- `src/layout/tree.ts`：纯函数，树的分割、关闭、移动、算矩形、比例修复。不依赖 React。
- `src/layout/registry.ts`：pane 类型注册表。
- `src/layout/PaneLayer.tsx`：按 `paneId` 平铺渲染所有 pane，用矩形定位；`ResizeObserver` 监听容器。
- `src/layout/Workbench.tsx`：window 栏、拖动、焦点、分割线；持有布局文档状态与防抖保存。
- `src/sessions/store.ts`：按会话的 store（连接、对话状态、历史、草稿），引用计数；`useConversation` 改为订阅它。
- `packages/server`：新增 workbench 与 saved-layouts 路由，复用现有令牌检查。

## Risks
- R3 依赖"pane 层平铺定位"在真实浏览器里的行为，ADR-0027 已写明做不到则重议，这是本变更最大的风险，要最先验证。
- R12 把连接放进 store 要改 conversation 已评审通过的 hook，回归风险在重连、结算、历史对齐；conversation 的现有用例要整体保留并通过。
- 镜像共享一条连接，所以 ADR-0020 "一个会话一条连接" 不被突破，也不需要测服务端多订阅行为。
- 输入导航在 pane 多、焦点切换时频繁重算，大会话的锚点量大，必要时按需虚拟化，spec 阶段评估。
- 防抖保存加 `pagehide` 冲刷仍可能在崩溃时丢最近几百毫秒的改动，已知并接受。
- "以本地覆盖"会丢掉别处的修改，是用户明确点选的结果，不再二次确认。
