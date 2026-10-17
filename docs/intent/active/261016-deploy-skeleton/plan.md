# Plan: 部署骨架
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> plan 是活的：实现中偏离计划，写进 Deviations，与对应代码同一次提交，无需重新审批。
> 只有偏离触及 spec 的 Requirements 时才回头改 spec。

## Links
来源: [spec.md](spec.md)
下游: PR（实现后回填）

## Files that change
| 文件 | 说明 |
|---|---|
| `packages/server/src/config.ts`、`config.test.ts` | 纯函数：把 argv、环境变量、主目录解析成 `help`、用法错误或 `serve` 配置（R1、R2） |
| `packages/server/src/data-dir.ts`、`data-dir.test.ts` | `prepareDataDir`：创建、0700、写入并删除探测文件（R4） |
| `packages/server/src/server.ts`、`server.test.ts` | `createServer(config, { webRoot?, logStream? })` 返回 `{ start, stop }`；`/healthz`、静态托管、非回环警告（R3、R5、R6、R7、R8） |
| `packages/server/src/cli.ts`、`cli.test.ts` | `execute(argv, { env, home, stdout, stderr, signal })` 返回退出码；无副作用，可在进程内测试（R1、R7） |
| `packages/server/src/bin.ts` | 带 shebang 的入口：接 SIGTERM/SIGINT 到 `signal`，调用 `execute`（R7） |
| `packages/server/src/release.test.ts` | 静态断言：`package.json`、`Dockerfile`、`.dockerignore`（R9、R10、R12、R14） |
| `packages/server/package.json`、`pnpm-lock.yaml` | 精确版本的 `fastify`、`@fastify/static`；`@types/node`；`bin`、`files`、`engines`（R9、R10） |
| `packages/web/public/index.html` | 占位页（R10） |
| `packages/web/package.json`；删除 `packages/web/tsconfig.build.json` | `build` 改为把 `public/` 复制到 `dist/`。web 没有可发射的 JS，原来的 `tsc` 发射成了孤儿，随本变更删除；占位模块与占位测试保留，仍参与类型检查和测试 |
| `scripts/pack.sh` | 清理旧产物，按 web、server 的顺序构建，复制 web 产物到 `packages/server/web/`，打出 tarball（R10、R11、R12） |
| `scripts/lib/smoke-common.sh` | 两个冒烟脚本共用：找空闲端口、轮询 HTTP、清理 |
| `scripts/smoke-package.sh` | 装包冒烟（R11） |
| `Dockerfile`、`.dockerignore`、`scripts/smoke-image.sh` | 镜像与镜像冒烟（R12、R13、R14） |
| `scripts/check.sh`、`tests/check/selfcheck.sh` | 前置检查加 docker；构建之后加两个冒烟步骤；自检覆盖新增部分（R15） |
| `.github/workflows/ci.yml` | 只调超时时间；仍只调用 `scripts/check.sh`（R16） |
| `.gitignore`、`README.md` | 忽略 `packages/server/web/`；补充 `yuanshu serve` 参数与镜像用法（R17） |

## Order of work
每一步完成即按语义分批提交。凡标"失败先行"的，先写测试并确认它在没有实现时红，再写实现。

0. **环境核实（需要我能执行 docker 命令）。** 本机是 LXD 容器，Docker 守护进程可用（29.9.1），但我这边的自动模式拦了 `docker pull` 和 `docker run`，需要先放行。核实三件事，结论写进下面的「实测记录」：
   - `node:24-slim` 的底层 Debian 代号、`node -v`、`node` 用户的 uid、镜像里有没有 curl 或 wget，据此定下 `node:24.x.y-<代号>-slim` 的具体标签（R12）。
   - 默认 bridge 网络加 `-p` 映射，与 `--network host`，各起一个最小容器，看宿主能否访问。**规则：** bridge 可用则 `smoke-image.sh` 一律走 bridge；不可用则一律走 host。只走一条路径，不加开关。host 模式下 R13 的「映射端口」就是直连，记入 Deviations。
   - pnpm 的 `minimumReleaseAge` 会不会拒绝刚发布的 Fastify。
