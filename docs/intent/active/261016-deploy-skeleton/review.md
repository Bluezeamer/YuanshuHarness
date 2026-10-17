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

## 第 2 轮（2026-10-17）— 范围：d5e61ba...HEAD — 执行：新开空上下文 subagent

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 重要 | `packages/server/src/server.ts:47-56,85`（`allowedPath` / `isInsideWebRoot`） | 符号链接修复被"目录索引"路径绕过。`@fastify/static` 把请求路径 `/sub/` 或 `/sub` 先传给 `allowedPath`，此时 `realpathSync(webRoot/sub/)` 解析到目录本身，在根内，放行；之后库内部才拼上 `index.html` 去读，这一步不再经过 `allowedPath`。所以 web 目录内任意子目录里的 `index.html` 若是指向目录外的符号链接，就被原样提供。web 根目录自己的 `index.html`（`/`）同理，且 `assertWebRoot` 用的是 `stat`（跟随链接）。复现：`tmp/review/sl.mjs`（用 `createServer` + `webRoot`），web 目录内 `sub/index.html -> 目录外 secret.txt`，`GET /sub/` 返回 200 `SECRET`；`idxdir/index.html -> 目录外文件`，`GET /idxdir/` 与 `GET /idxdir` 均 200 且为目录外内容；而直接 `GET /sub/index.html` 为 404（正确）。新增测试只覆盖"链接指向文件 / 目录"，没有"index.html 本身是链接"，所以没抓到。可利用性仍受"需有人先往 web 目录放链接"限制，但这正是本次修复声称堵住的 R6 路径。 | 已修 `609b3ce`：`isInsideWebRoot` 对目录请求把 `index.html` 也 `realpath` 后检查；`assertWebRoot` 同样检查根目录的 `index.html` 是否在根内。新增 3 条用例（子目录、子目录不带斜杠、根目录），修前红修后绿；去掉目录索引检查、去掉 `assertWebRoot` 的检查，各自被对应用例抓住。 |
| 建议 | `packages/server/src/server.ts:52-54` | `catch { return true }` 在 `ELOOP`（符号链接环）时同样放行：`GET /loop1`（`loop1 -> loop2 -> loop1`）返回 500，响应体含服务器绝对路径：`ELOOP: too many symbolic links encountered, stat '/…/w3/loop1'`。这是路径信息泄露（R6 只要求 4xx，且不应泄露文件系统布局）。悬空链接返回 404，正常。建议只对 `ENOENT`/`ENOTDIR` 放行，其余错误拒绝（返回 404/403）。该守卫"先不存在、使用时才出现"的 TOCTOU 窗口依赖攻击者对 web 目录有写权限，库自身注释也声明了同样假设，不单列。 | 已修 `609b3ce`：`catch` 只对 `ENOENT`/`ENOTDIR` 放行，其余（含 `ELOOP`）拒绝。新增符号链接环用例，断言 4xx 且响应不含服务器路径；改回「任何错误都放行」被抓住。 |
| 待确认 | `packages/server/src/server.ts:70`（`forceCloseConnections: true`）；`spec.md` R7 | 真实进程 + SIGTERM 实测：连上不发、请求头半截、请求体没发完、慢速 POST（每 0.5 秒 1 字节）、暂停读取的大文件下载，退出耗时 0.007–0.11 秒，退出码 0，原 `重要` 项确实消失。但副作用：正在流式响应的合法请求会被直接截断。复现：把 300 MB 文件放进 web 目录，客户端读到约 7 MB 时发 SIGTERM，客户端得到 `ECONNRESET`，进程 0.109 秒退出。R7 只要求"5 秒内以 0 退出、停止接收新连接"，没有要求排空在途请求，所以不算违规；但 `docker stop` 期间的合法下载 / 未来的长请求会被腰斩。是否接受（或改为"先 `close()` 排空一个宽限期，再强制断开"）请裁决；缺的是产品口径，不是证据。没有对应测试断言"在途请求被截断"是有意行为。 | 推迟，待 bluezeamer 裁决：是否在强制断开前留一段排空宽限期。现状满足 R7 字面要求（5 秒内以 0 退出），代价是关停瞬间会截断正在流式传输的合法响应。改为「先 `server.close()` 停止接收，等在途请求至多 N 秒，超时再 `closeAllConnections()`」成本不大，但会让有长连接时的每次停止多等 N 秒，且需要定 N。本服务是单用户单部署、当前无长耗时响应，我倾向保持现状，等第 3 条出现事件流（长连接）时再定。 |
| 建议 | `packages/server/src/server.test.ts:186-212` | 新增符号链接测试都是"链接指向文件 / 目录"，没有断言"index.html 是指向目录外的链接"（对应上面的重要项）、符号链接环、web 根本身是符号链接。我另行验证：web 根是符号链接时（`wlink -> w3`）正常工作，内部链接可访问，外部链接 404，无副作用。 | 已修 `609b3ce`：补了 index.html 链接（三种）与符号链接环用例；「web 根本身是符号链接」评审者已另行验证正常，未再加用例。 |

