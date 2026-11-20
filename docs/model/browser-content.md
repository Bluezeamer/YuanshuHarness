# agent 浏览器：页面内容怎么交给 agent

Author: bluezeamer
Status: 现行（工具面见 [`browser.md`](browser.md) §3，本文只讲「主 agent 看到的页面内容是什么、怎么来的」；没验证的在 §8）
Date: 2026-11-14
Verified: 2026-11-19（对着代码核对：`packages/server/src/browser/agent/clean/`、`engine/page.ts`、`engine/img-src.ts`、`prompt/builtin-agents.ts`、`subagent/runtime.ts`、`server.ts`）

代码在 `packages/server/src/browser/agent/clean/`；快照管线的阈值集中在 `limits.ts` 的 `CLEAN_LIMITS`（各模块自己的内部上限，如 `elemdiff.ts` 的对齐格子数，留在本模块）。快照读取在 `engine/page.ts` 的 `snapshot()`。

## 1. 原则

- **丢弃必须声明且可取回**：任何省略都写明省略了什么、去哪取回，没有静默截断。
- **机械层只做无损、确定性的**；不确定是否无损的不做（实测曾把有损项混进「省 31%」，撤回后真无损是 25%）。
- **感知层只做投影，不做语义概括**：事实（名字、链接、文字、编号）只来自原树的展开，模型只给指针（元素编号、行号区间）；概括归主 agent。
- **不做启发式分类**：不设封闭词表、不让模型数数，结构判断交给模型指认。
- **intent 是一等公民**：每次调用自己带，不做页面级「当前意图」。
- **`raw` 保底**：`browser_snapshot` 的 `raw: true` 给完整原始快照，并重置基线。

## 2. 数据流

```
engine ariaSnapshot(ai) ──▶ RawSnapshot（完整原文，不截断，无位置框）
   ▼ mech.ts 机械层
MechText ──▶ 变量遮罩 ──▶ 辅助模型 / 只读 agent ──▶ JSON 指针
   ▼ project.ts：展开、夹取、核对、声明
给主 agent 的文字（envelope.ts 外壳）
```

没有视口过滤：读全页，滚动不是为了「看见」。辅助模型沿用设置里的「辅助模型」，**没配就不调用、不退回会话模型**。

## 3. 图片地址与机械层

**引擎层先补图片地址**（`engine/img-src.ts` + `page.ts` 的 `snapshot()`）：Playwright 的快照只给链接写 `/url`，**img 节点没有任何地址**，懒加载页面里分不清占位图与真图。`snapshot()` 取到原文后，对每个带编号的 `img` 节点（`svg role=img`、`div role=img` 不算）读它此刻的 `currentSrc || src`，写成 `- /src: <地址>` 子行（`data:` 地址只写 mime 与原串长度：`data:image/gif (78 chars)`）；单个读取失败当作没有地址，没有 img 时不多一次往返。原始快照（含 `raw: true`）与基线都带它。

快照读不到的其余东西（图片 / 视频 / iframe 的地址、`data-*`、form action、热区……）**不再往快照里补**，由 `browser_dom` 直接读 DOM（[`browser.md`](browser.md) §3）；这里补的 img 地址只为让操作时能看出占位图与真图、并让 diff 发现懒加载生效。

**机械层**（`mech.ts`）只做：①去 link / button 上的 `[cursor=pointer]`；②`/url`、`/src` 子行并入元素行（`link "名" [ref=e1] → 目标`、`img "名" [ref=e2] → 地址`；行内形式 `![名](地址){e2}`，没有地址的 img 保持 `![名]`）；③同源绝对地址写成根相对路径；④无名无文字不可点的 `generic` 空壳折掉（唯一子节点就地替换，唯一孩子上提，**只去空壳的编号**）；⑤孩子全是行内内容的节点并成一行（`[名](目标){编号}`、`*强调*`、`` `代码` ``；带名字又带孩子的、`time`、带标记的不并）。**不动**状态标记、`rowgroup` 与表格、其余编号。24 个真实页面合计省约 25%（逐页中位 24%），这是常数折扣不是数量级。

## 4. 完整路径（`read.ts`）

按 MechText 的字符数 N 分档（阈值见 `CLEAN_LIMITS`，初值如下）：

| 条件 | 做法 | stage |
|---|---|---|
| N ≤ 800 | 机械层原样给 | `direct` |
| 配了辅助模型，N ≤ 60000 | **单次调用**：带行号的 MechText + 任务 → JSON；解析失败重试一次 | `aux` |
| 配了辅助模型，N > 60000 | **只读页面阅读 agent**（§6）；不重试 | `agent` |
| 没配辅助模型，N ≤ 12000 | 机械层原样给 | `inline` |
| 没配辅助模型，N > 12000 | **结构视图** + 全文文件 | `structure` |
| 任何一步失败 / 超时 / 解析不了 | 按没配时的规则给，**最前面一行 `NOTE:` 写明原因**，不静默降级 | `fallback` |

