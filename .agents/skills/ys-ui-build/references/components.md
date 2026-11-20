# 组件目录与标准件

基础组件在 `packages/web/src/ui/`，设置页框架在 `packages/web/src/features/settings/frame/`。长相与刻度见 `ys-ui-design`。
**原则**：业务代码不得自己造这些东西；缺了先补进 `ui/`，不在业务目录里写一份。同名组件不再定义。

## 1. 基础组件（`ui/`）

| 组件 | 变体 | 说明 |
|---|---|---|
| Button | `primary`（墨）/ `outline`（描边，默认）/ `secondary`（灰底无边框）/ `ghost`（无底无边框）/ `danger`（红字）；大小 `sm` 28 / `md` 32 / `lg` 36 | 主按钮同屏只有一个 |
| IconButton | 28（`size="sm"` 为 20）；悬停才出现的加 `u-reveal` 类，放在 `ListRow` / `Card` / `SummaryRow` 里随悬停或聚焦显示 | 不可用时置灰并带原因提示 |
| Input / Textarea / SearchBox | 32、36 | |
| Select | 触发器 + 自绘菜单，当前项带勾 | `options` + `onChange(value)`，基于 `Popover`。带搜索的多选面板是 `workspace/dialogs/PickerPop`（只给主机选择用），与 `Select` 共用 `Popover` 外壳 |
| Menu / Popover | | `Menu` 是「…」触发的动作菜单；自己排版的菜单（分步选择）用 `Popover` + `MenuRow` |
| Segmented | 滑动指示块；不可用项带原因 | |
| Tabs | 滑动墨色下划线 | 设置页内用 `PageTabs` |
| Switch / Checkbox / Slider | 自绘 | `Slider` 目前仍是原生 `range` 套样式 |
| Chip | 中性 / 墨 / 蓝 / 状态字色 | 文字用辅助字；身份标记（内置、已信任）也用它的 tone，没有实心色块的小标签；`FilterChip` 是可点的筛选胶囊 |
| Dot（状态点） | 绿脉动 / 琥珀 / 蓝 / 红 | 语义见 `ys-ui-design` 的 visual-language §4 |
| Kbd | | 快捷键写平台中立的文字（`Ctrl+N`，X03），按键用它分开画 |
| 图标 | 16 格、1.6 描线 | 都在 `ui/icons.tsx`，新图标往里加，不在业务目录另写一份 `make`；文件标签自己用的通用图标是 `workspace/tabs/files/icons.tsx` 里的 lucide 薄封装，不并进 `ui/icons.tsx` |
| Modal | | |
| Sheet | | 底部抽屉（头部 + 自己滚的内容区，点遮罩 / 关闭键 / Esc 关闭，`className` 改样式）；手机端的弹层用它，`onClose` 接返回（弹层占一条历史）。桌面没有用到 |
| ConfirmDialog | 普通 / 危险 | 受控的 `ui/ConfirmDialog.tsx`。与 `ConfirmButton`（点两下确认）的分工：轻量用后者，要说明连带影响的（删工作区、删 Agent）用前者 |
| FormDialog | | 表单弹窗：页脚统一为「[左侧次要操作] …… 取消 · 确定」（可改文案），回车提交，没填完主按钮置灰，提交中转圈，失败文案留在弹窗里，有输入时不点遮罩关闭；`readOnly` 只留关闭。纯确认仍用 `ConfirmDialog` |
| Toast | info / ok / warn / danger | |
| InlineNotice | 提示 / 警告 / 错误 | **左侧一个状态点 + 文字，不铺底**；需要更强时加 1px 左线或描边，不铺色块 |
| Card | 静止 / 悬停（上浮 1px + 中阴影）/ 带 `reveal` 操作区 | 预设卡片、列表页 |
| ListRow | 紧凑 28 / 舒适 32；带状态点、副标题、悬停操作、`peek`、折叠区标题行的 `expanded`（写 `aria-expanded`）、不可点的 `disabled`（灰字、主按钮禁用） | 左轨会话行、文件行、设置里的行共用一套；单击 = 临时查看、双击 = 固定、拖拽 = 空间操作（X01）在这里统一 |
| Tree | 目录树（Obsidian 式导航）：嵌套行（复用 `.u-lrow` 紧凑 28，缩进每层 16）、展开箭头、方向键 / Enter / F2 / Delete、Ctrl / Shift 多选、行内改名、右键菜单、拖拽移动 | **不认识文件**：收 `nodes`（`{id: 相对路径, kind: folder\|item}`），同层文件夹在前、按名字排，没有手动排序，所以拖拽只有「挪进文件夹 / 拖到空白挪到根」；改名（`onRename`，返回字符串=行内报错）、移动（`onMove`）、删除（`onDelete`）都交给业务去做并刷新 `nodes`；`canDrop` 补业务判定（重名），已排除落进自己的子孙；菜单的 `actions.rename()` 让该行进入行内改名；悬停收起的文件夹 600ms 自动展开；`onDragStartNodes` 让业务往 dataTransfer 补载荷（如把笔记拖到画布上）；`initialFocus` / `onFocusChange` 让外壳记住焦点行（树被收起又展开时带回来；`current` 换了焦点跟过去）。纯逻辑在 `ui/treeModel.ts`。文件管理器、侧栏、窗格布局的拖拽是各自的旧实现，没有迁移 |
| SummaryRow | 名称 + 值 + 灰色「· 跟随默认」+ 悬停箭头 | 创建弹窗、会话设置的折叠摘要行；「恢复跟随」（X02）也挂在这里 |
| HoverCard / PeekCard | | 列表行悬停详情卡片，`ListRow` 传 `peek` 即带卡片；`PeekCard` 是内容版式（标题、正文、键值对）；`HoverCard` 可传 `width`（内容很少时收窄，缺省 296） |
| Drill | | 弹窗里的二级页（摘要行点进去换成这一页，左上角返回） |
| TabStrip | 窗格头标签条：图标 + 固定宽度标题 + 悬停才出现的关闭键；临时标签斜体；双击固定 | 工作区窗格头自己排版时，标签主体用 `StripMain`、关闭与新建用 `IconButton` |
| 平铺布局 `ui/tiling/`（从 `ui/tiling` 引，不在 `ui/index`） | `TilingLayout`（分割树 → 格子 + 可拖分隔条，容器 ≤780px 自动上下堆叠）、`PaneFrame`（头 + 内容 + 六个落点叠层）、`WindowBar`（窗口胶囊条，胶囊可作拖放落点）；`tree.ts` 是分割树纯函数、`zones.ts` 是落点几何 | 容器内的平铺可拖拽布局。**不认识标签类型与主机**：调用方传 `renderLeaf` / 头 / 落点判定，主机隔离、会话拖入、关闭确认留在调用方（范本 `features/workspace/layout/`）。头直接用标签条版式（`u-strip`，36 高，与落点 `STRIP_HEIGHT` 同高）。样式 `ui/styles/tiling.css`；工作区保留 `ws-` 类名作测试钩子 |
| Empty | 虚线框：标题 + 灰字说明 + 可选按钮 | **真没有内容**时用；整块读取失败加 `tone="danger"`（标题变红），别让「出错了」和「还没有」长得一样 |
| Loading | 一行：转圈 + 灰字，`role=status` | 读取中用它，**不要拿 `Empty` 摆「正在读取…」**；读完换成内容或 `Empty` |
| Table / ProgressBar / SplitHandle / ReadBar / ImageViewer | | |
| FileTypeIcon | | 按文件名挑图标，见 §3 |

