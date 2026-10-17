# Spec: 部署骨架
Author: bluezeamer
Status: accepted
Date: 2026-10-17

> 写成 delta：只写本次变更相对既有约定新增或改变了什么。ARCHITECTURE / ADR 已讲过的内容只链接，不复述。
> 本文件只在 Requirements 变化时修改；评审发现写进 review.md。

## Links
来源: [intent.md](intent.md)
上游: [ADR-0012](../../../genesis/adr/0012-delivery-form.md)、[ADR-0013](../../../genesis/adr/0013-tech-stack.md)、[ADR-0014](../../../genesis/adr/0014-hosting-and-ci.md)、[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)、[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)、[ADR-0019](../../../genesis/adr/0019-release-artifacts.md)
下游: plan.md、PR（实现后回填）

## Requirements

### Server 行为
R1. 命令入口为 `yuanshu serve`。裸 `yuanshu`、未知子命令必须把用法写到 stderr 并以非零状态退出，不得启动服务。`--help`、`-h` 把用法写到 stdout 并以 0 退出。
R2. `yuanshu serve` 的配置按"命令行 > 环境变量 > 默认值"取值：
   - `--host` / `YUANSHU_HOST`，默认 `127.0.0.1`；
   - `--port` / `YUANSHU_PORT`，默认 `7420`，必须是 1–65535 的十进制整数；
   - `--data-dir` / `YUANSHU_DATA_DIR`，默认 `~/.yuanshu`（`~` 为运行用户的主目录）；相对路径按当前工作目录解析为绝对路径。

   空串、非法端口（`0`、`70000`、`80abc`）、未知的命令行选项、多余的位置参数，以及任何以 `YUANSHU_` 开头但不在上表中的环境变量，一律启动失败：stderr 输出指明哪一项的原因，以非零状态退出，且不得已经开始监听。
R3. 监听地址非回环时，启动必须输出 warn 级别日志，说明认证尚未生效；不得拒绝启动。回环仅指 `127.0.0.0/8` 内的 IPv4 字面量、`::1` 与字符串 `localhost`；其余一切（含 `0.0.0.0`、`::`、`::ffff:127.0.0.1`、任何其他地址与主机名）按非回环处理。判定宁可多警告，不得漏警告。回环地址不得输出该警告。
R4. 数据目录：不存在则创建（含缺失的父目录），新建的数据目录权限为 0700，已存在的不改其权限；路径存在但不是目录、或无法在其中创建文件，启动失败并指出路径。服务启动后与退出后，数据目录内不得留下任何文件（可写性探测所用的临时文件当场删除）。
R5. `GET /healthz` 返回 200、`Content-Type: application/json`，响应体恰为 `{"status":"ok","version":"<版本>"}`，仅这两个字段，不含路径、配置或数据目录信息；无需认证。`HEAD /healthz` 返回 200 且无响应体。`version` 必须等于 server 包 `package.json` 的 `version`，在源码运行、构建产物运行、npm 安装后运行、镜像内运行四种情形下一致。
R6. 静态托管：
   - Server 托管 web 包的构建产物目录。`GET /` 返回其中的 `index.html`（200）；不存在的路径返回 404，不回退到 `index.html`。
   - web 目录不存在或其中没有 `index.html` 时，启动必须失败；不得在前端缺失的情况下带着健康的 `/healthz` 降级运行。
   - 只提供该目录内的文件：目录穿越（`/../`、`/%2e%2e/`、`/%2e%2e%2f`、`/..%5c`）、点文件与目录列表的请求必须得到 4xx，响应不含目录外内容。
   - `/healthz` 不得被静态托管遮蔽：即使 web 目录里有名为 `healthz` 的文件，仍返回 R5 的响应。
R7. 生命周期：监听失败（端口被占用、地址无效）必须以非零状态退出，错误信息含 host 与 port。收到 SIGTERM 或 SIGINT 必须停止接收新连接并以 0 退出，在 5 秒内完成，即使存在空闲的 keep-alive 连接。
R8. 创建服务器的入口不得依赖进程全局的可变状态：同一进程内可以同时创建两个配置不同的实例，互不影响（[ADR-0013](../../../genesis/adr/0013-tech-stack.md)）。
R9. `fastify` 与 `@fastify/static` 在 server 包的 `dependencies` 里用精确版本，不得使用 `^`、`~` 或范围；`fastify` 为 5.x 且不低于 5.12.2（[ADR-0017](../../../genesis/adr/0017-server-web-framework.md)）。