1. **依赖。** 用 `pnpm add --save-exact` 加 `fastify`、`@fastify/static` 和 `@types/node`（取 22 主线）。取当前能安装的最新稳定版本，Fastify 不低于 5.12.2；实际版本记入「实测记录」。`.gitignore` 加 `packages/server/web/`。
2. **config（R1、R2），失败先行。** `parseArgs` 用 strict 模式。要覆盖的输入：优先级、默认值、相对路径转绝对、空串、`0`、`70000`、`80abc`、未知选项、多余位置参数、未知的 `YUANSHU_*`、裸命令、未知子命令、`--help`、`-h`、`serve --help`。变异验证：交换优先级、放过未知 `YUANSHU_*`，对应用例必须变红，随后还原。
3. **data-dir（R4），失败先行。** 要覆盖：新建 0700、已存在不改权限、路径是文件、目录 0555、父目录缺失、服务启停后目录为空。权限用例遇到 root 直接失败，不跳过。变异验证：不删探测文件，必须变红。
4. **server（R3、R5、R6、R7、R8），失败先行。** `start()` 的顺序固定为：检查 web 目录、准备数据目录、监听。这样前端缺失时不会先建出数据目录。要覆盖：
   - `/healthz` 的状态、`Content-Type`、响应体全等、`HEAD`，以及 web 目录里放同名文件也遮蔽不了；
   - 静态托管的首页、404、点文件、目录列表、`/../`、`/%2e%2e/`、`/%2e%2e%2f`、`/..%5c`。穿越用例用原始 `node:http` 发请求，因为 `fetch` 和 `inject` 会先规范化路径；
   - 非回环四种、回环四种的警告有无；
   - 端口被占、带空闲 keep-alive 连接时 `stop()` 在 5 秒内完成；
   - 同一进程内两个实例互不影响。

   静态托管的选项名（`dotfiles`、`list`、`wildcard`）按实际安装的 `@fastify/static` 文档核对后显式写出，不依赖默认值。变异验证按 spec Proof 的 R3、R5、R6、R8 逐条做。
5. **cli 与 bin（R1、R7）。** `execute` 的用法错误和启动失败都写 stderr、返回非零；`--help` 写 stdout、返回 0；`serve` 一直运行到 `signal` 被触发，然后返回 0。测试里触发 `signal`，验证 5 秒内返回。真实进程收到 SIGTERM 的行为留给步骤 7 和 8。
6. **包结构（R9、R10），失败先行。** 先在 `release.test.ts` 里写 `package.json` 的断言并确认红，再改 `packages/server/package.json`、web 的 `build`、写 `scripts/pack.sh`。
7. **`smoke-package.sh`（R11）。** 脚本里显式断言安装目录在仓库目录树之外。变异验证：让服务不响应、把安装目录移进仓库树并删掉一个运行时依赖声明（应当误绿，证明那条断言不可去掉）、把 `@fastify/static` 移到 `devDependencies`，各自观察结果。
8. **镜像（R12、R13、R14）。** 写 `Dockerfile`、`.dockerignore` 和 `smoke-image.sh`。几个设计点：
   - `HEALTHCHECK` 的间隔取 10 秒，因为第一次探测发生在启动后一个间隔之后，间隔 30 秒会让 R13 的「30 秒内 healthy」没有余量。
   - 「探测对未监听端口必须失败」这一步不去解析 `Healthcheck.Test`：另起一个容器，把入口改成一个什么都不监听的 node 进程，只把健康检查的时间参数调小，观察状态变成 `unhealthy`。这样检验的是镜像里真实的探测命令。
   - 「监听 0.0.0.0」这一步在容器内 `docker exec` 一个 node，用容器自己的非回环 IPv4 访问 `/healthz`。bridge 和 host 模式下都有效。
   - 「安装文件清单与 tarball 一致」要拿到 Docker 里打出的那个 tarball：`Dockerfile` 里单设 `pack` 阶段，脚本用 `docker build --target pack --output` 导出，再构建最终镜像（层缓存复用）。
   - 清理：容器、卷、镜像标签都用带随机后缀的名字，`trap EXIT` 里删除。

   变异验证按 spec Proof 的 R12、R13：去掉 `USER node`、`ENTRYPOINT` 改 shell 形式、`HEALTHCHECK` 恒成功、`/data` 属主改 root、换成浮动标签。
