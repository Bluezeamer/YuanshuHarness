# 设备令牌与 Web Push：写代码时守着的规矩

本文的路径都相对 `packages/server/src/`。手机端（`/m/` 入口、PWA、service worker）的前端写法见 skill `ys-mobile`。

## 设备与手机入口（`devices/`、`api/devices.ts`）

设计见 `docs/model/mobile.md` §8；写代码时守着：

- **身份只经 `auth.ts` 的 `authOf(req)` 取**（`{kind:"global"}` 或 `{kind:"device", device}`）：钩子先比全局令牌、再查设备令牌，没配令牌的回环模式、没有记录的请求都回落成全局。管设备的路由（建配对码、列表、撤销）都要先过 `api/devices.ts` 里的 `globalOnly`；设备令牌只能删自己（`DELETE /devices/self`）。
- **不要求令牌的路由写 `config: { public: true }`**（目前只有 `/devices/pair`）：来源网段、Origin、限流封禁照查，只跳过令牌；失败计数由路由自己记，别再造一份限流。
- **撤销要「先回完再断」**：被掐断的 socket 里可能就有正在回这次响应的连接，`disconnectAfterReply` 在 `finish` 之后才调 `connections.disconnect`；新增会长期占着连接的接口，要在 `server.ts` 的 `onRequest` 钩子里被 `DeviceConnections.track` 登记到（已对整个 `/api/v1` 作用域生效）。
- 库里只存令牌的 SHA-256，明文只在创建那一次的返回值里；`last_used_at` 每设备每分钟最多写一次。
- `/m`、`/m/*` 的静态回退在 `server.ts`：有文件就发、没有一律回 `m/index.html`；点段与空段直接当深链接，越界仍由 `sendFile` 的 `allowedPath` 拦。

## 推送（`push/`、`api/push.ts`、`store/push.ts`）

设计见 `docs/model/mobile.md` §9；写代码时守着：

- **触发与策略全在 `push/notifier.ts` 的 `PushNotifier`**：订阅 `SessionFeed`（`blocked` 的转换、事后补 `resolved`）与池的 `attachTurnEnded`（`error` / `done`，`markEnded` 里先于「有没有人在看」判断调用）；上次状态、待发定时器、已发记录都是它的私有成员，别往 feed 与池里塞。延迟档在定时器到点时重新判「事件仍然成立」。
- **发送只经 `push/sender.ts` 的 `createSender`**：自己 `fetch` 发 `generateRequestDetails` 的结果（`webpush.sendNotification` 只认 https，测不了本地端点）；404 / 410 = `gone`，由 notifier 删订阅。**撤销设备删订阅靠外键级联**（`push_subscriptions.device_id ... ON DELETE CASCADE`，唯一实现，别在别处再删一遍）。VAPID 私钥用 `store/seal.ts` 封存，不轮换。
- 五条 `/push` 路由全部只认设备令牌（`deviceOnly`，全局令牌 403）；偏好（三类事件开关、策略、延迟秒数）在订阅行上，`PATCH` 只取认识的字段。
- **别手写请求头 `Content-Length`**：pi 的 SDK 给全局 `fetch` 装了 undici 8，手写的值会被拒（`fetch failed`，`cause` 是 `invalid content-length header`），而 vitest 里用的是 Node 自带的 fetch，单测测不出，只有真 Server 里才会暴露（所有推送都发不出去）。同一个分发器按环境变量走代理：起真 Server 验推送时，若环境里设了 `http_proxy` 一类变量，要给 Server 进程设 `NO_PROXY=127.0.0.1,localhost`，否则发往本地假推送端点会失败；`scripts/verify-mobile-push.mjs` 起 Server 时自己已设，自写脚本照做。
- 端到端用 `scripts/verify-mobile-push.mjs`（假推送服务 + 订阅私钥解密 + CDP 投给真 service worker）。