### npm 包
R10. 包结构：
   - 只有 `packages/server` 打包为发布物，其 `package.json` 保持 `private: true` 直到首次发布；web 包同样私有。
   - `bin.yuanshu` 指向构建产物里带 shebang 的入口；`engines.node` 为 `>=22.19.0`；声明 `license: MIT`。
   - `files` 白名单只含构建后的 JS 与 web 静态产物（外加 npm 自动带入的文件）；打出的 tarball 不得含 `src/`、测试文件、`tsconfig*`。
   - 从不含任何构建产物的干净检出开始，根上的一条构建命令之后即可打包，且 tarball 里有 web 的 `index.html`；不得依赖工作目录里残留的产物。
   - web 包的构建产出一个含 `index.html` 的占位静态目录；本阶段不引入 React、Tailwind 或打包器。
R11. 装包冒烟（`scripts/smoke-package.sh`）：清除既有构建产物后构建并打包；在仓库目录树之外的临时目录里用 `npm install` 安装该 tarball；用该目录里的 `yuanshu serve`，以空闲端口和临时数据目录启动；校验 `/healthz` 为 200 且 `version` 等于 tarball 内 `package.json` 的版本、`GET /` 为 200 且是占位页；发送 SIGTERM，必须在 5 秒内以 0 退出；数据目录仍为空。任一步失败，脚本必须以非零状态退出；无论成败，不得遗留子进程与临时目录。

### Docker 镜像
R12. `Dockerfile` 在仓库根，多阶段构建：
   - 构建阶段用与 R11 相同的构建与打包方式产出 tarball。
   - 最终阶段的基础镜像为 Node 24 的 slim 镜像，标签锁定到具体补丁版本与 Debian 代号（形如 `node:24.x.y-<代号>-slim`），不得使用 `latest`、`24`、`24-slim` 这类浮动标签；具体值在实现时用 `docker pull` 并读取镜像内 `/etc/os-release` 核实后写入。
   - 最终阶段只安装该 tarball，不含源码、pnpm、开发依赖；以 `node` 用户（uid 1000）运行；`/data` 存在且属主为 `node`；`YUANSHU_HOST=0.0.0.0`、`YUANSHU_DATA_DIR=/data`；`EXPOSE 7420`；不声明 `VOLUME`；`ENTRYPOINT` 用 exec 形式，为 `["yuanshu","serve"]`。
   - 镜像内置 `HEALTHCHECK`，用镜像里已有的 Node 探测 `/healthz`，以 200 为健康，不依赖 curl 或 wget；探测端口取自 `YUANSHU_PORT`，缺省 7420。
R13. 镜像冒烟（`scripts/smoke-image.sh`）：构建镜像（不推送）并实际运行容器，校验：
   - 容器健康状态在 30 秒内变为 healthy，且宿主机经映射端口访问 `/healthz` 为 200、`version` 正确、`GET /` 为 200；
   - 镜像里配置的探测命令，对一个没有监听的端口执行时必须失败；
   - `docker stop` 在 5 秒内完成，容器退出码为 0；
   - 把宿主机上一个对容器用户不可写的目录（权限 0555）挂为 `/data`，容器必须以非零状态退出，日志里有 `/data` 不可用的说明；
   - 最终镜像里：运行用户 uid 为 1000，没有 pnpm，没有 `src` 目录，`yuanshu` 的安装文件清单与 tarball 一致。

   任一步失败，脚本必须以非零状态退出；无论成败，不得遗留容器、卷与镜像标签。
R14. `.dockerignore` 必须排除 `.git`、`node_modules`、`tmp`、`.claude`、`.pi`、`.worktrees` 与构建产物，避免把本地私有目录送进构建上下文。

### 检查与 CI
R15. `scripts/check.sh` 在构建之后依次新增装包冒烟与镜像冒烟，其余步骤与顺序不变。前置检查新增 `docker` 命令与守护进程可用性：缺失或不可用必须失败并指明缺的是哪一项，不得提供跳过开关。
R16. `.github/workflows/ci.yml` 仍只负责起环境并调用 `scripts/check.sh`；作业名仍为 `check`；权限仍仅 `contents: read`；不引用 secret，不登录或推送任何镜像仓库。每个 PR 与主干推送都构建镜像并起容器验证。
R17. README 补充：`yuanshu serve` 的三个参数与对应环境变量；用命名卷运行镜像的示例；说明绑定挂载的宿主目录须对 uid 1000 可写，否则按 R4 启动失败；说明容器内修改端口须用 `YUANSHU_PORT` 而不是命令行，否则内置探测会指向旧端口。

