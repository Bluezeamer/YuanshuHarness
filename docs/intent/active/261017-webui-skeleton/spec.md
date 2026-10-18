# Spec: WebUI（一）前端工程骨架与会话列表
Author: bluezeamer
Status: draft
Date: 2026-10-17

> 写成 delta：只写本次变更相对既有约定新增或改变了什么。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0013](../../../genesis/adr/0013-tech-stack.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)
下游: 定稿后回填

## Requirements
R1. `pnpm --filter yuanshu-harness-web build` 产出 `dist/index.html` 与其引用的脚本、样式；`scripts/pack.sh` 与装包冒烟照旧通过，Server 托管后 `GET /` 返回的是新界面而不是占位页。
R2. 源码中，除风格变量的定义文件外，不得出现写死的十六进制色值；构建产物中的色值只能是风格变量的声明，加上 Tailwind 自带的 `#0000`、`#fff`（框架内置，无法去除），以及 Tailwind 的相对色特性探测 `color:rgb(from red r g b)`；源码与构建产物都不得引用任何第三方域名的资源（含不带协议的 `//host`；CSS 文件头的许可注释不算）。
R3. 启动时先请求 `GET /api/v1/sessions`：200 则进入外壳；401 则显示令牌输入界面；网络失败显示"无法连接 Server"并提供重试，不得进入外壳。
R4. 令牌输入后以 `Authorization: Bearer` 重试；成功才保存到 `sessionStorage` 并进入外壳；失败（401）保留在令牌界面并提示，不保存。令牌不得出现在 URL、`localStorage`、`console` 输出。
R5. 429 `too_many_attempts` 时显示"尝试过多"，并按 `Retry-After` 提示等待秒数，期间不自动重试。403 `forbidden_source` 显示"当前来源不被允许"。
R6. 外壳含顶栏（品牌、"对话"tab、连接状态点）与左栏会话列表；列表按 Server 返回顺序（`updatedAt` 倒序）渲染，每项显示名称与状态点；空列表显示"还没有会话"。
R7. 点击列表项选中该会话（`aria-current`），主区显示"选择会话"占位被替换为会话名称；刷新页面不记忆选中。
R8. 会话运行中的状态点用蓝色闪烁，其余为绿色；状态不只靠颜色，状态点带可访问名称。
R9. `prefers-reduced-motion: reduce` 下，所有 CSS 动画与过渡时长压到近 0。

## Proof
| 需求 | 证明 | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | `scripts/smoke-package.sh`（增加：`GET /` 响应含应用根节点而非"占位页"）；`pnpm build` | 是（旧页是占位文案） |
| R2 | `src/tokens.test.ts`：静态检查 `src/**` 与 `index.html`，并实际构建后检查 `dist` | 变异：在组件或 `index.html` 里写入色值、引用 `//cdn` 域名，必须变红 |
| R3 | `src/gate.test.tsx`：三种响应各一例 | 是 |
| R4 | `src/gate.test.tsx`：成功保存、失败不保存；断言 `localStorage` 与 `console` 未被写入令牌 | 变异：改存 `localStorage`，必须变红 |
| R5 | `src/gate.test.tsx`：429、403 各一例，断言无自动重试 | 是 |
| R6 | `src/shell.test.tsx`：渲染顺序与空态 | 是 |
| R7 | `src/shell.test.tsx` | 是 |
| R8 | `src/shell.test.tsx`：状态点可访问名称 | 是 |
| R9 | `src/tokens.test.ts`：样式表含 reduced-motion 块 | 变异：删掉该块，必须变红 |

## Design
- 目录：`src/main.tsx` 入口；`src/api.ts`（fetch 封装，统一把 401/403/429/网络失败映射成区分类型的结果）；`src/Gate.tsx`；`src/Shell.tsx`；`src/styles.css`（唯一定义风格变量的文件，Tailwind 主题映射到变量）。
- 状态：令牌存在 `src/api.ts` 模块内，初始化时从 `sessionStorage` 读取；组件不直接碰存储。
- `GET /api/v1/sessions` 返回 `{ sessions: [{ id, name: string | null, createdAt, updatedAt, running }] }`（`packages/server/src/session/pool.ts` 的 `SessionInfo`）。`name` 为 null 时界面显示"未命名会话"。
- 依赖（全部固定版本）：运行时 `react`、`react-dom`；开发 `vite`、`@vitejs/plugin-react`、`tailwindcss`、`@tailwindcss/vite`、`@types/react`、`@types/react-dom`、`jsdom`、`@testing-library/react`。

## Risks
- 实时的 Server 版本字段可能与 ADR-0024 的描述有出入，实现第一步先读真实响应。
- vitest 5 与 vite 8 的兼容性未验证，装不上就在 plan 的 Deviations 记录并降一档。
