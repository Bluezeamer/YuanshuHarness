# 对话流渲染

Author: bluezeamer
Status: 现行
Date: 2026-11-04
Verified: 2026-11-19（对着代码核对：`features/markdown/{imageRef,mermaidRuntime,mermaidTheme,codeHighlight,CodeBlock,MermaidBlock,DiagramCanvas}`、`features/chat/tab/Markdown.tsx`、服务端 `prompt/baseline.ts`）

对话流里**模型输出**的渲染层：围栏代码块卡片化、mermaid、内嵌图片。用户消息不参与块渲染：代码围栏保持原样 `<pre>`，图片只显示 `[图片：说明]` 占位。代码在 `packages/web/src/features/markdown/`（共用模块）与 `features/chat/tab/Markdown.tsx`；预览页复用同一个 mermaid 组件。

## 1. 稳定性规则

起因是 mermaid 在流式输出时反复闪烁并阻塞主线程。根因：`react-markdown` 10 把 `components[tag]` 直接当 React 元素类型，组件函数在渲染里创建就每次换身份，整棵 code / mermaid 子树被卸载重建；`Markdown` 又没有 `memo`，每个 token 都重解析全部历史消息。

- `components`、`remarkPlugins` 必须在**模块级**；`Markdown` 用 `memo`。现在的映射是 `pre`、`img`、`a`（`Markdown.tsx`）。
- 用 `pre` 覆写识别围栏块，避免 `<pre><div>` 的非法嵌套。
- **流式期间围栏只显示源码**，不渲染 mermaid、不做高亮；消息定稿后渲染一次（`streaming` 经上下文传给 `CodeBlock`、`MermaidBlock`）。

## 2. 代码块卡片

语言标签、一键复制、行号、自动换行切换（默认换行，关掉后卡片内横向滚动）。行号由逐行 DOM 承载，**复制走源码字符串，不带行号**。语法高亮用 highlight.js（`lib/core`，按语言动态加载，结果缓存），颜色用 `--syntax-*` 令牌（`ui/tokens.css`）；不为「技术栈统一」换成 CodeMirror，只读小片段用不到编辑器能力，体积与实例开销不划算。

## 3. mermaid

- **主题**：只有 `theme: "base"` 可定制，`themeVariables` 必须是具体色值（khroma 不认 oklch / `color-mix` / `var`），所以从 `tokens.css` 读 oklch 令牌，运行时换算成 hex（`oklch.ts`、`mermaidTheme.ts`）。风格：`look: "neo"`、无渐变、无阴影、`strokeWidth: 1`、`radius: 8`；`layout: "elk"`，代价是首次加载约 450KB gzip 的懒加载 chunk。
- **渲染**：离屏容器（`visibility:hidden`、移出视口、宽取卡片宽度，量不到时 720）里 `mermaid.render(id, code, container)`，成功后交给 React 挂进卡片；每次唯一 id，缓存 `(themeHash, code)`，同代码并发去重；缓存命中的 id 若仍在页面里要重渲染，否则重复 id 会让箭头 marker 错乱。初始化前 `await document.fonts.ready`，避免按回退字体量宽。
- **错误**：`securityLevel: "strict"` + `suppressErrorRendering: true`；**不先 `parse`**（`render` 内部会解析）；渲染失败且没有旧图时才显示错误提示，有旧图就继续显示旧图。
- **卡片与大画布**（`MermaidBlock.tsx`、`DiagramCanvas.tsx`）：卡片内预览（限高 + 渐隐）、预览 / 源码切换、复制、展开。展开进独立 overlay，**把同一个 `<svg>` 节点搬过去**，不重渲染也不 clone；弹层里有滚轮锚点缩放、拖拽平移、「适应」「1:1」、查看源码与复制源码；关闭时搬回。不与文件预览联动：聊天里的图没有磁盘文件身份。

## 4. 内嵌图片

- **引用写法**：`![说明](file:<主机>:<绝对路径>)`，也接受 `file://<主机>/<路径>`；主机名与服务端 `session/address.ts` 一致：`local`（会话主目录所在的主机）、`server`（Server 本机）、`attachment`（附件区，路径以附件区根为 `/`），其余是连接名（也接受环境 id）。裸绝对路径报「缺少主机名」，裸相对路径按**会话的第一个目录**（主目录）解析（模型直接写 `![](chart.png)` 也能显示）。显式 `file:` 前缀唯一确定主机与路径，裸相对路径不跨目录猜测。解析在 `imageRef.ts`。
- 点击复用现有 `ImageViewer` 放大。服务端不需要新接口：复用 `/api/v1/environments/:envId/files/content`（带鉴权的 blob 读取）与会话的目录清单接口。
- **安全围栏**：这一阶段不做。读取接口本来就面向用户本人；路径解析限制为「主机 + 绝对路径」，**不做任意 URL 代理，外链图片不自动加载**。
- **模型侧说明**：告诉模型怎么写 `file:` 引用（含「引用非图片文件写成链接」「不要用 base64 与外链」）。这段说明由基线卡 `k-showing`「向用户展示文件与图片」承载（`prompt/baseline.ts`），默认 Agent 的提示词带着它。
- 预览页 markdown 的图片规则与对话里不同（相对地址相对于文件所在目录，外链不加载），见 [`files.md`](files.md) §1。

## 5. 未实现与未决

- 设想：同一个大画布组件给预览器复用（预览页的 mermaid 目前没有大画布）。
