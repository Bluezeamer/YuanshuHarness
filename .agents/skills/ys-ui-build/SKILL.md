---
name: ys-ui-build
description: 元枢 Harness 前端的页面搭建与逻辑结构。新增或重写页面 / 组件、划分 feature 目录、写 store 与 hook、草稿与保存、api 层、前端测试时使用。设置页、列表行、弹窗优先复用 ui/ 与 settings/frame 的标准件。涉及观感时同时加载 ys-ui-design。
---

# 元枢前端：结构与逻辑

组件目录与设置页标准件的完整清单在 `references/components.md`，画布（`@xyflow/react`）的踩坑在 `references/xyflow.md`；本文是「怎么选、怎么分、怎么写」的路由与红线。

## 铁律

- **内部判别值用英文 id，中文只在界面文案里**：命令分类、菜单分组、类型判别、「全部」这类哨兵（用 `null`）都别拿中文字面量当键 / 联合类型 / 比较对象，显示名走 `Record<Id, string>` 映射（范例：`app/shell/commands.ts` 的 `KIND_LABEL`、`chat/tab/slash.ts` 的 `SLASH_GROUP_LABEL`）；文件名等用户内容原样显示。守卫是服务端的 `src/names.guard.test.ts`，它也扫前端源码。
- **业务代码不造 `ui/` 里已有的东西**；缺了先补进 `ui/`，不在业务目录里写一份。同名组件（如 `ConfirmModal`）不再定义。
- **新页面取代旧页面就删旧的**：旧页面、旧组件、旧样式、旧测试一并删，不留注释、不留备用、不做双轨（原型阶段没有历史包袱，见 `AGENTS.md`）。
- 不过度防御、不为极端输入堆用例：原型阶段要的是功能跑通，最基本的 bug 和死循环除外。

## 选件速查（都从 `ui/` 与 `settings/frame/` 取）

| 要做 | 用 |
|---|---|
| 设置页版心 | `Page` / `SplitPane` / `FormColumn` / `FormPane` / `ListColumn`（`frame/layout.tsx`），页签 `PageTabs`；每一栏自己滚，别各自写 overflow |
| 主从页 | 左 `RailList`（搜索、分段、行菜单、悬停卡片）+ 右详情，详情头 `DetailHead` |
| 卡片列表页 | `CardGrid`；点开是整页编辑页 |
| 弹窗 | 表单 `FormDialog`、确认 `ConfirmDialog`、弹窗里的二级页 `Drill`；轻量确认 `ConfirmButton` |
| 保存 | `useDraft` + `SaveBar`；未保存登记 `useBindDirty`，切换前 `guard(go)`；动作结果 `notify(problem, done)` |
| 列表行详情 | `ListRow` 的 `peek` + `PeekCard`（只用行手头已有的数据，悬停时不发请求） |
| 提示 | 行内 `InlineNotice`、右下角 `toast` |
| 容器内的平铺可拖拽布局（窗格、分隔条、窗口条、落点） | `ui/tiling`（`TilingLayout` / `PaneFrame` / `WindowBar`），接法照 `features/workspace/layout/` |

## 页面配方（顺序别乱）

1. **先对齐信息取舍**：行上放什么、卡片放什么、不放什么，先列成清单，与评审者对齐后再动手；涉及功能取舍的（加不加某个入口、行为怎么变）在对齐时说清，纯实现细节自行决定。
2. 样张是可选的：想先看长相，可以在对照页（`features/gallery`，`/?gallery=<视图名>` 打开，静态假数据，不连服务端）做一张，样张与真界面共用展示组件；不需要就跳过。
3. 用标准件重写，设置进草稿、动作立即执行（见 `ys-ui-design` 的 X06）。
4. 删旧件，补测试，加一份 `scripts/verify-<名>.mjs` 并归进 `scripts/check.sh` 的一个阶段（写法照 `verify-variables` / `verify-studio` / `verify-remote`）。

## feature 目录怎么分（范本：`features/settings/providers/`）

