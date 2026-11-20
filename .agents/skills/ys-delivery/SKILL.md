---
name: ys-delivery
description: 元枢 Harness 的收尾与验收：改完代码后跑哪些检查（单测、类型、lint、设计守卫、突变检查、真浏览器验收脚本、镜像冒烟）、skill 与文档同步、提交前自查。声称做完之前加载；写或改 `scripts/verify-*.mjs` 验收脚本时同时读 `references/verify-scripts.md`。
---

# 元枢：收尾与验收

`scripts/check.sh` 是唯一的检查入口，本地与 CI 跑同一份：前置检查 → 冻结锁文件安装 → 各阶段：`core`（类型检查、lint、测试、构建、装包冒烟）→ 真机验收的六个领域阶段（`ui-settings`、`ui-chat`、`ui-workspace`、`ui-canvas`、`ui-mobile`、`browser`）→ `image`（镜像冒烟）。不带参数按顺序全跑，也可以只跑一个阶段（`scripts/check.sh ui-chat`），CI 就是把阶段拆成并行作业。日常只跑与改动相关的那几步，提交前再整体过一遍。

## 收尾顺序

1. **单测 / 类型 / lint**：web `pnpm --filter yuanshu-harness-web exec vitest run [路径]`，server 见 `ys-server`；类型 `exec tsc --noEmit`；lint 在仓库根 `pnpm lint`（biome），只看有没有**新增**警告。`biome format --write` 只对自己改过的文件跑：对整个目录跑会顺手重排别人没提交的文件，跑完看一眼 `git status`。新增测试文件后跑一遍所属包的全量：全量比单目录严。vitest 的 `console.log` 只在 `--reporter=verbose` 下才显示，别用 `grep` 在默认输出里找它。
2. **设计守卫基线**（改过 CSS / TSX 时）：基线现在是空的，正常情况下不用动它；万一某个「清理了的要同步收缩基线」用例红了，说明有违规被清掉了，才需要 `UPDATE_BASELINE=1 pnpm --filter yuanshu-harness-web exec vitest run src/design.guard.test.ts`，再看 `src/design.baseline.json` 的 diff，**只能减、不能增**——增就是违规，不能靠更新基线放行。
3. **突变检查**：对每个新增的保护 / 分支，撤掉它，对应测试必须变红；不红说明测试没测到，或保护冗余（冗余的删掉）。用 python 做精确替换并**断言目标串存在**（`sed` 遇上 biome 把行拆开会静默落空，得到「没抓到」的假象）；做完还原，确认 `git diff` 里没有残留。
4. **真浏览器验证**（涉及界面、布局、滚动、交互时）：jsdom 测不出布局、滚动、输入法、真实终端和真实接线。先构建并同步产物 `pnpm --filter yuanshu-harness-web build && rm -rf packages/server/web && cp -R packages/web/dist packages/server/web`（服务端改了也要 `pnpm --filter yuanshu-harness-server build`），**忘了这一步脚本跑的是旧构建**，现象是「功能没生效」；再 `node scripts/verify-<名>.mjs`，存截图用 `--shots 目录` 或环境变量 `SHOTS=目录`（各脚本不同，看脚本开头）。脚本怎么选、怎么写、浏览器怎么装见 `references/verify-scripts.md`。改了哪一块就跑它和相邻的；设置页框架改动要把设置页那组（`settings`、`providers`、`variables`、`studio`、`remote`、`tools`、`defaults`）都跑一遍。**读截图自己判断品质**，别只信 PASS。
5. **镜像冒烟** `scripts/smoke-image.sh`（要 Docker，数分钟）：改了 `Dockerfile`（含浏览器配方）、`config/docker/` 或浏览器引擎的启动与沙箱方式时跑；含「容器里真开一个页面、沙箱要开着」的用例。网络受限时先 export `DEBIAN_MIRROR` / `PLAYWRIGHT_DOWNLOAD_HOST` / `npm_config_registry`，脚本会按同名 `--build-arg` 传给构建。构建与冒烟放后台时，用 `cmd; echo "exit=$?"` 把退出码写进日志，别信外层任务的「完成」。
6. **本地预览**（看效果用，不替代上面的检查）：脚本与数据目录见 `AGENTS.md`「本地预览」。用 curl 查本机端口时，shell 里设了 `http_proxy` 要加 `--noproxy '*'`（带引号），否则被代理截走回 301 / 502，会误判成服务挂了。
7. **skill 与文档还对不对**：这批改动有没有让某个 `ys-*` 的说明过期（新增或改名的标准件、守卫、脚本、目录约定、刻度与字样、已踩的新坑）？有就**当场改**，别留到以后。

