# 文件、预览与改动追踪

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`preview/{limits,kind,usePreview,HtmlView,HtmlInBrowser,ConflictDialog,MergeEditor,fileDraft,mdImages}`、`files/{transfer,download}`、`diff/DiffTab`、服务端 `watch/hub.ts`、`git/status.ts`、`api/{git,turn-changes}.ts`；界面交互细节未逐条核）

文件浏览器（`files` 标签）、文件预览（`preview` 标签，含 diff 形态）、变更推送、git 面板与「本轮改动」卡片。代码在 `packages/web/src/features/workspace/tabs/{files,preview}/` 与 `packages/server/src/{watch,git,changes}/`、`api/{files,git,turn-changes}.ts`。术语「目录」「工作区」见 [`workspace.md`](workspace.md)；对话里的内嵌图片与文件链接见 [`chat-render.md`](chat-render.md)。

## 1. 预览：纯前端渲染

- **一律在浏览器里渲染，不做服务端格式转换**（不引 LibreOffice）。选型按体积（minify / gzip）：docx-preview 171KB / 49KB、SheetJS 329KB / 110KB、epubjs 352KB / 105KB、pptx-preview 1330KB / 421KB；Univer 11112KB / 2737KB，**明确不上**，表格走 SheetJS（含 csv、tsv、ods）。
- **降级阈值**（`preview/limits.ts`）：解析类（docx / xlsx / pptx）20MB、图片 5MB、PDF 100MB，超限提示下载到本地看；文本 / 代码 / JSON 超过 5MB 不整读，退回只读预览前 256KB（不可编辑）。阈值作用在 pdf.js 自身的按需渲染降级，不是按大小切换引擎。
- **PDF 不做 zpdf-wasm 动态路由**：真实文档上会静默丢字（非嵌入 base-14 字体只画线框）、加密 PDF 直接抛错、wasm 内存只增不减、首包 2799KiB 对 496KiB；且 pdf.js 冷首屏成本与文档总量几乎无关（9 页到 3057 页，150ms 到 212ms）。以上来自真实文档上的对比实测。缺字体 / CMap 的修复靠构建前复制 pdf.js 资源（`scripts/copy-pdfjs-assets.mjs`，产物被 git 忽略）。
- **HTML 文件的预览有两种**：预览标签里 HTML 的「预览」态**内嵌运行**页面（`tabs/preview/HtmlView.tsx`，`<iframe srcdoc>` 装文件原文），旁边的「在浏览器中打开」（`HtmlInBrowser.tsx`，工具条 lead 槽里的按钮）把它交给工作区浏览器（按 `<环境>.files.localhost/<路径>` 加载，相对链接、本地样式与脚本都能用，沙盒与代理拦截由浏览器栈负责）。定位是**自包含的单页**（mock 设计、一次性小应用、可视化讲解）：内联脚本与样式、CDN 上的脚本 / 样式 / 字体都能加载，**相对路径的本地资源不加载**（那种页面走浏览器）。**隔离**：`sandbox` 给 `allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox`，**不给 `allow-same-origin`**——页面是不透明源，读不到本应用存在 sessionStorage 里的令牌、也调不了带登录态的接口（顺带 `localStorage` 之类要同源的能力在页面里不可用）；`referrerPolicy="no-referrer"`，CDN 收不到 Server 的地址（srcdoc 页面默认会带上上层的来源，去掉这条就泄露）；iframe 设 `user-select: none`，不然上层文档的选区扫过它时整个框被涂成选中色。内容是编辑器 / 磁盘上最近一次载入的原文，保存后会灌回；文件被截断（超出整读上限）时没有预览态。标签缩放用 CSS `zoom` 乘在 iframe 上（盒子始终铺满、页面视口按比例变窄），页面里面的 Ctrl+滚轮是页面自己的、不触发标签缩放。真机验收 `scripts/verify-html-preview.mjs`。
- **预览态与编辑态是同一个 CodeMirror**（预览为只读），高亮完全一致；svg 归为文本类，能当图看也能看源码并编辑。
- **Markdown 里的图片**：`MarkdownView` 的 `imageBase`（`markdown/imageRef.ts` 的 `ImageBase`）说明相对地址相对于谁，图片沿用对话里的 `ImageBlock`（取回内容、点击放大）。**两种形态**：`file`（预览标签里的 md：相对它所在目录，走文件接口，`%20` 之类的编码会还原，`../` 能出目录）；`canvas`（画布标签里的笔记：相对笔记所在文件夹，换算成相对 `.canvas/` 的路径后走画布 `/image` 接口，读的是 Server 本机副本，所以 ssh 项目里刚粘贴、还没推到远端的图也能显示）。svg 用 `<img>` 显示、不内联（服务端给 svg 带 sandbox CSP）。**外链 http(s) 不加载**（不向第三方发请求），显示成可点开的 `[图片：说明]` 链接；读不到的显示同样的占位。**画布卡片（`light` 模式）仍是占位**：卡片上只显示正文摘要，图片没有意义。对话里的图片规则不变（相对路径按会话 directory）。视频 / 音频 / pdf 在 md 里的内嵌先不做。验收 `scripts/verify-md.mjs`、`verify-canvas.mjs` 第 26 段。
- **粘贴 / 拖入图片与 svg**（项目里的普通 md 走文件接口 `preview/mdImages.ts`，`.canvas/` 笔记走画布接口 `canvas/noteImages.ts` + `PUT /canvas/:env/note-asset`，做法见 [`canvas.md`](canvas.md)；编辑器侧是 `mountEditor` 的 `onFiles`；验收 `verify-md.mjs`、`verify-canvas.mjs` 第 27 段）：粘贴时剪贴板里还带着文字（比如从表格复制）就照常粘贴文字，不存图片；只认图片（含 svg）；链接地址里空格、括号、百分号等转义（`%20`、`%28`），中文原样；预览态渲染的是磁盘内容，所以插入后要先保存才在预览里看到。**规则：图片统一放在 md 所在目录的隐藏文件夹 `.assets/<md 文件名>/` 下**（文件名不带扩展名，如 `笔记.md` → `.assets/笔记/`）。不用 md 旁边的 `<名>.assets/`：md 一多目录很快就被淹没，所以统一收进一个隐藏的 `.assets/`、再按文件名分一层。光标处插相对路径的标准链接 `![](./.assets/<名>/<文件>)`（与「拖引用生成相对路径链接」同规则，svg 同样带 `!`）；**项目里的普通 md 与 `.canvas/` 里的笔记同一规则**。粘贴的截图命名 `image-日期时间.png`，拖入的文件保留原名、重名加 `(2)`。`.canvas/` 里的笔记走画布接口（那是唯一会机械同步引用的入口），服务端让笔记的改名 / 挪动 / 删除带着它的资源夹一起走（做法见 [`canvas.md`](canvas.md)；`classify()` 为此有一类 `noteAsset`，`scanTree` 本来就忽略点开头的文件夹，所以资源夹不会出现在树里）；项目里的普通 md 走文件接口，**在文件管理器里改名 md 不会带走 `.assets/<旧名>/`、链接会断，删 md 也不会删它**（已知限制，不去替用户改别人的文件）；`.assets` 是隐藏文件夹，文件管理器默认不显示（要看的话打开「显示隐藏文件」）。

