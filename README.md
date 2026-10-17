# YuanshuHarness（元枢）

> 元枢 —— 万象之枢，昼夜不怠。

基于 [Pi SDK](https://github.com/earendil-works/pi)（不 fork）的常驻 Agent Server：托管 coding agent 与助理 agent，WebUI、命令行、IM 等客户端共享同一个会话池，随时接入与断开，不打断正在运行的任务。

## 当前状态

早期：只有可启动、可探测的空壳 Server（`yuanshu serve`、`GET /healthz`），没有业务功能。设计见 [docs/genesis/VISION.md](docs/genesis/VISION.md)、[docs/genesis/ARCHITECTURE.md](docs/genesis/ARCHITECTURE.md)，路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 运行

`yuanshu serve` 启动服务，参数可用命令行或环境变量给出，命令行优先：

| 含义 | 命令行 | 环境变量 | 默认值 |
|---|---|---|---|
| 监听地址 | `--host` | `YUANSHU_HOST` | `127.0.0.1` |
| 监听端口 | `--port` | `YUANSHU_PORT` | `7420` |
| 数据目录 | `--data-dir` | `YUANSHU_DATA_DIR` | `~/.yuanshu` |
| 访问令牌 | `--token` | `YUANSHU_TOKEN` | 无（仅回环监听时可不设） |
| 允许的来源网段 | `--allow-cidr`（逗号分隔） | `YUANSHU_ALLOW_CIDR` | 不限制 |

未知的参数、非法的端口、拼错的 `YUANSHU_*` 环境变量都会让启动失败，而不是被悄悄忽略。监听非回环地址必须同时给令牌，否则启动失败；令牌至少 32 个字符，只能含 `A-Za-z0-9._~-`，推荐用环境变量给出（命令行参数会出现在进程列表里）。配了令牌后，`/api/v1` 下的 REST 与 WebSocket 都要带 `Authorization: Bearer <令牌>`（WebSocket 也可在 `Sec-WebSocket-Protocol` 里给 `bearer.<令牌>`）；`/healthz` 与静态页不需要。配了网段时，来源不在网段内的请求得 403；同一来源令牌连续错 10 次，封 60 秒（429）。没有 TLS，令牌明文传输，请只在受信网络里使用；放在反向代理后时，网段与限流看到的是代理的地址。健康探测用 `GET /healthz`，返回 `{"status":"ok","version":"…"}`。

### Docker

镜像尚未发布，需要本地构建：`docker build -t yuanshu .`。镜像以 `node` 用户（uid 1000）运行，数据目录固定为 `/data`，监听 `0.0.0.0:7420`。

<!-- smoke:docker-run -->
```bash
docker run -d --name yuanshu -p 7420:7420 -e YUANSHU_TOKEN="$YUANSHU_TOKEN" -v yuanshu-data:/data yuanshu
```

- 容器监听 `0.0.0.0`，所以必须提供 `YUANSHU_TOKEN`（先在 shell 里设好，示例原样转发），否则容器启动失败。
- 用命名卷（如上）时，卷会继承镜像里 `/data` 的属主，开箱即用。
- 绑定挂载宿主机目录时，该目录必须对 uid 1000 可写，否则服务按上面的规则启动失败。
- 容器里要改端口，请设环境变量 `-e YUANSHU_PORT=…`，不要改命令行：镜像内置的健康检查读的是 `YUANSHU_PORT`。

### 升级说明

此前按“非回环只警告”部署的实例，升级后会因缺少令牌而启动失败，这是有意的：请在部署配置里加上 `YUANSHU_TOKEN`。回退到旧版本前要先去掉 `--token`、`--allow-cidr` 及对应环境变量，旧版本会把它们当作未知参数。

## 本地检查

需要 Node ≥ 22.19、Python ≥ 3.11、Docker（镜像冒烟用，没有跳过开关）和 pnpm ≥ 10（例如 `npm install -g pnpm`）。仓库里锁定了 pnpm 的精确版本，pnpm 在这里会自动切换到它，所以本机装哪个 ≥ 10 的版本都行。不用 corepack：Node 25 起不再自带，旧版 corepack 也装不了 pnpm 12。脚本是 bash，Windows 上用 Git Bash 或 WSL。

```bash
scripts/check.sh
```

它依次做：前置检查、冻结锁文件安装、类型检查、lint、测试、构建、装包冒烟（把打好的 npm 包装进干净目录并启动）、镜像冒烟（构建镜像并起容器验证）、aisdlc 校验。CI 跑的是同一份。

## 许可

[MIT](LICENSE)
