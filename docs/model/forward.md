# 服务转发

Author: bluezeamer
Status: 现行（端口模式；子域名模式未实现，见 §5）
Date: 2026-11-14
Verified: 2026-11-19（对着代码核对：`packages/server/src/forward/`、`api/forwards.ts`、`store/baseline.ts`、`browser/reach.ts`、`config.ts`、`cli.ts`、`Dockerfile`；端到端脚本 `scripts/verify-forward.mjs`）

## 1. 要解决的事

agent 在环境（Server 本机、容器、ssh 远端）里起了一个服务，用户想在**自己电脑的浏览器**里直接用，像用本地应用一样（agent 按需求起服务给用户用，服务变成应用）。内置浏览器（`browser.md`）只在 Server 那侧渲染，延迟与保真都不如本地浏览器，也不能收藏。

不做「分享给 agent」「用户页本地渲染」：本主题只管转发，别的功能不挂在上面。

## 2. 为什么不是 VS Code 那样的 localhost

客户端是纯浏览器，开不了用户本机的监听。所以由 **Server 在自己所在的机器上开端口**，地址是 `<访问 Server 用的主机名>:<转发端口>`，前端用 `location.hostname` 拼，服务端只给出端口号。写死 `localhost` 绝对地址的应用会坏（OAuth 回跳到 localhost 一类），这是端口模式的已知限制。

## 3. 端口模式

- **一个转发 = 一个独立端口**（不用路径前缀：路径前缀与 Server 同源，页面脚本能直接带 Cookie 打 API，Origin 校验也拦不住）。端口段 `YUANSHU_FORWARD_PORTS`（默认 `24100-24199`，100 个；选在少见的位置，低于 k8s NodePort 与 Linux 临时端口段，免得侵占本机常用服务的端口）；懒监听，没人转发时不占端口。
- **HTTP 层反代，不是裸 TCP 管道**：只转 HTTP 与 WebSocket；转交上游前把 `Host` / `Origin` / `Referer` 改成上游自己的 `localhost:端口`（Vite 一类会检查 Host 与 WS 的 Origin），响应里指回上游 localhost 的 `Location` 改回转发出口，`Set-Cookie` 去掉 `Domain` 属性。
- **鉴权**：只校验 Server 的会话 Cookie（同主机各端口都会带），不看 `Authorization` 与 WebSocket 子协议（那是应用自己的凭据，当 Server 令牌判会把用 JWT 的应用拦掉）；在交给上游前**摘掉它**，免得令牌漏给 agent 写的服务；应用回的同名 `Set-Cookie` 丢掉（Cookie 不分端口，会顶掉用户的登录）。Server 没配令牌（只允许回环监听）时不校验。转发监听同样受 `allowCidrs` 限制。没带有效 Cookie 时出口回一个 401「需要登录」页，提示先在 Server 的页面里登录再刷新。
- **拨号**：经环境的 `openTcp`（本机直连，ssh 走 direct-tcpip；`proxy.ssh.test.ts` 用回环真 sshd 测过）。端口没服务、sshd 禁止转发会在页面上给人话原因。
- **谁能转发**：只能是用户动作，agent 没有这个入口；目标须是该工作区能到达的环境与端口（`workspaceReach().allowService`），Server 自己的端口与转发端口不能作为目标。
- **不依赖自动检测**（照 VS Code 的「端口」面板）：转发接口收地址栏同一种写法的目标（`3000` 落在工作区默认环境、`server:3000`、`box:8080`，由 `resolveTarget` 解析，不另写第二套规则），**不探测此刻有没有服务在监听**，允许先转发、服务后起（没服务时打开会看到「远端 localhost:端口 连不上」）。
- **界面**（浏览器标签的「页面」弹层里的「端口」一栏）：检测到在监听的端口与已转发的并成一份清单，同一端口一行，状态点区分转发中 / 未转发；每行「在本机浏览器打开」（没转发就先转发）、已转发的另有「复制转发地址」「停止转发」，点行本身是在内置浏览器里打开；底部「添加转发端口」输入框手动加（不自动开窗口），写错目标有行内提示。手动加的端口没被检测到，停止后这一行就消失。
- **持久**：转发记在库里（`forwards` 表，按工作区、环境、端口唯一），重启后拿回同一个转发端口，书签不失效；同一目标重复转发是幂等的。
- **与 Server 的 Origin 校验配套**（`auth.ts` 的 `originAllowed`）：转发出来的页面脚本带着 Cookie 去打 Server 的 API 会得到 403。

## 4. 部署场景

| 场景 | 端口模式 | 要用户做的 |
|---|---|---|
| Tailscale | 可用 | 无 |
| 局域网 | 可用 | 主机防火墙放行转发端口段 |
| 容器，本机或局域网访问 | 可用 | `docker run` 多加 `-p 24100-24199:24100-24199` |
| 公网加 Caddy | 不适合 | 见下 |
| 内网加 frp 穿透 | 不适合 | 见下 |

不适合的原因：反代只转了控制台一个端口，转发端口要另外放行；转发端口是明文 HTTP；会话 Cookie 没有 `Secure` 且不分端口，访问控制台用的 HTTPS 主机名下，浏览器会把令牌明文发到这些 HTTP 端口。所以**控制台是 https 访问时，前端拦下转发操作**并说明原因。

不支持（写进文档，不做）：SSH `-L` 隧道、只发布单个端口的容器、没转发额外端口的 frp。

## 5. 子域名模式（已定方向，未实现）

给公网部署：配一个转发域名（如 `fwd.example.com`），Caddy 一条通配规则把 `*.fwd.example.com` 转给 Server 的**同一个端口**，Server 按 `Host` 头分发，不需要额外端口，frp 也只转一个端口，TLS 由 Caddy 管。前提是通配 DNS 与通配证书（Caddy 要 DNS 挑战插件），属于用户自己的环境。

多出来的工作：会话 Cookie 是主机专属的，不会带到子域名，要用一次性票据换子域名 Cookie（code-server 同款）。Tailscale 的 MagicDNS 没有通配子域名，所以端口模式不能砍。

**接缝**（端口模式的代码就按它切）：`forward/handler.ts` 的 `createForwardHandler` 只认「请求 + 转发目标」，不关心请求从哪来；端口模式由 `forward/service.ts` 里每个转发一个监听把它接上，子域名模式只需在主端口上按 `Host` 查转发再调同一个 handler。链接由谁生成也是一处：端口模式前端拼，子域名模式由服务端给整条 URL。

## 6. 已知并接受

- 不同转发出来的应用在同一主机名下，Cookie 不分端口，互相能看到对方的 Cookie（同一用户的同机应用）；子域名模式没有这个问题。
- 转发出口没有失败限流（Server 自己的接口有）：令牌至少 32 位随机字符，猜不出来；不为此加机制。
- 转发出来的应用之间互相能发请求（A 的页面脚本能向 B 的出口发请求，读不到响应，除非 B 开了 CORS）：前后端分别转发的常见用法（5173 调 8000）靠它，不拦。
- 不做 iframe 内嵌（很多应用的 `X-Frame-Options` / CSP 会挡，且回到同站点）。
- Host 白名单（防 DNS 重绑定）不做：合法主机名无从预知。