两种任务（提示词全文在 `prompts.ts`，英文）：**overview**（没有 intent）`{gist, parts:[{caption, lines, refs, quote}]}`；**intent** `{groups:[{refs}], unresolved}`。行号区间是整块的起止行（取回游标，不要求对齐子树、可重叠）；`quote` 是没有编号的纯文字事实的行区间（如「1 item left」），Server 逐字复制。解析在 `pointers.ts`（容错：围栏、前后缀、类型不对的元素丢弃）。

## 5. 投影与声明（`project.ts`）

- **展开元素**：`<编号> <角色> "<名字>" [状态] [→ 目标]`，表单控件带当前值。**只有 link / button 名字为空时才向下借**（第一个有名字的子孙，再第一段文字），仍空写 `(unnamed)`；容器类（list、listitem、row、cell…）不借子孙名字，只写角色与编号，有自己的文字才追加。
- **核对**：不存在的编号丢弃并计数（`NOTE: N invalid pointers dropped`）；行号区间先交换再夹到 `[1, 总行数]`；同一编号只出现一次；每部分代表元素 ≤6、部分 ≤20、逐字引用 ≤40 行（超出写 `… quote truncated`）、gist ≤200 字、caption ≤80 字。
- **覆盖声明**：没被任何区间描述的行段写 `UNDESCRIBED: L714-782 (n interactive elements)`。
- 模型自由写的文字只有 `gist` 与 `caption`（intent 路径是 `unresolved`）：`gist` 行标 `(model-written, navigation only)`，`unresolved` 行标 `(model-written)`；整条输出仍标来自网络、不可信。
- **取回走文件**：overview 与结构视图的输出末尾带 `FULL TEXT (…): [attach_file] …`——**变量遮罩之后的** MechText 存成会话附件（`page-<页面>-<快照 sN>.txt`，第 n 行就是第 n 行），主 agent 用现有的读文件与搜索按行号取，不设专门的取回工具。intent 路径要的元素已逐条展开，不存文件。

## 6. 页面太大：只读阅读 agent

N > 60000 时辅助模型一次读不下（24 个真实页面里 6 个）。Server 先存文件，再起**内置只读 Agent**（预设 `page-reader`，`prompt/builtin-agents.ts`：只有 read 与 grep，沿用调用方的目录，页面正文以附件区地址给进去；用户可看可选用，不可改不可删，API 对一切写操作回 409 `builtin`），首条消息放**结构视图**：标题整行保留，每个标题段只留第一条 paragraph 行（≤150 字符），其余写成 `… L<起>–<止>（<n> 行未列出）`；视图自己超限就先去 paragraph、再从尾部截断并声明。agent 按 intent 读想看的行，最后 `deliver`，指针 JSON 放在 `report` 文件里，Server 经 `SubagentRuntime.readPage` 读回、照常投影。

- 总时限 120 秒；超时、没交付、深度已满、没有辅助模型都返回 null，回落到 `fallback`。起这个子代理**不占存活名额**，也不属于任何工作流运行。
- **代价**：几十秒到两分钟；大页面上一次大改动的点击也走这条路。局限：没有标题的页面基本没有导览；折叠区里的可操作元素要读才看得到。
- 选子代理机制而不是隐藏的内部运行，是为了能在子代理标签里看它读了哪些行；封装在 `readPage` 后面，将来可换。

## 7. 动作之后：所有返回页面内容的工具共用一套机制

适用：open、snapshot、click、type、press、dialog、move、scroll、drag、nav、upload、handoff（交还后）。都带可选 `intent`，只在走完整路径时起作用。

**基线**：每个（会话，页面）存「agent 最近一次看到的状态」（原始快照）；每次交出内容后更新（含 `NO CHANGES`）；**页面关闭时丢，操作权易手不丢**（用户手动造成的变化要出现在下一次 diff 里；元素身份不依赖编号）。**判定顺序**（`clean.ts`）：