## Proof
| 需求 | 证明（测试名 / 命令） | 旧实现下应失败 / 变异验证 |
|---|---|---|
| R1 | `cli.test.ts`：裸命令、未知子命令、`--help`、`serve` 的退出码与输出流 | 是（入口不存在）。变异验证：让裸命令走到启动，用例必须变红 |
| R2 | `config.test.ts`：对纯函数 `parseConfig(argv, env, home)` 逐项断言优先级、默认值、相对路径、各类非法输入与未知 `YUANSHU_*` 变量 | 是。变异验证：交换命令行与环境变量的优先级、放过未知 `YUANSHU_*` 变量，各自对应用例必须变红 |
| R3 | `server.test.ts`：捕获日志，非回环（`0.0.0.0`、`::`、`::ffff:127.0.0.1`、`192.0.2.1`）有 warn，回环（`127.0.0.1`、`127.8.9.1`、`::1`、`localhost`）没有；非回环仍启动成功 | 变异验证：把 `0.0.0.0` 误判为回环，必须变红 |
| R4 | `data-dir.test.ts`：新建权限 0700、已存在不改权限、路径是文件时失败、目录 0555 时失败；启动并停止后 `readdir` 为空 | 变异验证：不删除探测文件，必须变红。注意：以 root 运行测试会绕过权限，用例遇到 root 须明确失败而不是跳过 |
| R5 | `server.test.ts`：`inject` 校验状态码、`Content-Type`、响应体全等、HEAD；装包冒烟与镜像冒烟里再用真实 HTTP 校验 | 变异验证：在代码里写死版本号并 bump `package.json`，装包冒烟必须变红 |
| R6 | `static.test.ts`：临时 web 目录里放 `index.html`、`.secret`、`healthz`，校验首页、404、穿越与点文件、目录列表、`/healthz` 不被遮蔽；空目录与缺失目录启动必须失败 | 变异验证：把静态托管注册为先于 `/healthz` 的通配、把 `dotfiles` 改为允许，各自必须变红；打包时漏掉 web，装包冒烟必须变红 |
| R7 | `lifecycle.test.ts`：端口已被占用时启动失败；带空闲 keep-alive 连接调用 `stop()` 在 5 秒内完成。信号接线由装包冒烟（真实进程 SIGTERM）与镜像冒烟（`docker stop`）证明 | 变异验证：把 `ENTRYPOINT` 改成 shell 形式，镜像冒烟的 `docker stop` 必须变红（SIGTERM 到不了 node，退出码 137） |
| R8 | `server.test.ts`：同一进程内用不同配置创建两个实例，各自响应、各自关闭，互不影响 | 变异验证：把某项配置存进模块级变量，必须变红 |
| R9 | `package.test.ts`：读取 `package.json`，断言两项依赖是精确版本，`fastify` 主版本为 5 且不低于 5.12.2 | 变异验证：改成 `^5.12.7`，必须变红 |
| R10 | `package.test.ts` 断言 `private`、`bin`、`engines`、`license`、`files`；装包冒烟列出 tarball 清单，断言含 `web/index.html`、不含 `src/`、`*.test.*`、`tsconfig*`；本地先 `git clean` 构建产物目录再跑 | 变异验证：把 `@fastify/static` 移到 `devDependencies`，装包冒烟必须变红（仓库外安装拿不到它）；`files` 多放一个目录，清单断言必须变红 |
| R11 | `scripts/smoke-package.sh`；脚本里显式断言安装目录位于仓库目录树之外 | 变异验证：让服务启动后不响应，脚本必须非零且无遗留进程；把安装目录改到仓库目录树内并删掉某个运行时依赖声明，冒烟会误绿（Node 沿父目录解析到仓库自己的 `node_modules`），这证明"必须在仓库外"的断言不可去掉 |
| R12 | 镜像冒烟里的检查；评审核对 `Dockerfile`；一条静态断言要求最终阶段 `FROM` 的标签符合 `node:24.<次>.<补>-<代号>-slim`；`docker pull` 与 `/etc/os-release` 的结果记入 plan | 变异验证：去掉 `USER node`、把 `ENTRYPOINT` 改 shell 形式，镜像冒烟必须变红；换成 `node:24-slim` 浮动标签，静态断言必须变红 |
| R13 | `scripts/smoke-image.sh` | 变异验证：把 `HEALTHCHECK` 改成恒成功，探测命令那一步必须变红；把 `/data` 属主改成 root，healthy 那一步或不可写那一步必须变红 |
| R14 | 一条静态断言检查 `.dockerignore` 含上述各项；评审核对 | 变异验证：删掉其中一项，断言必须变红 |
| R15 | `tests/check/selfcheck.sh` 新增：PATH 里没有 `docker`，`check.sh` 前置检查必须非零并点名 docker；有 `docker` 命令但 `docker info` 失败时必须非零并点名守护进程 | 变异验证：删掉 docker 前置检查，自检必须变红 |
| R16 | `grep` 工作流确认无 `pull_request_target`、`secrets.`、`docker login`、`docker push`；在 PR 上跑一次作业成功 | 向分支推一个破坏镜像的提交（如去掉 `USER node`），作业必须变红 |
| R17 | 评审核对；README 里的 `docker run` 命令原样在镜像冒烟里跑通 | 不适用 |