## 2. 编辑与冲突

- **只有「预览 / 编辑」两段，默认编辑**；没有渲染态的格式（代码、文本、JSON）只有编辑框一种形态，不给假的切换。保存区只留**未保存标记 / 还原 / 保存**，进预览标签那一行工具条的最右端（`BarSlots` 把 `TextView` 的切换与 `CodeEditor` 的保存区 portal 进去）；未改动时「还原」与标记都不出现，「保存」置灰。
- **外部改动与自动重载的判据是「有未保存改动」**，不是「在编辑」（默认就在编辑态，按后者永远没有可以自动刷新的时刻）。无未保存改动时热替换；有则提示「磁盘上的文件已被改动」。重取同一文件时保留现有内容、只标 `refreshing`，组件不卸载、模式不丢。
- **未保存草稿的本地暂存**（`fileDraft.ts`、`CodeEditor.tsx`）：编辑中防抖（400ms）把文本存进浏览器本地，**键是（主机，路径）**、带开始编辑时的磁盘基线；切到「预览」再回「编辑」、同窗格切走标签、关掉标签（不拦截、不弹确认）、刷新，下次打开这个文件都恢复草稿并提示「已恢复上次没保存的改动」，编辑器显示草稿并标「未保存」；恢复时保存用的基线是草稿里那一版，磁盘变过则保存走上面的冲突合并，磁盘内容已与草稿一样就丢弃草稿；保存、还原、取磁盘版、合并、覆盖、「放弃编辑并重载」、内容改回与磁盘一致时删。「未保存」以编辑器内容与磁盘内容是否相同为准（保存后推进）。只读（超限）的不暂存；超过 100 万字符不暂存并删掉旧草稿；启动时清掉 30 天没动的；`.env*`、私钥（`id_rsa` 等、`.pem` / `.key`）、`.ssh/` 下的不暂存（短名单，不是安全功能）。**已知**：预览态渲染的是磁盘内容，不是草稿；切预览再切回编辑也会弹一次恢复提示。设计细节（键、容量、敏感路径、统一模块）在 [`layout.md`](layout.md) §3「标签的状态放哪」。
- **保存成功要把内容与基线灌回预览状态**（`usePreview.applySaved`），不额外发请求，也不等 `fs.changed`（自己的保存会被挡掉）；否则切回预览仍是旧内容。
- **冲突**用基线（mtime + sha256）判定；对话框「文件已被改动」可看差异 / 我的内容 / 磁盘内容，处理三选一：覆盖磁盘内容（保留我的）/ 放弃我的修改（加载磁盘版本）/ **合并**。合并用标准做法 `@codemirror/merge` 的 `unifiedMergeView`：正文是我的内容，`original` 是磁盘内容，对方改动逐块高亮并可采纳 / 退回，另有「全部采纳对方 / 全部保留我的」；不自己拼左右分栏，git 冲突合并有标准做法，直接套用。灵感画布复用这一整套，见 [`canvas.md`](canvas.md) §6。
- **语言高亮**查 `@codemirror/language-data`（143 种，按文件名与扩展名匹配，语言包按需加载），对话代码块另走 highlight.js（见 chat-render §2）。没有官方包的按纯文本：GraphQL、Elixir、Zig、Nim、HCL、Svelte、Solidity。两个坑：`LanguageDescription` 与语言注册表必须放进 `await import()`，静态导入会把 `@codemirror/view` 的默认主题色打进入口包、被 token 守卫拦下；`@codemirror/legacy-modes` 必须在 web 包显式安装，否则 toml、shell、nginx 这类语言静默降级成纯文本，表现是「有语言但没高亮」，很容易误判。