Tooltip 不做：提示用原生 `title`（带 `peek` 的行除外）。

## 2. 提示条与状态标记

- 提示条用 `InlineNotice`：表单、弹窗、面板里的失败 / 警告一律用它（`tone="danger"` 自带 `role=alert`），**不自写 `<p role="alert">` 加红字**；行上的小标签、卡片的状态用 `Chip` 或 `Dot`——语义靠点和字色，不靠底色。
- 状态怎么选：读取中 `Loading`；真空 `Empty`；整块读取失败 `Empty tone="danger"`；行内的失败 / 警告 `InlineNotice`；一过性的结果 `toast`。
- 选中 / 聚焦的极浅蓝底（`--accent-bg`）是唯一允许的淡底。

## 3. 文件类型图标

`ui/FileTypeIcon` 按名字挑图标，数据在 `ui/file-icons/`：`mapping.json` 手写映射，`resolve.ts` 查表，`file-icons.generated.ts` 由 `scripts/gen-file-icons.mjs` 生成。图标取自 `@iconify-json/catppuccin`（MIT，许可全文在 `licenses/Catppuccin-icons.txt`，`NOTICE` 已登记），只取映射用到的。图标里的色值是 `var(--ci-*)`，**换色只改 `tokens.css` 那一组，换整套图标只改生成脚本与 `mapping.json`，组件接口不变**。映射三层：特殊文件名（`package.json`、`Dockerfile`…）→ 前缀 / 复合后缀（`.env.*`、`.d.ts`、`.test.ts`）→ 扩展名；目录名另有一张表；都不认识就退回通用文件 / 文件夹。