变异验证的结果记入 `review.md`。除 R15 外，这些变异不进 CI 常驻，由评审者实际执行一遍。

## Design
沿用 ADR 的选型，新增的只有以下结构（具体文件拆分 plan 可调整）：

```
packages/server/src/
  cli.ts        入口：子命令、信号接线、退出码
  config.ts     纯函数 parseConfig(argv, env, home)，用 node:util 的 parseArgs（strict），不加依赖
  data-dir.ts   prepareDataDir(path)：创建、0700、写入并删除探测文件
  server.ts     createServer(config, { webRoot? }) → { start, stop }；不使用模块级可变状态
packages/web/   public/index.html 占位页，构建输出到 dist/
scripts/        pack.sh（打包，R11 与镜像构建阶段共用）、smoke-package.sh、smoke-image.sh
Dockerfile  .dockerignore
```

- tarball 包根下的布局为 `dist/**`、`web/**`；`webRoot` 缺省取包根的 `web/`，`version` 取包根的 `package.json`，两者都从 `import.meta.url` 反推，源码、构建产物与安装后都得到正确位置。`webRoot` 作为参数暴露只是为了让单测传入临时目录，缺省路径的正确性由两个冒烟来证明。
- 构建顺序显式写出：先 web 后 server，再复制 web 产物到 server 包的 `web/`（该目录是构建产物，不入库）。不靠 `pnpm -r` 的隐含顺序。
- 命名卷首次使用时会继承镜像里 `/data` 的属主，所以 README 的命名卷写法可直接写入；绑定挂载沿用宿主目录属主，不可写时按 R4 失败，这是 ADR-0019 的既定行为。
- 数据目录可写性用"创建并立即删除一个临时文件"探测，而不是 `access()`：只读挂载与权限位的组合下后者可能与真实可写性不一致。

### 迁移与兼容策略
- 没有已发布的版本，没有存量数据，不涉及迁移。
- 本版本不在数据目录里留下任何文件（R4）。因此第 3 条引入结构版本号时，"没有版本标记的数据目录"只可能是空目录，可当作新目录初始化，不需要为历史布局写读侧兼容。
- 对外契约只增不改：命令名、`/healthz` 的形状、端口 7420、镜像里的 `/data` 与环境变量名一经发布不得改变；第 3 条新增认证参数是对 R2 参数表的追加。旧版本遇到新参数会失败（R2），这是有意的，升级路径的影响由第 3 条处理（[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md)）。

## Risks
- Node 24 的测试覆盖：CI 单测与装包冒烟跑在 Node 22.19.0，只有镜像冒烟跑在 Node 24。本变更**不**加 Node 24 的 CI 矩阵：单测的逻辑与 Node 版本无关，Server 在 24 上的真实行为（启动、健康、静态、信号）已由镜像冒烟覆盖，再加矩阵收益有限而成本翻倍。ROADMAP 第 2 条的契约测试必须在镜像使用的 Node 版本上也能跑，pi SDK 在 24 上的行为到那时才会被验证。这是本 spec 对 [ADR-0019](../../../genesis/adr/0019-release-artifacts.md)「影响」第一条的决定，需要 G3 确认。
- 依赖版本未核实：Fastify 5.12.7 与 `@fastify/static` 10.1.6 来自 pi 的搜索结果，我没有独立核对。实现时以真实安装为准，并把锁定的实际版本记入 plan。`engines` 里 Fastify 未声明 Node 下限，对 22.19 的兼容性由 CI 里的真实运行证明。
- 镜像基础的 Debian 代号与精确标签尚未核实，实现时用 `docker pull` 核实后写入；若 `24-slim` 默认并非最新 Debian，以核实结果为准。
- 本地跑 `scripts/check.sh` 现在需要 Docker 守护进程。这是 intent 要求的"缺前提必须失败"的直接后果，没有跳过开关。
- 内置 `HEALTHCHECK` 只读 `YUANSHU_PORT`；容器里只用命令行改端口会让容器被判为不健康，是响亮的失败，已写入 README（R17）。
- 版本号对未认证者可见（[ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md) 已接受）。
- 发布的 tarball 本阶段不含 `LICENSE` 文件，只有 `package.json` 里的声明；首次发布前须补（ROADMAP 第 13 条）。
- 占位页只证明"打包进 Server"这条链路通，不证明真实前端的构建与托管；真实前端属 ROADMAP 第 4 条。
- 只验证了 Linux 宿主与 Linux 容器；macOS、Windows 上的行为未验证（[ADR-0012](../../../genesis/adr/0012-delivery-form.md)）。
- 镜像冒烟依赖托管 runner 自带 Docker 且能拉取基础镜像；拉取失败时 CI 会变红而不是跳过，属有意。
