# Review: 最小命令行客户端
Date: 2026-10-17

## 第一轮（静默类风险：序号、EOF 退出条件、令牌泄漏、服务端关闭码）
Reviewer: subagent (general-purpose)
Date: 2026-10-17

### 阻塞
1. **resync 期间丢帧后 `owed` 未校正，EOF 后可能永远不退出**（`attach.ts` 的 `observe`）。已 ack 的 `send_message` 对应的 `run.started` 若在等快照期间被丢弃，`owed` 不再减，`maybeFinish` 的 `owed === 0` 永不成立。**[已修正]** 快照时把 `owed` 重置为 `commands` 里仍未 ack 的 `send_message` 条数；已补用例"缺口期间整轮运行已结束：新快照显示空闲，EOF 仍能退出"（丢前两帧并让 `resync` 延迟到达），修正前该用例超时挂死，修正后通过。
2. 与 1 同根：缺口前后的 `run.ended` 被丢，`owed` 无法归零。**[随 1 修正]**
3. 评审者提出 `server.ts` 的 `preClose` 里 `this.websocketServer` 可能不可用。**[不成立]** R8 用例断言收到 1001 与 `server_shutdown`，去掉该钩子时得到 1005 而变红，说明钩子生效且 `websocketServer` 可见；`?.` 兜底了未装饰的情形。

### 重要
4. fetch 异常可能带出令牌。**[不成立]** `http.ts` 只取 `cause.code`；非法地址在 `options.ts` 阶段即以 2 退出，不进 fetch。令牌只出现在请求头与子协议里。
5. 快照 `partial` 与实时 `delta` 可能重复或漏字。**[不成立]** `partial` 只含已累计的文本，`delta` 只追加 `kind: "text"`；"中途接入先出 partial 再续上，文本不重不漏"用例覆盖。
6. `queue.updated` 里队列为空时不减 `owed`。**[不成立]** 消息入队后立即被取走的情形由 `run.started` 减 `owed`；`run.ended` 归零。

### 各维度检查结论
- **R7**：快照重置期望序号，缺口与回退后置"等待快照"，期间丢帧且不重复发 `resync`；首帧非快照报错。
- **R8**：`closing` 标志过滤自己调用 `close()` 触发的关闭事件。
- **R2**：令牌只在 `Authorization` 头与 WebSocket 子协议里出现，错误信息不回显。

---

## 变异验证记录
Date: 2026-10-17

### stream.ts — 去掉缺口检测
缺口、重复、乱序三个 R7 用例变红。

### stream.ts — 等快照期间不丢实时帧
"等新快照期间实时帧继续到达：不重复发 resync"变红。原有用例抓不到它，所以补了让 `resync` 延迟到达 Server 的用例。

### server.ts — 去掉 `preClose` 钩子
R8 的 1001 用例得到 1005，变红。

### attach.ts — 快照后不校正 `owed`
"缺口期间整轮运行已结束"用例超时，变红。