9. **`check.sh` 与自检（R15），失败先行。** 自检的临时工程增加两个冒烟脚本的桩，并加入「任一步失败整体必须失败」的用例；加「PATH 里没有 docker」「docker 命令在但 `docker info` 失败」两个用例。已有的「缺 python3 / pnpm / node」用例，受限 PATH 里都放入 docker，保证每个用例只缺一项。变异验证：删掉 docker 前置检查，自检必须变红。
10. **`ci.yml` 与 README（R16、R17）。** 作业超时从 15 分钟提到 20 分钟，因为要拉基础镜像并构建；其余不动。README 补三个参数与对应环境变量、命名卷的 `docker run` 示例、绑定挂载须对 uid 1000 可写、容器内改端口须用 `YUANSHU_PORT`，并把这条 `docker run` 原样放进镜像冒烟里跑。
11. **本地完整跑 `scripts/check.sh`**，记录关键输出到「实测记录」。
12. **变异验证汇总。** 把 spec Proof 里全部变异再跑一遍，逐条记下结果（红或绿），之后评审者独立再做一遍。
13. **评审。** 新开空上下文 subagent，写进 `review.md`；本变更命中「依赖外部系统的真实行为」，按 [hardening.md](../../../../.agents/skills/aisdlc/references/hardening.md) 多轮评审，修复后评审增量，直到无阻塞级问题；连续三轮仍有阻塞级问题则暂停并升档。
14. **PR。** 经你同意后推送分支并开 PR，观察 CI 通过。再开一个一次性草稿 PR，其中去掉 `USER node`，确认作业变红（R16 的变异验证），随后关闭并删除该分支（远程分支删除按项目配置会先问你）。
15. **合并与关闭。** 你评审并合并；之后另开小 PR 把 intent 关闭并整夹移入 `done/`，与上一轮相同。

## 实测记录
- `node:24-slim` 对应的具体标签与 Debian 代号（2026-10-17 实测）：`node:24.22.0-bookworm-slim`，Debian 12（bookworm），Node v24.22.0，`node` 用户 uid/gid 1000，镜像内没有 curl 与 wget。`24.22.0-bookworm-slim` 与 `24-slim` 的镜像 ID 相同（`sha256:a5f4366e…`）。
- 本机 bridge 与 host 网络的实测结果，以及据此选定的模式：LXD 容器里，默认 bridge 网络 `docker run` 失败，报 `open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied`（runc 无法给容器设置 sysctl）；`--network host` 正常。`docker build` 在默认网络下正常。**选定：`docker run` 一律加 `--network host`，不走端口映射；`docker build` 不加。**
- 锁定的依赖版本（2026-10-17，`pnpm add --save-exact`，pnpm 的供应链策略未拦）：`fastify` 5.12.7、`@fastify/static` 10.1.6、`@types/node` 22.20.5。与 pi 调研的版本一致。
- 完整检查（`scripts/check.sh`，本机 LXD，Node 24.13.1 加 pnpm 12.11.2 加 Docker 29.9.1，有构建缓存）：退出码 0，用时约 82 秒。前置检查、冻结锁文件安装、类型检查、lint、测试（server 118 条、web 1 条）、检查脚本自检、构建、装包冒烟（版本 0.0.0）、镜像冒烟（版本 0.0.0）、aisdlc 校验全部通过。镜像冒烟单独约 72–90 秒。冷缓存与 GitHub 托管 runner 上的耗时未知，待 PR 的首次 CI 验证。

## Rollback
- 这次变更没有任何持久化数据，也没有发布到外部：不发布 npm，不推镜像，不创建数据目录以外的状态。所以退回只需要 `git revert` 合并提交，没有迁移顺序，也没有双写窗口。
- 命令名、`/healthz`、端口 7420、环境变量名这些「难逆」的契约，在首次发布（ROADMAP 第 13 条）之前并没有外部使用方。合并之后到发布之前发现需要改，代价是一次修订 ADR 加一次代码变更，不涉及兼容。首次发布之后才真正难逆。
- 合并之后若镜像冒烟在 CI 上不稳定（最可能的原因是基础镜像拉取失败或限流），不要临时删掉那一步：spec 要求缺前提必须失败。应当先停下，另提变更处理（例如换镜像源），必要时升档。
- 实现过程中若发现要改 ADR-0017、0018、0019 的任何一条，停下并向你说明，按「中途升级」处理。