- **`api/<资源>.ts`**：一个资源一个文件，请求都走 `api/http.ts`，token 只作参数传入；组件里不直接 `fetch`。
- **`model.ts` / `edit.ts`**：纯函数（`editableOf` / `patchOf` / `validate` / `peekFacts` 这类）+ 单测。**复杂逻辑放这里，不写在组件里**；服务端数据到展示形状的映射也放这里，卡片专用字段做成可选。
- **`store.ts`**：`createXxxStore()` 返回 `{ subscribe, getSnapshot, ... }`，组件用 `useSnapshot`（`useSyncExternalStore`）读；写操作串行，payload 在轮到时才基于最新数据构造。
- **`XxxPage.tsx` + 小件**：页面只编排；Section / Detail / Dialog 各一个文件。
- **`xxx.css`**：`@layer components`、类名带 feature 前缀（`st-` `pv-` `rl-`）、只用令牌。
- **`testkit.tsx`**：仅测试用，视图构造器 + 带状态的假 fetch。
- 跨 feature 只经 `index.ts` 引用；左轨这种展示组件只认 controller 接口（`SidebarController`），对照页与真界面各自实现它。
- **新增工作区标签类型**：在 `workspace/model/tabKinds.ts` 的 `TAB_KINDS` 加一行（主机档位 `host`：`none` 没有主机、`data` 带主机但可放任何窗格、`pane` 窗格按主机隔离，**新类型默认 `none`**，别为「想带个主机」就选 `pane`；能否带 `sid`、`+` 菜单能否新建）；feature 里 `registerTab` 接图标、标题与渲染，并在 `tabs/registry.tsx` 的占位图标表补一个图标；类型专属字段在 `l2.newTab` 与 `persist.parseTab` 各加一处，再在 `app/shell/register.ts` 调注册。组件库自带色值（如 `@xyflow/react`）的标签要 `React.lazy` 按需加载，否则构建产物的色值守卫会拦入口包。
- **浏览器标签**（`features/workspace/tabs/web/` 是界面，`features/workspace/browser/` 是数据层，设计见 `docs/model/browser.md`）：数据层只经 `browser/index.ts` 出口——`useBrowser`（工作区级 store，同工作区所有 web 标签共用一条事件流）、`usePageStream`（画面流与输入）、`useInputCapture`（键鼠与输入法）、`usePorts`；界面里页面状态一律从 store 取，**不在组件里另记页面列表**。「用户把操作权交还 agent」这类事件的触发点在页面事件流里（`BrowserStore` 的 `handedBack`），不挂在任何按钮上，否则会漏掉聊天卡片那条路。工具条的窄窗格降级是**纯 CSS 容器查询**（`web.css` 的四档，菜单永远是完整清单），改工具条按钮要同时改 `BrowserBar.tsx` 里的 `more` 菜单项。画面里的输入、复制、窄窗格版式 jsdom 测不出，用 `verify-browser-ui` / `verify-browser-login` 在真浏览器里量。 agent 的「展示页面」（`browser_show`）经工作区事件流的 `show` 消息到前端：`useBrowserShow`（挂在 `WorkspacePage`）弹一条不自动消失、带「查看 / 忽略」的 `toast`（`toast` 支持 `actions` 与 `durationMs: 0`）；用户页上页面自己写了剪贴板时页面流发 `clipboard` 事件（只发给操作窗口），`Stage` 写进本机剪贴板并弹提示——这两条都是一次性提示，不进快照、不重放。 用户页上的下载是弹窗（`DownloadDialog`，由 `page.pendingDownloads` 驱动、一次问一个）：**失败一律用 `toast` 报**，因为出错的下载在 Server 里已作废、弹窗会随之关掉，行内提示留不住；弹窗的先后：页面挂着 JS 对话框（`page.dialog` → `DialogPrompt`，页面主线程被卡住，agent 与界面前的使用者先答先得，关闭等同取消）最先，其次页面在等使用者选文件（`pendingUpload` → `UploadDialog`），再是下载弹窗；另存到用户本机走 `ui` 的 `saveBlob`（带令牌的 fetch 再另存，不能直接 `<a href>`）。
- **后台任务**（`features/chat/job/`）：任务标签 `job`（`JobView` = 头 + 完整命令 + 实时输出，`useJob` 轮询详情、`useJobLog` 按字节偏移增量取日志）；**点开任务一律走 `useOpenJob(sessionId, pid)`**（回调卡与右栏共用：子代理 / 团队成员去 `sub` 标签，其余开 `job` 标签、已开就激活），不在入口处各写一份；对话流里的卡片统一走 notice（后台任务回调 `tab/JobNotice.tsx`、目标 `tab/GoalNotice.tsx`；`api` 的 `NoticeBody` 联合，`noticeKey` 认同一张），按 `afterIndex` 锚定在消息之间、不进消息下标（`ConvState.notices` 与 `tab/notices.ts` 的 `placeNotices`）；**目标的每次变化都由服务端出卡**，前端不再对比快照推断（`tab/flowLog.ts` 只管压缩回执与弹窗落定），目标文案在 `model/goal.ts` 与 `tab/goalNotice.ts`。ExecTab / ChatTab 里的 `useOpenJob` 需要 `LayoutProvider`，直接渲染 `def.render` 的测试要包一层。
- **用户写给 agent 的文字框一律用 `features/chat/input/RichInput`**（文字 + 附件：选文件、粘贴、拖入、上传进度与重试都在里面）：提问回答、目标编辑、排队编辑、执行体的补充要求都是它。附件放在哪由 `AttachmentSink` 决定：会话草稿用 `draftSink(...)`，组件自己的用 `useLocalAttachments()`；已有的附件（排队消息、目标、回退回填）用 `refToAttachment` 转成已就绪的附件，发出去只带 `{ path }`（`attachmentPaths`），没就绪的拦在 `pendingReason`。`RichInput` 不给 `sink` 就是纯文字（对方收不了附件时用，如审批的拒绝理由、插件的输入弹窗）；弹窗卡片的形状只看 `Prompt.options` 与 `Prompt.input`（没有 `kind`）；对话流里的输入行聚焦要 `preventScroll`（`RichInput` 的 `autoFocus` 已处理，原生 autoFocus 会让贴底的流被判成「用户上翻」）。主输入卡自己持有文字框（斜杠菜单与引用），附件部分同样用 `AttachmentBar` + `useFilePicker` + `useUploads`。**别直接用 `<Textarea>` 接收要发给 agent 的内容**：只有文字，附件会再丢一次；`input/input.guard.test.ts` 拦（对话区里文字框只能出现在 `RichInput` 与 `Composer`）。服务端对应 `resolveUserContent`（见 `ys-server`）。
- chat 区（`features/chat/`）同一套分法：纯函数各自一份带单测（`tab/toolGroups.ts`、`liveLine.ts`、`navTicks.ts`、`slash.ts`、`status/subTree.ts`），组件只编排；窗格头里的入口走 `TabDef.headAction`（chat 填、`PaneView` 渲染），不让 workspace 反过来依赖 chat。