声称做完之前写清楚：没做的、没验证的（没人手点过的、没覆盖的路径、只有单测没有真浏览器的部分）。

## 提交

提交格式、分批、PR 约定见 `CONTRIBUTING.md`。分批提交前先 `git diff --cached --name-only`：`git rm` 掉的旧文件会自动进暂存区，被第一个提交带走；先 `git restore --staged <目录>`，再按批 `git add <具体文件>`，不用 `git add -A`。

## 文档同步

代码改完要让描述它的文档跟上，**一个事实只写一处**：行为 / 模型变了改 `docs/model/` 里对应主题的设计文档，视觉与前端写法变了改 `ys-ui-*` 的 `references/`。找不到该改哪份，先 grep 相关名词。

## 已踩的坑

- **`store/baseline.ts` 改了表结构，已有的数据库不会跟着变**（建表只在全新库上执行）：接口会 500（`no such table`），而且「附属功能不能让动作失败」那类把异常吞掉的写法会让录制类功能悄悄一步都不存。处理就是删数据目录重建，不写迁移（原型期的约定，见 `AGENTS.md`）。验收脚本起的是全新数据目录，测不出这一点。
- **脚本里写死的计数与默认值会随功能过期**：工具总数、新装技能的默认作用域、斜杠命令清单这类写进断言的数字，改了对应功能之后要把受影响的 `verify-*.mjs` 跑一遍。每个 `verify-*.mjs` 都要归进 `check.sh` 的某个阶段（`verify_scripts`），自检会拦住漏接的；缺 Chromium 时真机验收直接失败并打印装法。
- **测试里要建临时目录，一律走 `test/support/tmp-registry.ts` 的 `makeTmpDir`**（细节见 `ys-server`）。`/tmp` 的 inode 被残留占满时，`mkdtemp` 报 `ENOSPC`、全量测试随机失败：先 `df -i /tmp`，`check.sh` 开头在用到 85% 时会直接报错；清存量用 `scripts/clean-test-tmp.sh`（默认只列，`--yes` 才删；靠扫 `/proc`，只在 Linux 上可用）。别把 `TMPDIR` 指到仓库 `tmp/` 下绕过：要起真 Server 的用例会大面积超时，临时目录在仓库里还会让 git 类测试向上找到仓库的 `.git`。
- 在仓库根目录跑 `npx vitest` 会扫进 `node_modules` 里的第三方测试；一律在对应包里跑，或用 `pnpm --filter`。
- 注释或字符串里写 `#` 加 3–8 个十六进制字符（如 `#0042`、`#fff`），色值守卫会当成颜色而红。
- 写文件用绝对路径：相对路径会随 shell 的当前目录漂到别的包里，单目录跑测试看不出来。
- **前端测试要在 `engines` 声明的最低 Node（现为 22.19.0）上也跑一遍**：CI 固定这个版本，本机常是更新的。jsdom 里全局 `Blob` 是 jsdom 的，`Response.blob()`、`new Response(blob)`、`URL.createObjectURL` 在不同 Node 版本表现不同，只在新版本上绿的测试会到 CI 才红。本机没有时：`npm install --prefix <临时目录> node@22.19.0`，再用 `<临时目录>/node_modules/node/bin/node node_modules/vitest/vitest.mjs run`（只能跑 web；server 的原生模块是按本机 Node 编译的）。
- **测试别对本机的 shell 提示符、列目录顺序、吞吐量做假设**：CI 的登录 shell 提示符带几百字符的 OSC 转义序列，`readdir` 不保证字典序，共享 runner 比开发机慢几倍。断言不变量，等待用「看到标记」而不是「看末尾 N 个字符」。