1. 显式 `snapshot`：永远完整路径、不做 diff。
2. 没有基线，或地址变了：完整路径（地址变了写 `URL: 旧 → 新`）。
3. 否则元素级 diff（`elemdiff.ts`，块级对齐）：无变化 → `NO CHANGES (element tree and text only; scroll position and pixels are not compared)`（括号里的说明是为了不让 agent 把「元素树没变」读成「动作没生效」）；否则**永远给 diff**，不调模型、不起阅读 agent：渲染超过 6000 字符（`diffMaxChars`）只截断内联，末尾写 `… N more lines not shown (… elements in total); full diff: [attach_file] …`，全文（遮罩之后）存成会话附件 `diff-<页面>-d<N>.txt`。**换页只由地址变了判定，变化量大不算换页**（滚动加载一批、点「展开全部」都是大 diff，但不是新页面；顺序变了也不算，对调两块就是一消失一新增）。

**元素级 diff**（`diff-tree.ts` 建树、`elemdiff.ts` 对齐、`diff-render.ts` 渲染）：先把原始快照建成元素树（纯容器 + 条目，没有条目的空壳剪掉）。条目的身份 = 角色 + 名字（链接再加路径，忽略查询串与片段；有名图片只看 alt，无名图片以地址为身份；纯文字加内容），编号不算身份；纯容器的签名 = 角色 + 前两个后代条目的身份。同一层兄弟先去公共前后缀，中间段做最长公共子序列（格子超过 400 万就不做）；锚点之间的缺口两边个数相等时逐位置配对（要求角色相同），个数不等整段当「先删后加」，**不猜配对**——这是为了不再出现「新增行写着别的条目的编号」；缺口里有透明的 `generic` 包装层时先拆开再对齐（快照会把只剩一个孩子的 generic 折叠掉，菜单展开 / 收起时包装层时有时无，不拆就会把没变的按钮也报成消失 + 新增）。配上的一对再递归比子树。渲染一行一条、按层缩进：`+` 新增（整块新增先写块头行，子行缩进）、`~` 变化、`-` 消失（整块只写一行并带 `(N elements)`，不展开）、`@ <块头>` 标明是「同类兄弟里的某一个」（如多条回答里的一条）、`= N unchanged (首 … 尾)` 给块级增删标位置（叶子级小改动不写）；`generic` 且没有自己文字的包装层不写头、不缩进；编号只给新增与变化的控件，且是它自己的编号。其余写法：表单值与 `checked / pressed / expanded / selected / disabled` 单独比，写成 `~ e25 textbox "…": "" → "demo-user"`；名字变了写 `"旧" → "新"`；**目标变了也算变化**（链接只改了查询串 / 片段，图片换了地址即懒加载生效），写成 `~ e9 img "图 3" → /a/3.jpg (was data:image/gif (43 chars))`，同源地址写根相对；只有带 `/src` 的 img 进 diff；只过滤纯标点的文字（短文字「A」「B」照比）；相邻同文的叶子行合并成 `(×N more)`，仍带第一项的编号。实测（模拟的知乎式信息流）：5 条追加到 10 条 1387 字符、顶部插一条 345 字符、一条回答赞同数 +1 是 2 行 63 字符、一条回答展开 240 个元素 8786 字符（内联 5978 + 附件）。

**外壳**（`envelope.ts`，固定英文，页面文字保持原文）：

```
PAGE: <标题> | <地址>
ACTION: click e12                 （动作类才有）
URL: <旧> → <新>                   （地址变了才有）
<notes：PAGE ID / 下载 / UPLOADED / CLIPBOARD …>
SNAPSHOT: s3 · 554 lines          （只有完整路径有）
<内容：NO CHANGES / diff / overview / intent / 机械层全文 / 结构视图>
```

## 8. 没验证的

接线（辅助模型设置、aux 调用、内置阅读 agent、指针展开与回落）由 `scripts/verify-browser-content.mjs` 用假模型验过；下面是它验不到的：

- 辅助模型与阅读 agent 在真实任务上的提取质量（纸面判断不了；提示词在约 15 个案例、两个模型上验证过，行号在 1500 行以内可靠，更大的没测）。
- 辅助模型单次读取上限（60000）、内联上限（12000）、diff 内联上限（6000）、阅读 agent 的总时限（120 秒）都是初值。
- 没验证复杂重绘（虚拟列表、动画、带时间戳的文字）会不会把小改动误报成大改动——代价只是 diff 变长（截断加附件），不再多走完整路径。
- 缺口按位置配对：整页同数量换内容（「换一批」）会写成一堆 `~` 行而不是消失 + 新增，读起来够用，没专门优化。
- iframe / shadow DOM：Playwright 的 ai 模式会内联 iframe（编号带 `f1` 前缀），没逐个验证。
- 取回文件对主 agent 的可达性：附件区是虚拟主机 `attachment`，用 `host="attachment"` 加 `/…` 路径直接读，不用切换。