上轮阻塞/重要项核对：第 1 轮唯一的"重要"项（R7 半开连接让 `stop()` 不退出）确实消失——`bin.js` 真实进程实测 `idle`/`partial`/`body`/`none` 分别 0.007/0.007/0.009/0.007 秒，退出码 0，对照上轮 75/12/72.7 秒。第 1 轮的符号链接建议项对"链接指向文件 / 目录"部分确实消失（`/link.txt`、`/odir/…`、编码变体 `/%6Cink.txt`、大小写变体均 404；链式链接指向内部可访问；悬空链接 404；`realpathSync` 每请求约 0.4 ms，3000 层深路径约 0.7 ms，未见可滥用的阻塞），但经目录索引仍可绕过，见上面的"重要"。

已执行且通过：`pnpm lint`、`pnpm -r typecheck`、`pnpm -r test`（server 124、web 1）、`scripts/smoke-package.sh`、`bash tests/check/selfcheck.sh`、`scripts/smoke-image.sh`（约 94 秒，`docker stop` 4.4 秒）。冒烟后 `docker ps -a --filter name=yuanshu-smoke`、卷、镜像均无遗留。另验证 `//healthz` 403、`/healthz/` 404、`/HEALTHZ` 404、`/%2e%2e/secret` 403，`/healthz` 不被遮蔽。临时在被 git 忽略的 `packages/server/web/` 放过 300 MB 测试文件，已删除。

本轮阻塞级：0 条。

## 第 3 轮（2026-10-17）— 范围：1058574...HEAD — 执行：新开空上下文 subagent

| 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|
| 建议 | `packages/server/src/server.ts:60`（`existsSync(index)`） | 与第 2 轮 ELOOP 同一类问题没有收尾：`existsSync` 会把 `EACCES` 吞成 `false`，于是目录本身没有搜索权限（`chmod 000 sub`）时，`!existsSync(index)` 为真、守卫放行，库随后 `stat` 失败，返回 500 且响应体带服务器绝对路径。复现：web 目录里 `mkdir priv; echo P > priv/index.html; chmod 000 priv`，`node tmp/review/r3.mjs <web> /priv/`，得到 `500 {"code":"EACCES","message":"EACCES: permission denied, stat '/…/priv/index.html'"}`（`/priv` 不带斜杠为 404，恢复权限后 `/priv/` 为 200）。前提是运维把 web 目录里某子目录权限弄坏，远程攻击者无法制造，所以只算建议；修法是把 `existsSync` 换成 `try { realpathSync(index) } catch ENOENT/ENOTDIR 才放行`，与 catch 的口径一致。 | 已修 `d3ed9b0`：去掉 `existsSync`，改为对 `index.html` 做 `realpathSync`，与 `catch` 同一口径（只有 `ENOENT`/`ENOTDIR` 放行）。新增 `chmod 000` 子目录用例，修前红（500 带路径）修后绿，改回恒放行的变异被抓住。 |
| 建议 | `packages/server/src/server.test.ts:208-219` | "根目录 index.html 是外链"一支只断言 `launch()` 失败（`addr` 为 `undefined`），不检查失败原因。任何启动失败（端口占用、数据目录问题）都会让它通过，所以去掉 `assertWebRoot` 里的 `within` 检查之外的别的故障也能让它绿；我没有做变异验证，但断言本身没有绑定到 `index.html 指向 web 目录之外`。另外 `launch().catch(() => ({addr: undefined}))` 让三个参数化用例共用同一段带分支的体，子目录两支若启动意外失败会落到 `rawGet(0, …)` 报出不相关的错误。建议把根目录一支拆成独立用例并断言错误信息包含"指向 web 目录之外"。 | 已修 `d3ed9b0`：根目录外链拆成独立用例，断言错误信息含「指向 web 目录之外」；子目录两支不再共用带分支的体。 |
| 待确认 | `packages/server/src/server.ts:56-62`（检查与使用之间） | 守卫先 `realpath` 再由库按原路径读取，存在 TOCTOU：目录请求时 `index.html` 在检查后被换成外链即可绕过。利用前提是攻击者对 web 目录有写权限，无写权限的远程攻击者无法触发；评估为"低"，且库自身的 `allowedPath` 也是同样假设（库的 `send` 是按路径打开，不是按 fd）。缺的证据：没有对 `@fastify/static` 打开文件的源码路径做逐行核对，只做了黑盒实测，所以不下结论，仅标注前提。 | 接受，不改：已读 `@fastify/static` 源码（`index.js:342-343`），库自己的注释写明「静态根目录被假定不会在这次检查与 send 打开文件之间被攻击者改动」，与评审者评估的前提一致（需要对 web 目录有写权限）。web 目录是构建产物，只有部署者能写。守卫依赖库行为的担忧（升级库后悄悄失效）由常驻的符号链接用例兜底：这些用例在每次 CI 里跑，库升级使守卫失效就会变红。 |