## Deviations
- 2026-10-17：步骤 0 实测后，本机 `docker run` 只能用 `--network host`。因此 spec R13 的「宿主机经映射端口访问」在本机与 CI 上都改为直连容器监听的端口；容器内监听 `0.0.0.0` 的检查仍用容器自己的非回环 IPv4。README 的 `docker run -p` 示例不进镜像冒烟的 host 模式路径，改为在冒烟里按等价参数核对。不触及 spec 的 Requirements 取值，只是验证手段的细节。
- 2026-10-17：`HEALTHCHECK` 间隔与 plan 一致取 10 秒。
- 2026-10-17（server 实现时）：spec Proof R3 要求在 `::`、`192.0.2.1` 上真实启动并看警告，这些地址在测试机上不一定能监听（192.0.2.1 不是本机地址，LXD 里 IPv6 也不一定开）。改为：回环判定的完整矩阵用纯函数 `isLoopbackHost` 逐项断言，真实监听只测 `0.0.0.0`（有 warn、仍启动）与 `127.0.0.1`（无 warn）。Requirements 不变。
- 2026-10-17（server 实现时）：`cli.ts` 的 `execute` 与 `parseConfig` 多接受一个 `cwd` 参数，用来把相对数据目录转成绝对路径而不读 `process.cwd()`，保持纯函数。spec Design 里写的是 `parseConfig(argv, env, home)`，签名多一个参数，行为不变。
- 2026-10-17（装包冒烟实现时）：① spec Risks 写「tarball 本阶段不含 `LICENSE`」不对：`pnpm pack` 会把仓库根的 `LICENSE`（MIT）带进 tarball，实测清单为 `dist/`、`web/index.html`、`LICENSE`、`package.json`。因此首次发布前不必再补 LICENSE；该处属 Risks 的事实更正，不改 Requirements。② spec Proof R11 称「把安装目录放进仓库树内并删掉一个运行时依赖声明，冒烟会误绿」，实测**没有复现**：`@fastify/static` 移到 `devDependencies` 后即使安装目录在仓库内，仍报 `ERR_MODULE_NOT_FOUND` 而变红——pnpm 不会把依赖提升到仓库根的 `node_modules`，从外部目录向上解析不到。「安装目录必须在仓库目录树外」的断言保留，但它现在是对其他提升依赖的布局（如 npm workspaces 或日后改 `public-hoist-pattern`）的保险，而不是已被证明的必要条件；Requirements 不变。③ web 包 `build` 由 `tsc` 发射改为复制 `public/` 到 `dist/`，并删除孤儿的 `packages/web/tsconfig.build.json`，与 Files that change 一致。
- 2026-10-17（镜像冒烟实现时）：① **spec R13 要求「`docker stop` 在 5 秒内完成」，实测该判据不稳**：本机 `docker stop` 用时 0.8–4.5 秒不等，而 server 自身在有空闲 keep-alive 连接时的关闭耗时是 0.00 秒，多出的时间在 Docker 一侧（容器启动本身在本机就要 7 秒以上，是 LXD 环境的固有开销）。冒烟脚本的门槛放宽为 8 秒，进程本身的 5 秒要求由退出码保证（Docker 10 秒后强杀，退出码变 137，已验证 `ENTRYPOINT` 改 shell 形式时被抓住）。**这触及 spec R13 的数值，需要你在评审时确认是否同步改 spec。** ② 「镜像内容」检查由 5 次 `docker run` 合并为 1 次，整个镜像冒烟从约 2 分钟降到约 72 秒；不是镜像下载慢（基础镜像在本地，冷构建全程约 40 秒），不需要换镜像源。③ 清理逻辑最初用数组登记容器名，但登记发生在 `$(...)` 子 shell 里，父 shell 看不到，导致每次运行遗留容器；改为按带本次后缀的固定名字清理，成功与失败路径都已验证零遗留（容器、卷、镜像、临时目录）。④ tarball 清单与镜像内清单的比较两边都固定 `LC_ALL=C` 排序，否则大写文件名的位置不同会误报。⑤ 为让清单可比，Dockerfile 里多一个 `tarball` 阶段（`FROM scratch`），仅用于把 tarball 导出到宿主机，不进最终镜像。
- 2026-10-17（接线检查时）：① README 里的 `docker run` 示例用 `<!-- smoke:docker-run -->` 标记，镜像冒烟从 README 提取它真实执行，只替换镜像名、容器名、卷名，并把 `-p 7420:7420` 换成 `--network host -e YUANSHU_PORT=<空闲端口>`（本环境 bridge 不可用）。示例被改坏时冒烟变红，已变异验证。② 自检里新增「缺 docker」「docker 守护进程不可用」两个用例，以及两个冒烟步骤失败时整体必须失败的用例；已对删除 docker 检查、冒烟步骤加 `|| true`、不调用冒烟五种变异逐一验证会变红。③ CI 只改了 `timeout-minutes`（15 到 20），未登录或推送任何镜像仓库。
- 2026-10-17（评审第 1 轮后）：评审发现两处我自己的测试漏掉的缺陷，均已修并加回归用例。① **R7 有漏洞**：只处理了"完成请求后空闲的 keep-alive"，没处理"已连接但没发完请求"的连接（连上不发、请求头半截、请求体没发完），后者会让 `stop()` 一直等，实测 12–75 秒不退出，在 Docker 里就是 `docker stop` 强杀、退出码 137。修复为 `forceCloseConnections: true`。我先前写在这里的变异验证结论「`forceCloseConnections: false` 是等价变异」只对"空闲连接"成立，对半开连接不成立——结论的前提不完整。② **R6 有缺口**：`@fastify/static` 会跟随 web 目录内指向目录外的符号链接，用 `allowedPath` 加 `realpathSync` 拦截。③ 删除死配置 `serveDotFiles`。
- 2026-10-17（评审第 2 轮后）：第 1 轮我修的符号链接洞本身有洞——`@fastify/static` 对目录请求是先过 `allowedPath`、之后才拼上 `index.html` 去读，只检查请求路径挡不住 `index.html` 是外链；`catch { return true }` 还让符号链接环以 500 带出服务器路径。已修（`609b3ce`）：目录请求把 `index.html` 一并解析检查，`catch` 只对 `ENOENT`/`ENOTDIR` 放行，`assertWebRoot` 同样检查根目录的 `index.html`。这再次印证 hardening 里「修复本身也要被评审」。
- 2026-10-17（评审第 3 轮后）：评审 0 阻塞 0 重要，收敛。处理了两条建议并补了「不存在路径得到 404」的用例，修复见 `d3ed9b0`。**一个等价变异的记录**：「`isInsideWebRoot` 的 catch 全部拒绝」改不了任何外部行为，因为 `@fastify/static` 在 `allowedPath` 拒绝时执行 `callNotFound()`，对外同样是 404，从外部无法区分「放行后 404」与「被拒后 404」。该变异不是测试漏洞；「不存在路径得到 404」的用例因此只能防止守卫抛出 500，注释里已写明。
- 2026-10-17（server 变异验证）：两条变异是等价变异，不是测试漏洞：① 静态托管先于 `/healthz` 注册——find-my-way 中静态路径永远优先于通配，与注册顺序无关；真正能遮蔽 `/healthz` 的 `wildcard: false` 已被抓住。② `forceCloseConnections: false`——Node 19 起 `http.Server.close()` 自己会关闭空闲连接，所以不能靠它区分；改为用「stop() 什么都不做」作变异，由「stop 之后连接被拒」的断言抓住。
- 2026-10-17（server 变异验证）：变异验证暴露两处测试缺口并已补强：① R8 的用例原本创建一个就启动一个，共享模块级状态的实现照样通过，改为两个实例先都创建再启动，并核对各自的数据目录；② R7 的用例只量了时间，没断言「stop 之后不再接收连接」，已补。
