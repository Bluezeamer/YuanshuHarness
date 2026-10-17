# Review: 部署骨架

Reviewer: 每轮由新开的空上下文 subagent 执行（见 references/review.md）；人在 MR 上做最终评审

> 每一轮评审追加一节。评审记录写在这里，不写进 spec。
> 连续三轮仍有阻塞级问题 → 暂停，回到 spec 澄清口径，必要时请人裁决或升档。

## 第 1 轮（2026-10-17）— 范围：4610720...HEAD — 执行：新开空上下文 subagent

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 重要 | `packages/server/src/server.ts:58,94`（`Fastify({...})` 未设 `forceCloseConnections`，`stop()` 只调 `app.close()`） | R7 要求收到 SIGTERM/SIGINT 后 5 秒内以 0 退出。只要有一条"已连接但还没发完请求"的 TCP 连接（连上后什么都不发、请求头只发一半、请求体没发完），`stop()` 就一直等它，进程不退出。这与 spec 点名的"完成请求后空闲的 keep-alive"不同，现有测试（`server.test.ts` 的 keep-alive 用例）只覆盖后者，所以是漏网的。TCP 层探测或端口扫描就能触发；在 Docker 里表现为 `docker stop` 10 秒后被强杀、退出码 137。复现：`node tmp/review/slow.mjs idle`（真实 `dist/bin.js` 起进程，连上一条不发数据的 socket，再发 SIGTERM）。实测：`idle` 75 秒后仍在运行，`partial`（请求头只发一半）12 秒后仍在运行，`body`（`Content-Length: 100` 只发 2 字节）72.7 秒后才退出，对照 `none`（无连接）0.008 秒退出。 | 已修 `fcd5726`：`Fastify({ forceCloseConnections: true })`；`server.test.ts` 新增三种半开连接（连上不发、请求头半截、请求体没发完）的回归用例，修前 25 秒超时变红、修后绿；真实进程复现脚本修后三种情形均约 0.01 秒以 0 退出；去掉该选项的变异被三条用例抓住。 |
| 建议 | `packages/server/src/server.ts:66-72`（`@fastify/static` 选项） | `@fastify/static` 会跟随 web 目录内的符号链接。web 目录里的符号链接指向目录外时，文件被原样提供，与 R6"只提供该目录内的文件"不符。复现：web 目录里 `ln -s ../secret.txt link.txt`、`ln -s /etc etcdir`，`GET /link.txt` 返回 200 及目录外文件内容，`GET /etcdir/passwd` 返回 200 及 `/etc/passwd`。当前 web 目录是 `cp -R` 自己的构建产物，没有符号链接，实际可利用性低，但 R6 的测试没有符号链接用例，需求在这条路径上没有被断言。 | 已修 `fcd5726`：`allowedPath` 对请求路径做 `realpathSync`，解析后不在 web 真实根目录内则拒绝；新增两条逃逸用例（链接到目录外文件、链接到目录外目录）和一条"指向目录内部的链接仍可访问"的对照；去掉 `allowedPath` 或令其恒真的变异均被抓住。 |
| 建议 | `packages/server/src/server.ts:71` | `serveDotFiles: false` 是死配置：在 `@fastify/static` 里它只影响 `list` 模式下的 glob（`index.js:191`），本项目没开 `list`。点文件的拒绝实际由第 70 行的 `dotfiles: "deny"` 完成。留着会误导后来者以为有两道防线。 | 已修 `fcd5726`：已删除 `serveDotFiles: false`，点文件仍由 `dotfiles: "deny"` 拒绝（测试仍绿）。 |
| 待确认 | `scripts/smoke-image.sh:113`；plan Deviations 第 88 行 | 实现者已自述：R13 要求"`docker stop` 在 5 秒内完成"，脚本把门槛放宽到 8 秒；另因 bridge 网络不可用，"经映射端口访问"改为 host 网络直连，`-p 7420:7420` 在冒烟里被替换掉，因此 `-p` 本身从未被实际执行。我认为理由站得住（进程自身的 5 秒由装包冒烟和退出码 137 兜底），但 spec 的 R13 文字没有同步，两者现在不一致。缺的是你对"改 spec 还是保留偏离记录"的裁决。另外上面第一条"重要"发现说明：进程自身是否 5 秒内退出，目前只有装包冒烟里的"无额外连接"场景在断言。 | 推迟，待 bluezeamer 裁决：spec R13 的「5 秒」与脚本的 8 秒门槛现在不一致。选项：(a) 改 spec R13，写成「进程在收到 SIGTERM 后 5 秒内以 0 退出（由退出码保证），`docker stop` 整体不超过 8 秒」；(b) 保留 spec，把偏离记录留在 plan。第 1 轮修复之后，进程本身在半开连接下也已约 0.01 秒退出，8 秒门槛只是给 Docker 一侧的开销留余量。 |
| 待确认 | `scripts/smoke-package.sh`、CI | spec Risks 说单测与装包冒烟跑在 Node 22.19.0（`engines` 下限），本机实测是 Node 24.13.1，所以本轮没有任何证据证明 22.19.0 上能跑通。需要第一次 CI 结果（或在 22.19.0 上本地执行 `scripts/smoke-package.sh` 与 `pnpm -r test`）才能确认。 | 推迟：需要 PR 的首次 CI（Node 22.19.0）结果，推送前无法确认。已在 plan 里列为待验证项。 |
| 建议 | `packages/server/src/config.ts:81` | `--help`/`-h` 在所有校验之前短路：`yuanshu bogus --help`、`yuanshu serve --port abc -h`、带未知 `YUANSHU_*` 的 `--help` 都返回 help 且退出码 0。R1 说"`--help`、`-h` 退出 0"，所以不算违反；但"未知子命令必须非零"在带 `--help` 时被绕过。是否接受这个口径请确认，接受则无需改动。 | 推迟，待 bluezeamer 裁决：`--help` 是否应当绕过其他校验。保持现状的理由：帮助是诊断入口，用户写错参数时加 `-h` 看用法是常见动作；R1 只要求 `--help`/`-h` 退出 0。改的话成本很小（先校验再判断 help）。 |

已执行且通过（无发现）：`pnpm lint`、`pnpm -r typecheck`、`pnpm -r test`（server 118、web 1）、`scripts/smoke-package.sh`（约 2 秒）、`scripts/smoke-image.sh`（约 80 秒，`docker stop` 用时 4.4 秒、退出码 0）、`bash tests/check/selfcheck.sh`。镜像冒烟后 `docker ps -a --filter name=yuanshu-smoke`、卷、镜像标签均无遗留。另用真实进程构造了穿越、编码、点文件、大小写、`//healthz`、`/healthz/`、NUL、非法 UTF-8、HEAD/OPTIONS/POST、Range 请求，均符合 R5/R6（穿越与点文件 403，`/healthz` 不被遮蔽，`/sub/` 404）；构造了 `parseConfig` 的前导零、`+80`、`8e1`、`0x50`、空白主机、小写 `yuanshu_port` 等输入，行为与 R2 一致。实验脚本在 `tmp/review/`。

本轮阻塞级：0 条。