上轮阻塞/重要项核对：
- 第 2 轮"重要"（符号链接修复被目录索引 `index.html` 绕过）：确实消失。真实 `dist/server.js` 起服务，`tmp/review/sl.mjs` 与 `tmp/review/r3.mjs` 实测：子目录 `sub/index.html -> 目录外文件`，`/sub/`、`/sub` 均 404；三级目录 `a/b/c/index.html` 外链，`/a/b/c/`、`/a/b/c` 均 404；根目录外链启动即失败（`index.html 指向 web 目录之外`）；`index.html` 指向另一个目录内部文件，`/idxdir/`、`/idxdir` 均 200 且内容正确；`index.html` 本身是目录 404；`index.html` 悬空链接 404；中间组件是外链（`midlink/`、`mid/x/`、`outlink/…`）404；链式链接指向外部 404；`%2e%2e` 403，双重编码 `%252e%252e` 404，`//sub/`、`/./sub/`、`/sub//`、`/sub/%00` 403，`/SUB/`、`%73ub/`、`%2573ub/`、`sub%2f` 404；5000 字符路径带/不带斜杠 403，均无 500。web 根本身是符号链接（`wlink -> w`）时 `/` 200、内部链接可访问、外链 404。
- 正常路径未被新 `catch` 挡住：`/nope`、`/nope/x`、`/index.html/foo`（ENOTDIR）均 404 而非 403/500；`/sub/` 这类"目录无 index"返回库自己的 404。唯一的例外是上面 EACCES 一条（500）。
- 第 2 轮"建议"（ELOOP 500 带路径）：确实消失（新用例断言 4xx 且不含路径，`/loop1` 修后 4xx）；同类的 EACCES 见上表第一条。
- 第 2 轮"符号链接测试缺口"：补了 index.html 外链三支与环；但根目录一支断言偏弱，见上表第二条。
- `assertWebRoot`：`index.html` 外链失败信息为"index.html 指向 web 目录之外"；是目录为"index.html 不是文件"；悬空链接与不存在均为 `ENOENT … realpath '<web>/index.html'`。信息都包含的只是运维自己传入的 web 目录路径，不泄露目录之外的内容；悬空链接那条不告诉人链接目标，清楚度足够。

回归检查：`realpath` 比较双方都已 realpath，所以全局 node_modules 目录路径里含符号链接不影响（`wlink` 实测等价）；`scripts/smoke-package.sh`（3.5 秒）与 `scripts/smoke-image.sh`（100 秒，`docker stop` 4.6 秒、退出码 0）均通过，占位页 `GET /` 200、`/healthz` 不受影响。测试里用的是 `mkdtemp` 的 `base`，断言 `not.toContain(base)` 时若 `/tmp` 为符号链接，服务端报错带的是传入路径而非 realpath，仍然成立，未见对文件系统的特殊依赖；但环用例里的 500 路径泄露由 `ELOOP` 触发，依赖内核对链接环的行为，在常见 Linux/macOS 上一致。

已执行且通过：`pnpm lint`、`pnpm -r typecheck`、`pnpm -r test`（server 128、web 1）、`bash tests/check/selfcheck.sh`、两个冒烟脚本。冒烟后 `docker ps -a --filter name=yuanshu-smoke`、卷、镜像均无遗留。实验目录 `tmp/review/r3/` 内临时改过权限的目录已恢复。

本轮阻塞级：0 条。
