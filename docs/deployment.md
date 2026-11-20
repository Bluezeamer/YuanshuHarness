# 部署与运行

[English](deployment.en.md) | 中文

这份文档讲怎么把元枢跑起来、怎么配访问控制、怎么在手机上用。项目简介见仓库根的 [README](../README.md)。

## 参数与访问控制

`yuanshu serve` 启动服务，参数可用命令行或环境变量给出，命令行优先：

| 含义 | 命令行 | 环境变量 | 默认值 |
|---|---|---|---|
| 监听地址 | `--host` | `YUANSHU_HOST` | `127.0.0.1` |
| 监听端口 | `--port` | `YUANSHU_PORT` | `7420` |
| 数据目录 | `--data-dir` | `YUANSHU_DATA_DIR` | `~/.yuanshu` |
| 访问令牌 | `--token` | `YUANSHU_TOKEN` | 无（仅回环监听时可不设） |
| 允许的来源网段 | `--allow-cidr`（逗号分隔） | `YUANSHU_ALLOW_CIDR` | 不限制 |
| 额外放行的页面来源 | `--trusted-origin`（逗号分隔，形如 `https://ys.example.com`） | `YUANSHU_TRUSTED_ORIGINS` | 无 |
| 服务转发的端口段 | `--forward-ports`（形如 `24100-24199`） | `YUANSHU_FORWARD_PORTS` | `24100-24199` |

启动校验与访问控制：

- 未知的参数、非法的端口、拼错的 `YUANSHU_*` 环境变量都会让启动失败，而不是被悄悄忽略。
- **监听非回环地址必须同时给令牌**，否则启动失败。令牌至少 32 个字符，只能含 `A-Za-z0-9._~-`，推荐用环境变量给出（命令行参数会出现在进程列表里）。
- 配了令牌后，`/api/v1` 下的 REST 与 WebSocket 都要带 `Authorization: Bearer <令牌>`（WebSocket 也可在 `Sec-WebSocket-Protocol` 里给 `bearer.<令牌>`）；`/healthz` 与静态页不需要。同一来源令牌连续错 10 次，封 60 秒（429）。
- 配了来源网段时，来源不在网段内的请求得 403。
- 浏览器发来的请求（含 WebSocket）若带 `Origin`，必须与请求的 `Host`（或反代给的 `X-Forwarded-Host`）同主机同端口，否则返回 403 `forbidden_origin`：会话 Cookie 不分端口，不查的话同主机别的端口上的页面能借它打进来。反代把 `Host` 改写成了内部地址又没带 `X-Forwarded-Host` 时（nginx 默认如此，Caddy 默认保留 `Host`），把对外地址填进「额外放行的页面来源」。
- 没有 TLS，令牌明文传输，请只在受信网络里使用；放在反向代理后时，网段与限流看到的是代理的地址。
- 健康探测用 `GET /healthz`，返回 `{"status":"ok","version":"…"}`。

## Docker

镜像尚未发布，需要在仓库根目录本地构建：`docker build -t yuanshu .`。镜像以 `node` 用户（uid 1000）运行，数据目录固定为 `/data`，监听 `0.0.0.0:7420`。

```bash
docker run -d --name yuanshu -p 7420:7420 -e YUANSHU_TOKEN -v yuanshu-data:/data yuanshu
```

- 容器监听 `0.0.0.0`，所以必须提供 `YUANSHU_TOKEN`（先在 shell 里导出该变量，`-e YUANSHU_TOKEN` 只转发变量名，令牌不进入命令行），否则容器启动失败。
- 用命名卷（如上）时，卷会继承镜像里 `/data` 的属主，开箱即用。
- 绑定挂载宿主机目录时，该目录必须对 uid 1000 可写，否则服务按上面的规则启动失败。
- 容器里要改端口，请设环境变量 `-e YUANSHU_PORT=…`，不要改命令行：镜像内置的健康检查读的是 `YUANSHU_PORT`。

镜像里已带 agent 用的浏览器（Chromium、运行库、中文字体与彩色 emoji 字体），不用另装（不用 Docker、直接在主机上跑时，页面里的 emoji 要主机装有彩色 emoji 字体，如 `fonts-noto-color-emoji`；没有 root 权限就把 `NotoColorEmoji.ttf` 放进数据目录的 `browser/home/.local/share/fonts/`；缺字体时浏览器标签顶部有提示）。要让 Chromium 的沙箱生效，运行时再加 Playwright 的 seccomp 配置与 `--shm-size`（Docker 默认的 seccomp 禁用用户命名空间，沙箱起不来）；不加也能用，只是沙箱会降级，浏览器标签里有警告。浏览器被攻破时只波及容器，所以推荐单独容器跑；不要用 `--privileged`，不要挂 `docker.sock` 或数据目录以外的主机目录。详见 [model/browser.md](model/browser.md) §8。

```bash
docker run -d --name yuanshu -p 7420:7420 -e YUANSHU_TOKEN -v yuanshu-data:/data \
  --security-opt seccomp=config/docker/seccomp_profile.json --shm-size=1g yuanshu
```