## 3. 变更推送与 git

- **订阅协议**（沿会话的 WS）：`{type:"watch", env, paths}` 整体替换该会话的订阅集合，空数组即退订；服务端帧 `{type:"fs.changed", data:{env, paths}}`，去抖 300ms 合并，只含订阅集合内的路径。
- **服务端**（`watch/hub.ts`）：按 `envId + path` 引用计数共享底层监听；本地用 `fs.watch`（非递归），**远程主机按环境轮询**（目录比名字 + 大小 + mtime 的签名，文件比 mtime + 大小，首轮只建基线）；路径不存在静默跳过、下次订阅重试。
- **前端**：订阅聚合在 `ChatHub`（服务端是整体替换，同一会话的文件标签与预览标签各发各的会互相覆盖，所以按持有者记录、按环境求并集再发）；目录被改名或文件被「临时文件 + rename」替换后 `fs.watch` 会静默失效，每次拿到新数据都重发一次订阅兜底。
- **git 面板**是文件浏览器的「版本」视图：工具条上的**分支胶囊**（分支名 + 未提交条数）就是入口，点它进 / 出，**只读状态加切换分支，不做提交**。接口 `GET .../git/status`（非仓库回 `root:null` 的 200，不是 404，前端据此隐藏着色）、`git/branches`、`git/file`（HEAD 版本与磁盘现状两侧）、`POST git/checkout`；脏工作区三选一 `stash | carry | abort`，分支名白名单校验防注入，状态缓存 1.5 秒。文件名按状态着色（新增 / 未跟踪绿、修改黄、删除红线、冲突红加粗）。
- **工作区 diff** 复用 `preview` 标签的 diff 形态：`diff.turn` 为数字是某一轮的改动，**`null` 是工作区对 HEAD**。对话栏内**不就地渲染 diff**：点文件名开独立标签，优先同主机的预览窗格。

## 4. 「本轮改动」卡片

- **双轨追踪**：git 仓库用独立临时索引（`GIT_INDEX_FILE`）对比两棵 tree，覆盖 bash 造成的改动，不碰用户的 index 与工作树；非 git 目录退回 write / edit 前后的内容比对（`changes/tracker.ts`）。
- 库里的 `turn_changes` 只存清单与 `anchor_ts`，**diff 正文放 `data/turn-changes/<会话>:<轮>/`、不进库**；副本没了就只显示清单，取正文返回 410（`api/turn-changes.ts`）。

## 5. 文件浏览器的交互

