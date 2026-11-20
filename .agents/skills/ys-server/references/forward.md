# 服务转发（`forward/`）：写代码时守着的规矩

设计与部署场景见 `docs/model/forward.md`。本文的路径都相对 `packages/server/src/`。

- **经环境通道转 HTTP / WebSocket 的共用件在 `lib/tunnel-http.ts`**（逐跳头、`TunnelAgent`），浏览器代理与转发都用它，别各写一套。
- 转发出口的闸门**只认会话 Cookie**（`forward/authorize.ts`），不看 `Authorization` 与 WebSocket 子协议：那是应用自己的凭据。交给上游前要摘掉会话 Cookie，应用设同名 Cookie 的响应要丢掉（Cookie 不分端口）。
- 转发只能由用户动作开启，agent 没有入口；目标判定走 `workspaceReach().allowService`（`browser/reach.ts`），Server 自己的端口与转发端口不能当目标。
- `service.open` 是串行的（并发打开同一目标会各占一个端口再撞唯一键）；`restore` 要等 Server 自己的端口确定后再调。
- 改了转发的接线（`server.ts` 里的 `allow` / `authorize` / `restore`）要跑 `scripts/verify-forward.mjs`：这些接线单测测不出，突变过的几处都被它抓到。
