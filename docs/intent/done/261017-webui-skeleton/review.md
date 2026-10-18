# Review: WebUI（一）前端工程骨架与会话列表
Date: 2026-10-18

> 评审者：Codex（只读，空上下文，一轮）。原文在 `tmp/codex/skeleton-review.md`（git 忽略，不入库）。
> 偏离协议两处：本文件由实现者转录，措辞可能比原文平；评审者环境没有 `node`/`pnpm`，没跑任何测试，下面的"确认"都是实现者对照 `fff50a0` 的源码读出来的，没有写复现用例。
> 范围：提交 `fff50a0`。skeleton 之前没有评审过，这是第一轮。第一轮评审时没有改代码；人定了处理方式后的修复见文末“处理记录”。

## 第一轮
Reviewer: Codex
Date: 2026-10-18

结论：无 P0；1 个 P1、4 个 P2。依赖固定版本、`pnpm-lock` 与 `package.json` 一致、R5 的"无自动重试"断言有效（伪时钟推进 60 秒仍只请求一次）、可访问性实现本身符合要求，这几项评审者未发现问题。

### 阻塞
1. **P1 R1：仓库测试确定失败。** `packages/server/src/release.test.ts:69-71` 断言 `packages/web/public/index.html` 存在，该文件在 `fff50a0` 被移到 `packages/web/index.html`。**[已确认，未修]** 读到测试原文与路径；工作区里这个用例至今失败（conversation 评审时跑 server 套件已见到，372 过 1 失败）。skeleton 的 Proof 没有要求跑 server 套件，所以提交时没被发现。

### 重要
2. **P2 R1：装包冒烟是假证明。** `scripts/lib/smoke-common.sh:50-57` 的 `check_placeholder_page` 只断言响应含 `元枢 YuanshuHarness`，新旧页面都有，恢复旧占位页也能通过。spec Proof 要求"响应含应用根节点而非占位页"。**[已确认，未修]** 读到函数原文；`git diff fff50a0` 显示 `scripts/` 自此没有改动，所以这条 Proof 一直没落地。没有运行装包冒烟。
3. **P2 R2：静态检查没覆盖构建产物，并有漏检。** `tokens.test.ts` 只读 `src` 顶层文件与源码 `index.html`，不读 `dist/**`；色值检查不含 `index.html`；第三方域名只匹配 `http(s)://`，`//cdn.x/y.js` 能过。**[已确认，未修]** 读到测试原文。spec R2 与 Proof 都写了"构建产物"。另见 conversation 评审的 R12 构建产物检查：Tailwind 自带的 `#0000`/`#fff` 会留在 CSS 里，R2 与 R12 是同一个措辞问题，**请人一起定**。
4. **P2 R3：读响应体时网络中断会卡在"连接中…"。** `fff50a0:api.ts` 的 `try/catch` 只包 `fetch()`，`res.json()` 拒绝时是未处理拒绝，界面不会显示"无法连接 Server"。**[代码已被后续改动修掉，测试仍缺]** 工作区 `api.ts` 的 `get` 已把解析放进 `try`（conversation 评审第 6 条），但那次只补了历史接口的用例，`gate.test.tsx` 没有"首次探测的响应体读取失败"一例，所以 R3 路径没有证明。
5. **P2 R4：泄漏断言太弱。** `gate.test.tsx` 只监听 `console.log`（`error`/`warn`/`info`/`debug` 漏掉）；只在成功路径检查 URL 与 `localStorage`；失败测试只看最终 `sessionStorage` 为 null，不能证明中途没写过。**[已确认，未修]** 评审者与实现者都按源码搜索过，实现本身没有泄漏，Bearer 头正确，缺的是测试。

### 次要（未处理，不逐条验证）
- R7：`shell.test.tsx` 没有卸载重挂载，证明不了"刷新不记忆选中"。
- R8：只断言可访问名称，交换 `bg-live`/`bg-ok` 或删掉 `dot-run` 不会变红。
- R9：只检查 `@media` 块存在，清空块内声明也能过。
- 令牌错误提示的 `role="alert"` 没有断言。
- R6 的品牌、tab、连接状态点只靠静态代码。

## 待人确认
- R2 的措辞：字面"构建产物不得写死十六进制色值"与 Tailwind 内置值冲突，同 conversation R12，两处一起改还是保持现状。
- 第 1、2 条属于 skeleton 当时就该过的 Proof，补在 skeleton 里还是并入 conversation 的提交，影响提交怎么切。
- skeleton 的 spec 仍是 `Status: draft`，上面几条处理完才适合定稿。

## 验证记录
Date: 2026-10-18

评审者没能运行任何命令。实现者只读了源码，没有重跑测试，也没有做"修前变红"。

## 处理记录
Date: 2026-10-18

人已确认：R2 与 conversation R12 一起改措辞；补在 skeleton 的范围内（提交怎么切仍待定，尚未提交）。

- **第 1 条 [已修]** `release.test.ts` 改查 `packages/web/index.html`；`packages/server` 373 个用例全过。
- **第 2 条 [已修]** `check_placeholder_page` 改为 `check_web_page`：要求有 `id="root"`、不含旧占位文案、页面引用的第一个脚本能取到（200）。`smoke-package.sh` 实跑通过。没有做“还原成旧占位页必须失败”的变异，`smoke-image.sh` 同样没跑（需要镜像）。
- **第 3 条 [已修]** `tokens.test.ts` 改为实际构建（强制生产模式）后检查 `dist`，并检查 `index.html`；第三方域名的正则覆盖 `//host`。写入色值、引用 `//cdn` 域名两种变异均变红。构建出的 CSS 有三类例外，已写进 R2：调色板变量声明、Tailwind 的 `#0000`/`#fff`、`color:rgb(from red r g b)` 特性探测；CSS 头部许可注释里的网址排除。
- **第 4 条 [已修]** 已在 conversation 的改动里修好 `api.ts`（见 conversation review 第 6 条）。
- **第 5 条 [已修]** `console` 的各级方法都被监听，失败路径也断言。两种变异（失败路径把令牌打到 `console.error`、成功路径写进 `localStorage`）均变红。
- 次要项仍未处理。
- 验证：`packages/web` 106 个用例全过，`tsc --noEmit` 退出码 0，`packages/server` 373 个全过。
- 未重新评审：这些修复没有再经独立评审。