## 4. 守卫

五类设计守卫（type / scale / color / control / tag）的红线与基线制见 `ys-ui-design` 的「守卫会拦的」，这里只补细节：

- **scale**：`gap` / `padding` / `margin` / `height` / `min-height` / `border-radius` / `z-index` 的 px 取值要在刻度表里；组件固有尺寸（状态点、滑块、读条、分隔线这类）登记在 `test/guard/scan.ts` 的 `INTRINSIC_SELECTORS`，要写理由。
- **color**：业务 CSS 不得直接写色值，只能用令牌；`*-soft` 令牌已删除、不得对语义色做 `color-mix` 铺底（错误提示用字色 + 描边）。
- **control**：业务 TSX 不得出现裸 `<select>`、`<button>`（`ui/` 自己除外）、`<input type="range|checkbox">`；不得再定义 `ConfirmModal`。
- **tag**：标题标签带了字样角色类（或 `sr-only`）就放行。
- `src/visual-rules.test.ts` 与 `src/cssReach.test.ts` 守令牌值与样式是否被入口引到。

## 5. 设置页框架（`settings/frame/`）

新设置页必须用这些件，不自己写页签栏、列表栏、保存逻辑。约定本身见 `ys-ui-design` 的 interaction X04–X07。

| 件 | 说明 |
|---|---|
| **SettingsLayout**（外壳） | 导航靠底色与主区分开：没有外框、顶栏、导航分隔线；「返回」放导航最上面；导航项深字、当前项浅灰底。页面留白 `--st-gutter`（24）在这里定义。同时提供离开保护的对话框 |
| **PageTabs** | 页签条：线通栏、文字缩进到留白。页内所有 `Tabs` 都用它 |
| **Page / SplitPane / FormColumn / FormPane / ListColumn**（`layout.tsx`） | 页签条以下的版心：`Page` 占满主区、`SplitPane`（左 `RailList` + 右详情列）、`FormColumn`（最宽 720 居中）、`FormPane`（单栏设置页：自己的滚动区 + `FormColumn` + `footer` 保存条）、`ListColumn`（内容从留白起铺满、整页滚；`footer` 放保存条：它要贴着滚动区底部，不能放进带底边距的内容里）。**每一栏自己滚**，页面不再各自写 overflow |
| **RailList** | 主从页的左列表（窄于 760px 时列表在上、限高 220 自己滚，详情在下）：头（标题 + 数量，可带「⋯」`menu`：作用于整张列表的操作，如技能的「检查更新」）、搜索、可折叠分段（组头可有「⋯」菜单）、行（`ListRow`：名字 / 副标题 / 状态，悬停浮「⋯」与详情卡片）、底部添加按钮。搜索、添加、行的卡片与菜单都可以不要（卡片库的分组只是一列导航） |
| **DetailHead** | 主从页详情头：40px 图标块（图标或两个字母）+ 名字与一行说明 + 状态点与文字 + 主操作与「⋯」 |
| **CardGrid** | 卡片列表页：搜索 + 主按钮、卡片网格（`Card`，点标题打开）、空状态；卡片上的操作都收进悬停浮出的「⋯」菜单 |
| **useDraft / SaveBar** | 草稿钩子（`dirty`、`save`、`discard`；保存结果自动弹右下角提示，失败保留草稿）与滚动区底部的保存条（Ctrl+S） |
| **useLeaveGuard / useBindDirty** | 离开保护：页面用 `useBindDirty({ dirty, save, discard })` 登记未保存状态，切换对象 / 切页签前用 `guard(go)` 包一层；设置导航与「返回」由壳统一拦截 |
| **notify** | 动作的结果提示：`notify(problem, done)`，有问题弹红色、否则弹绿色 |

**版心**：单栏设置页与详情列最宽 720 居中（`FormColumn`）；列表页内容从留白铺满；主从页左列表宽 240 + 2 × 留白。