要让用户在自己的浏览器里用环境里的服务（服务转发，见 [`model/forward.md`](model/forward.md)），容器再多发布一段端口：`-p 24100-24199:24100-24199`（端口段与 `YUANSHU_FORWARD_PORTS` 一致）；公网加反代、frp 穿透的部署暂不适用，细则见该文档。

seccomp 配置文件在仓库里、不在镜像里：上面命令里的路径相对仓库根，在别的机器上运行要把 `config/docker/seccomp_profile.json` 一并拷过去，并把 `--security-opt` 里的路径换成那里的绝对路径。目标机不方便构建时，在本地构建后用 `docker save yuanshu | gzip` 打包拷过去，对端 `gunzip -c <文件> | docker load` 即可，不要求它能联网；主机上的端口被别的服务占用时，改 `-p` 左边的主机端口（容器内端口不变），转发端口段则要同时改 `YUANSHU_FORWARD_PORTS`，让容器里监听的与发布出去的是同一段。

国内网络构建镜像时，用 `--build-arg` 换下载源：`DEBIAN_MIRROR`（镜像站根，如 `https://mirrors.tuna.tsinghua.edu.cn`）、`PLAYWRIGHT_DOWNLOAD_HOST`（Playwright 浏览器下载镜像）、`npm_config_registry`（npm 源）。

## 不用 Docker：装包 + systemd 用户服务

在一台 Linux 机器（含 LXD 容器）上以普通用户运行，在 Debian 13 + Node 24 上实测过。

1. 本地打包：`scripts/pack.sh <输出目录>`（先清掉再重建 web 与 server，产物是一个 tarball）。
2. 传到目标机，在一个干净目录里 `npm init -y && npm install <tarball>`（需要 Node ≥ 22.19；npm 11 会提示部分包的安装脚本未获批，实测原生模块都能加载、终端能跑，可忽略）。
3. 写一个权限 600 的环境文件，至少给出 `YUANSHU_HOST=0.0.0.0`、`YUANSHU_PORT`、`YUANSHU_DATA_DIR` 与 `YUANSHU_TOKEN`（令牌 ≥ 32 个字符，如 `head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'`）。
4. 用户级 systemd 服务（`~/.config/systemd/user/yuanshu.service`）：`EnvironmentFile` 指向上面的文件，`ExecStart` 写 node 与 `node_modules/.bin/yuanshu serve` 的**绝对路径**（node 装在 nvm 下时尤其要写死），`Restart=on-failure`；`systemctl --user enable --now yuanshu`。**要让它在退出登录后继续跑，需要 `loginctl enable-linger <用户>`**。
5. 要让别的机器访问，把 `7420` 与转发端口段 `24100-24199` 暴露出来（LXD 的代理设备、防火墙等）。

浏览器引擎第一次有人用时自动下载 Chromium 到数据目录的 `browser/`（直连 Playwright 下载源约 1 分钟，国内可设镜像，见 [browser.md](model/browser.md) §8）；系统运行库要机器上自备；普通用户下内核允许非特权用户命名空间时 Chromium 沙箱是开着的。

升级：重新打包、传过去、在原目录再 `npm install <tarball>`、`systemctl --user restart yuanshu`。项目处于早期，不做数据迁移：版本升级改了表结构时，要删数据目录里的库文件重建（供应商等配置要重配），**保留 `browser/`**，免得重新下载 Chromium。

## 手机访问（`/m/`）

手机浏览器打开 `http://<Server 地址>/m/`（桌面令牌门里也有「手机版」链接）。每台手机有自己的设备令牌：桌面「设置 → 手机设备 → 添加手机」会出一张二维码（5 分钟有效、只能用一次），手机扫码就登录，丢了在同一页撤销；也可以直接在 `/m/` 输入访问令牌，但那样没有后台通知。二维码里的地址默认取你当前打开桌面的地址，是 `localhost` 时要改成手机能打开的局域网地址。

**明文（局域网 IP、`http://`）也能用**：登录、会话列表、对话、审批与提问、拍照与相册附件、看产物、只读看浏览器画面，页面开着时都是实时的。**要 HTTPS 才有的三样**：后台通知（Web Push）、安装成独立应用（添加到主屏幕）、屏幕常亮。要开这三样，让手机用 HTTPS 访问：

- 有自己的域名：用 DNS 验证申请证书（局域网也行），放在反向代理（Caddy、nginx）前面；
- 用 [Tailscale](https://tailscale.com/) 的 HTTPS 证书；
- Caddy 自带的本地 CA（要把根证书装到手机里）。用 Caddy 时关掉 HTTP/3，并让它的 `/data` 卷持久化（证书与根 CA 都在里面）。

Server 本身不做证书管理，也不监听 TLS。反向代理的 `Host` 与 `Origin` 要保持一致（见上面的 `YUANSHU_TRUSTED_ORIGINS`）。

后台通知经浏览器厂商的推送服务投递（Chrome 走 Google 的 FCM）：手机没有 Google 服务、或 Server 连不上 FCM 时收不到，这是已知边界。通知只带事件类型与会话标题，不带命令与输出，点开进对应会话。设计细节见 [model/mobile.md](model/mobile.md)。