## 逻辑写法

- 草稿只装「设置」，不装动作；数字类输入在草稿里存字符串，**保存时才校验与换算**；保存成功后用服务端回来的值重置草稿。
- 组件挂载要触发加载（`useEffect(load)`），别漏——漏了页面永远停在「正在读取」。
- **标签里的界面状态切走会丢**：窗格只渲染当前标签，切走组件卸载、切回是新实例，只放 `useState` 的状态一定丢。要保留的：标签身份走 `patchTab`、**设备相关的视图状态**（滚动、选中、模式）走 `useTabView(tab.id, parse)`（浏览器本地，键带工作区 id + 标签 id，关标签由 `watchLiveTabs` 统一清；记录里带「属于哪个文件 / 目录」，对不上不恢复；范例 `files/viewState.ts`）、要跨设备的轻量状态走 `afx`（白名单，要在 `persist.parseAfx` 里加校验）、大的或带未保存改动的放组件外 store（**按标签 id 各一份**；模块级 Map、按绑定键存，没人用且没有未保存的改动才丢）；**未保存的文本草稿按被编辑的东西存**（`preview/fileDraft.ts`）。浏览器本地的读写一律走 `app/localState`，不直接碰 `localStorage`。范例是画布（`tabs/canvas/useCanvasStore.ts`、`nav.ts` 的 `saveNav / loadNav`）；机制见 `docs/model/layout.md` §3。
- **往对话里加引用**（笔记 / 卡片的「添加到对话」这类）：标签里用 `tabs/useAddToChat.ts` 的 `useAddToChat(sessionId)`，调 `(label, text)`；它把内容放进**标签借用的会话**的输入草稿（引用 chip，发送时拼成 `Quote <来源> + 围栏块`，agent 看得到出处），并在 toast 里写明是哪个对话。来源标签写 `主机展示名:绝对路径:Lx-Ly`（`canvas/quote.ts` 的 `canvasFileLabel`），别在标签里直接碰 hub。编辑器选区取 `EditorHandle.selection()`。
- **文件拖拽带的是一批**：`FileDragItem.entries`（至少一项），单个文件也是一项；新增消费方（落点、引用）按 `entries` 取，别再往 `FileDragItem` 上加单项字段。
- 保存条放 `ListColumn` / `FormPane` 的 `footer`，不要放进带底边距的内容里（会被顶起来）。
- 带 `peek` 的 `ListRow` 外面会多一层 `.u-hc`：放进 flex 容器时，要给 `.u-hc` 补 `flex: 1; min-width: 0`。
- 命名沿用代码里已有的词；新词首次出现要当场解释。
- **量高度的 `height: auto` 会同步触发布局，把滚动容器的 `scrollTop` 夹小**：textarea 自适应高度要先缩回一行再读 `scrollHeight`，这一瞬间输入卡变矮、上面的对话流变高，浏览器把贴底的位置夹到更小的最大值，之后再撑回去就多出一截「距底」，越过阈值就被当成上滑。修法是量的那一刻锁住外层高度（范例 `chat/tab/Composer.tsx`）。jsdom 没有布局，复现不了，用 `scripts/verify-chat-scroll.mjs`（逐行敲入、每行量一次距底）验。
- **点开一项时贴底的跟随会把它顶出视口**：跟随逻辑把「内容变高」一律钉到底，点开一个很长的输出时，被点的那一行会被推到屏幕外。对话流（`chat/tab/Stream.tsx`）用 `aria-expanded` 识别展开点击、放弃本次跟随（运行态那一行例外）；新增可展开的行要写 `expanded`（`ListRow` 会写出 `aria-expanded`），否则享受不到这条保护。
- **`api/http.ts` 的 `request()` / `call()` 只把 204 当无响应体**，其余成功状态都 `res.json()`：返回 200 / 201 且不带 body 的接口，界面会显示「操作没有成功」，而 REST 本身是成功的（单测里的假服务端不报错，只有真浏览器里才暴露）。没有数据要回的动作服务端一律回 204，假服务端的状态码要与真服务端一致。
- **画面里的键盘输入要落在可编辑元素上**：焦点在普通 `div` 上时浏览器不启动输入法，拼音会被当成一个个英文字母，中文输不进去。浏览器标签用一个看不见的 `textarea`（`ws-wb-ime`，`tabs/web/Stage.tsx`）当落脚点；jsdom 里发 `compositionend` 测不出，验收脚本用 CDP 的 `Input.imeSetComposition` + `Input.insertText` 模拟组词与上屏（`scripts/verify-browser-ui.mjs`）。
- **xyflow（画布）的踩坑单独放在 `references/xyflow.md`**：改画布或任何用 `@xyflow/react` 的界面前先读。要点只有三条：库自带 CSS 不分层、压过 `@layer`，先找它的 `--xy-*` 变量；节点里放交互内容要加 `nodrag nopan nowheel nokey` 类；传给 `ReactFlow` 的回调一律是稳定引用（走 ref）。

## 测试

- 只测关键路径；组件测试用 `testkit`；jsdom 测不出布局和滚动，那部分交给真浏览器脚本（见 `ys-delivery`）。
- 命令：`pnpm --filter yuanshu-harness-web exec vitest run <路径>`，类型 `pnpm --filter yuanshu-harness-web exec tsc --noEmit`。