- 多选只由 ctrl / ⌘ 与 shift 触发；多选时**工具条同一行换成选择条**（已选 N 项 / 复制路径 / 删除 / ×），不增行，列表不跳；普通单击只留灰底标记，不弹选择条。**点文件 = 预览，且分临时与固定**（与对话标签一致）：单击 / 空格在预览窗格里开**临时**预览标签（斜体，再单击别的文件就地替换），双击行 / Enter 才固定成正常标签；目录单击仍是进入。规则细节在 [`layout.md`](layout.md) §3「预览标签的临时 / 固定」。（交互标准 X01 的「单击选中、双击打开」不适用于文件行：单击就有预览。）
- 右键菜单：下载、重命名、复制路径、删除；新建文件复用保存接口（不带基线就是新建）。
- **下载**（行菜单 / 右键，文件与文件夹）：文件走 `content?download=1`；文件夹走 `GET /environments/:envId/files/archive?path=`，Server 用 `ExecEnv` 原语流式打成 zip（`lib/zip-stream.ts` 手写 zip 编码、`env/archive.ts` 走目录；隐藏文件照打、符号链接不跟随、不设大小上限、客户端断开就停止读盘）。前端 `files/download.ts` 带令牌 fetch 后 `saveBlob` 另存，进度借传输条的作业卡片（文件夹打包整体大小未知，只给进行中的条）。多选时右键只下载点中的那一行，没做批量下载。
- **批量拖拽**：拖的是选中项之一就带整批（`FileDragItem.entries`，按列表顺序）。同主机逐项移动（`moveEntries`：一项失败就停，已搬的保留并提示），跨主机逐项起传输任务（`transfer.ts` 的规划本来就按条目拆任务）；批量里落不下去的（目录进自身、已在目标目录）跳过，整批都落不下去才拒绝；幽灵条显示首项名与 `+N`。拖进对话 / 画布也是整批（画布跳过其中的文件夹）。
- 拖进对话插入 `file:<主机>:<绝对路径>`，多选每行一条；与「拖系统文件上传」按来源分工，互不抢落区。
- 预览的落点：没有同主机的预览窗格就在右侧新开窗格，不把文件管理器挤掉。

- **工具条永远一行**（36 高，没有列头）：上一级、面包屑（放不下露出末尾，左端淡出，每段也是拖放落点）、分支胶囊（仓库里才有）、新建（菜单：文件 / 文件夹）、隐藏文件开关（眼睛图标，按下 = 显示隐藏文件，状态随标签视图状态保存）、刷新（图标）、更多（复制路径）。窄窗格按窗格宽度收：≤460 藏时间、≤400 藏「新建」二字、≤340 藏分支名与大小。行是标准 `ListRow`（紧凑），右侧 git 字母、大小、时间；「…」菜单悬停才出现。
- **预览工具条同样一行**：左 = 「预览 / 编辑」（有渲染态才有）+ 文件信息（类型 · 体积，窗格 ≤400 藏；完整路径在它的悬停提示与标签提示里，主机在窗格头）；右 = 复制路径、下载、保存区。截断、被外部改动是一条 `InlineNotice`，不另占状态栏。

## 6. 踩坑

- **pptx-preview 不要传 `height`**，否则库把高度写死并内部滚动，只显示第一页加黑条；用 CSS 覆盖 wrapper 的背景与高度，缩放按外层容器宽度算。
- 富内容缩放统一用 CSS `zoom`，非 100% 时右下角显示比例，点击复位。
- 预览标签整体另有一层 Ctrl+滚轮的缩放（文字放大字号，**图片与 SVG 放大显示尺寸**，见 layout.md「标签的内容缩放」）；富内容（docx / sheet / pptx / epub / pdf）自己处理了 Ctrl+滚轮，不叠加。
- pdf.js 在测试里第一次 import 后 `TextLayer` 会变成真实模块，动态 import 的 promise 必须 memo 化（`pdfjsLoading`）。
- 对话正文折行过早的根因是 `.ch-md p { max-width: 72ch }`：`ch` 按半角算，中文实际只有约 550px，别再给段落单独限宽。
- **epub 的分页版式与位置偏移没有彻底解决**，已知缺陷集中在 `EpubView.tsx`，别再花时间试库参数。
- 对话流跟底滚动的根因是图片 / svg 迟到载入把视口顶上去，已在 `pinnedTop` 处理。

## 7. 未实现与未决

- 空白处右键的「新建文件 / 文件夹」没做。
- `fs.changed` 在远程主机上是轮询（默认 2 秒），不是事件；画布的文件监视复用这一套（见 [`canvas.md`](canvas.md)）。
- 终端、文件树与预览标签绑定的是「工作区的目录清单」而不是会话（[`layout.md`](layout.md) §3）。
