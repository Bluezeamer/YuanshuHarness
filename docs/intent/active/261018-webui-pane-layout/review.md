# Review: WebUI 多 pane 布局

Reviewer: "自查记录"一节是实现者自查，不是独立评审。独立评审见"第 N 轮"，由 codex（空上下文，只读沙箱）执行，原文在 `tmp/codex/review1.md`。

> 评审记录写在这里，不写进 spec。

## 自查记录（2026-10-18）

web 171 个用例通过，`tsc` 退出码 0；server 396 个用例上次通过，本轮未重跑。文件名与上表计划名不同，实际在 `layout/` 下的 `layout.test.tsx`、`workbench.test.tsx`、`tree.test.ts`、`drag.test.tsx`、`nav.test.tsx`、`responsive.test.tsx`、`saved.test.tsx` 与 `sessions/mirror.test.tsx`。

已有用例：R1、R2、R3、R5（四边落点、window 标签、`Esc`、4px 阈值）、R6（`Alt+方向键`、向下分割、移动到其他 window）、R8、R9（未知类型、高版本、低版本迁移、迁移抛错、保存原样写回）、R10（含焦点非 chat、无 chat pane）、R11、R12、R13、R14、R16、R17（含 5xx 与网络失败提示）、R18、R20、R21、R22（存、套用换新 id、删除、取消命名）、R23 的 `tablist`/`separator` 属性与步长、R24。

本轮做过变异检验并确认变红：R5 去掉 `Esc`、R14 忽略已存偏好、R10 去掉 window 内回退、R17 失败不提示、R22 套用不生效。变异后均已还原。

补充（修复一批评审指出的问题后）：
- 代码：保存串行（同一 revision 不并发 PUT）、`pagehide` 用 `keepalive` 发送、`keepLocal` 遇到高版本文档转只读、已存布局版本过新时不可套用、拖动时 `setPointerCapture`、迁移后的 `configVersion` 随配置写回。
- 新增 3 个用例：R21 并发串行、R20 冲突里对方是高版本、R9 迁移后版本写回。前两个做了变异检验并确认变红（去掉串行等待、去掉版本守卫），已还原。R9 那条只覆盖 `setPaneConfig` 与 `resolve`，没有端到端经过 `PaneLayer`，也没做变异检验。
- web 174 个用例通过，`tsc` 退出码 0。

仍未证明：
- R3、R4、R5 的真实浏览器部分（节点是否被换、iframe 是否重载、遮罩下是否丢事件）与 R14 阈值（960 / 1280）调整，见 `browser-verify.md`。
- 已知限制（2026-10-18 决定暂不做）：pane 的 DOM 顺序按创建先后，不随位置变化，分割或拖动后 Tab 与读屏顺序可能和视觉顺序不一致；`Alt+方向键` 不受影响。按位置重排 DOM 会让 iframe 类 pane 重载，与 R3 冲突；若以后要做，优先考虑 `aria-owns`。
- R19 迁移前备份、失败回滚（`db.test.ts` 未逐条核对）。
- R24 数值待实测。

## 第 1 轮（codex，只读）
结论：2 项阻塞、6 项重要、1 项建议。codex 的 server 全量测试因沙箱禁止监听端口报 `listen EPERM`，该结果不能说明集成行为；我在本机另跑，server 396 个用例通过。

| 级别 | 问题 | 处理 |
|---|---|---|
| 阻塞 | 保存不串行，同一 `baseRevision` 并发 PUT，可能与自己 409 或静默未保存（R17/R21） | 已修；用例"同一 revision 不会并发提交"，去掉串行等待后变红 |
| 阻塞 | 409 带回高版本文档仍可"以本地覆盖"，绕过只读（R20/R21） | 已修；用例"冲突返回的是更高版本文档"，去掉版本守卫后变红 |
| 重要 | `pagehide` 的 PUT 没有 `keepalive`（R17） | 已修（`api.ts`）；测试只能证明带了 `keepalive`，不能证明浏览器真的发出，需真实浏览器 |
| 重要 | 迁移后 `configVersion` 不写回，下次渲染重复迁移（R9） | 已修；用例只覆盖 `setPaneConfig` 与 `resolve`，没有端到端经过 `PaneLayer`，未做变异检验 |
| 重要 | 已存布局忽略 `version`，高版本仍可套用（R20/R22） | 已修（`SavedLayouts.tsx`）；本轮没有专门用例，未做变异检验 |
| 重要 | 拖动标题栏未 `setPointerCapture`，指针快速进入 iframe 会丢事件（R4/R5） | 已加 `setPointerCapture?.`；jsdom 无法验证效果，需真实浏览器 |
| 重要 | 焦点不是 chat 时取树里第一个 chat，不是"最近"（R10） | 已修；"最近"我解释为最近聚焦过的 chat，不是空间上最近，这是我的解释，spec 没有写明；用例去掉回退后变红 |
| 重要 | 已存布局 DELETE 不带 revision，过期列表也能删（R18） | 不改代码；2026-10-18 决定在 spec R18 写明 DELETE 不校验 revision |
| 建议 | chat 标题栏不显示会话名（R7） | 已修；region 名字为"对话 · 会话名"，未命名显示"未命名会话"；用例去掉后变红 |

DELETE 的取舍：R18 原文 `PUT/DELETE` "同样用 `revision`" 可按字面读成 DELETE 也带 revision。2026-10-18 决定采用不校验方案，spec R18 已改写；理由是误删的代价只是重新保存一次布局，不值得改请求形状。

验证：web 176 个用例、server 396 个用例通过，两包 `tsc` 通过；`aisdlc_index.py --check` 通过。
