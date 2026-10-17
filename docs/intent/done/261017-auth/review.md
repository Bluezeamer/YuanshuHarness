# Review: 访问认证（令牌、来源网段、限流）
Date: 2026-10-17

## 第一轮（认证绕过面）
Reviewer: subagent (general-purpose)
Date: 2026-10-17

### 阻塞
无。

### 重要
无。

### 建议
1. **未注册的 `/api/v1/*` 路径无令牌也返回 404（不是 401）**。依据：`GET /api/v1/nope` → 404，`GET /api/v1/sessions` → 401。原因是 hook 只挂在 `server.ts:187-190` 的封装作用域内，未匹配路由落到根作用域的 404 处理器。符合 spec R4 的"已注册路由"，但未认证者可以枚举哪些路径存在。数据面没有暴露。若要收紧，可在作用域内设 `setNotFoundHandler`，或把 hook 提到前缀级别。
2. **README 的 docker 示例与冒烟脚本注释不一致**。`README.md` 的 `-e YUANSHU_TOKEN="$YUANSHU_TOKEN"` 经 shell 展开后，令牌会出现在 `docker run` 的 argv 里。`scripts/smoke-image.sh:76` 的注释却写"不出现在命令行"。改成 `-e YUANSHU_TOKEN`（只转发变量名）即可。该脚本的校验（`smoke-image.sh:95`）两种写法都接受。**[已修正]**
3. **没有失败认证的日志**。401、403、429 都不留痕，运维看不到爆破。令牌不会泄漏，所以这只是可观测性问题，可后续再做，待确认是否在本期范围。

### 各维度检查结果
- **路由覆盖**：实测以下请求都返回 401，WebSocket 升级也在其中：GET/POST/DELETE `/api/v1/sessions...`、`GET /api/v1/sessions/`、`GET /api/v1/%73essions`（编码路径）、`HEAD /api/v1/sessions`（Fastify 自动生成的 HEAD 路由也在作用域内）、无令牌或错令牌的 stream 升级，响应都是普通 HTTP 401，没有建立 WebSocket。
- **路径变体**：大小写变体 `/API/V1/sessions` → 404；路由大小写敏感，没有对应路由。`;a=b` → 404；`OPTIONS` → 404，没有 CORS，也没有数据。`//api/v1/sessions` → 403，来自静态资源的 `allowedPath`，没有进入 API。没有任何变体能到达 sessions 处理函数而不经过 hook。
- **检查顺序**：`auth.ts:179-203` 依次是网段（403）、限流（429）、令牌（401），每步 `return reply...`。网段外的请求不调用 `limiter.fail`。未配令牌时在网段之后直接返回，符合 R7。
- **来源判定**：只用 `req.socket.remoteAddress`（`auth.ts:180`），代码里没有读取 `x-forwarded-for` 或 `req.ip`。`auth.ts:36-42` 去掉 `%zone` 后交给 `net.BlockList.check`。该调用对 `::ffff:a.b.c.d` 与 IPv4 规则双向匹配，有单测。`remoteAddress` 为空时返回 false，在配了网段时会被 403。
- **子协议回显**：`server.ts:138` 的 `handleProtocols` 只返回 `yuanshu.v1` 或 `false`，不会回显 `bearer.*`。这一点依赖 `api/auth.test.ts:180-192` 的原始读取用例。
- **泄漏**：401、403、429 的响应体都是固定 JSON。Fastify 默认请求日志只含 method、url、host、remoteAddress，不含请求头。启动日志只有网段条数（`server.ts:196-202`）。`config.ts` 对令牌用 `secret` 分支，错误信息不回显值。`/healthz` 只返回 status 和 version。令牌走 Header 和子协议，不走 query，所以不会进 URL 日志。
- **常量时间**：`tokenMatches` 先对两侧做 SHA-256，再 `timingSafeEqual`（`auth.ts:76-80`）。整个 `src/` 里没有对令牌用 `===` 的路径，令牌只在 `auth.ts` 的 `tokenMatches` 和 `config.ts` 的 `TOKEN_PATTERN.test` 里被使用。
- **启动检查**：`server.ts:160` 的非回环无令牌检查位于 `start()` 开头，早于 `assertWebRoot`、`prepareDataDir`、`openDatabase`。`isLoopbackHost` 与 spec R2 一致：`::ffff:127.0.0.1`、`0.0.0.0`、`::` 都按非回环，`LOCALHOST` 大写也按非回环，偏保守。`server.test.ts:346` 已覆盖。

---

## 第二轮（限流状态与启动检查）
Reviewer: subagent (general-purpose)
Date: 2026-10-17

### 阻塞
无。

### 重要
1. **部分测试覆盖偏弱**（实现本身看起来正确）：
   - `src/api/auth.test.ts:213-221`：声称"网段外请求不推进失败计数"，实际只发了 15 次 403，没有再用网段内来源验证计数仍为零。注入的 `clock` 也没被用到。**[已补强为单元测试，并做变异验证]**
   - `src/auth.test.ts:136-148`：容量用例只断言 `size===3`，没断言被丢的是最早插入的那一项。"仍满则丢最早项"这一支即使改成丢最新项也不会红。被封禁项被挤出的情况也没测。**[已拆成三个用例，并做变异验证]**
   - R12 "`stop()` 后无残留句柄"没有任何测试。我读了 `auth.ts`，没有 `setTimeout` 或 `setInterval`，所以实现上成立，但 Proof 表要求有测试。**[已补]**
   - R3 的"日志不含令牌"只在启动日志里断言了一次（`server.test.ts:355`）。认证失败路径、请求日志里没有断言。我读到的 Fastify 默认 req 序列化器不含 headers，所以实际不泄漏。
2. `src/config.test.ts:113`、`120`：用例名"未实现的 --token / YUANSHU_TOKEN"是旧残留。它们现在靠 `"x"` 短于 32 才失败，名字有误导，也和后面的合法令牌用例重复。属于待确认的无用用例。**[已改名为"过短的"]**

### 建议
- `server.ts:196`："认证已启用"日志在 `listen` 之前写出，端口被占用时会先出现一条认证已启用，之后才启动失败。
- `auth.ts:13`：`parseCidr` 接受前导零前缀（如 `10.0.0.0/008`）和带 zone 的地址（如 `fe80::1%eth0/64`）。不影响安全，Node 的 `BlockList` 能正常处理。
- `auth.ts:186`：`remoteAddress` 为空时所有来源共用 `"unknown"` 一个限流键。实际几乎不会发生，但一个无地址的来源可以把所有无地址来源一起封掉。

### 各维度检查结论
- **计数**：读 `auth.ts:114-159` 并核对测试。10 次封 60 秒、成功清零、封禁期内走 429 分支不计数不延长、到期后从零计，都正确。Retry-After 用 `Math.ceil`，测试只测了整秒（60、30），没有小数秒用例，属于弱项但逻辑没问题。
- **只记 401**：403 在限流之前返回，顺序符合 R5。封禁期内带正确令牌也是 429，已有 HTTP 级测试。
- **边界**：`stale` 用 `>`（恰好 10 分钟不算过期，符合"超过"），封禁用 `<=`（到点即解封），`blockedFor` 与 `live` 一致，没有差一。恰好等于阈值的时刻没有测试。**[已补]**
- **容量与句柄**：满时先清过期项再丢 Map 首项，逻辑正确。无定时器。**[已补句柄测试]**
- **假时钟**：`createAuthHook` 是唯一一份代码，注入只能通过 `ServerOptions.authLimiter`，`cli.ts` 不传，生产配置触发不到。
- **`config.ts`**：空串、不足 32 字符、非法字符、空项、缺前缀、前缀越界、带符号都有测试。命令行与环境变量两边都校验（`resolve` 遍历所有来源），错误信息对令牌不回显。我另外检查了 `多余的参数` 和 `未知子命令` 这两条回显位置，只会回显位置参数，不会带出 `--token` 的值。Node `net.isIP` 拒绝 `010.0.0.1`。
- **Config 序列化**：grep 全部非测试源码，没有 `JSON.stringify(config)`，也没有打印 config 的地方；`cli.ts` 只写错误信息。
- **`smoke-image.sh` 与 README**：一致。无令牌启动失败的检查、README 命令里 `-e YUANSHU_TOKEN` 的格式检查、`/healthz` 免认证、`/api/v1` 无令牌 401 / 有令牌 200 都对应得上。脚本没覆盖镜像内的 429 和 403，这不是 R14 的要求。`smoke-image.sh:139` 的 idle 容器用 `--entrypoint node` 绕过了服务，不受令牌要求影响。

Proof 表里只有 R9 和 R14 的覆盖符合要求。R11 缺小数秒的 Retry-After 用例，R12 缺 `stop()` 后无句柄的用例并且容量只断言了 `size`，R5 和 R7 的"不计数"实际没被观测到，R3 的日志断言只覆盖启动日志。**[部分已补强]**

---

## 变异验证记录
Date: 2026-10-17

### auth.ts:155 — 丢最新项而非最早项
将 `this.table.keys().next().value` 改为 `[...this.table.keys()].pop()`，`src/auth.test.ts` 的"仍满则丢最早插入的一项"用例变红。

### auth.ts:183 — 网段外也记入失败
在 403 返回之前加 `limiter.fail(source ?? "unknown")`，`src/auth.test.ts` 的"网段外的请求得 403，且不计入失败，也不触发 429"用例变红。

### 汇总
补强后的测试能捕获上述两个变异。全量测试 334 项通过，`scripts/check.sh` 全部检查通过，含镜像冒烟和 aisdlc 校验。
