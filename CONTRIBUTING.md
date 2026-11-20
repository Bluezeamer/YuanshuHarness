# 贡献指南

[English](CONTRIBUTING.en.md) | 中文

谢谢你愿意参与元枢。这份指南讲怎么把改动送进仓库；项目是什么见 [README](README.md)，写代码的约定见 [AGENTS.md](AGENTS.md)，设计依据见 [docs/README.md](docs/README.md)。

## 先聊再做

- 修 bug、补测试、改文档，直接开 PR 即可。
- 新功能、改交互、动数据结构或接口，请先开 issue 说明想法：项目处于早期，设计有很多已定的取舍（写在 `docs/model/`），先对齐能少走弯路。
- 发现安全问题，**不要**开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

- Node ≥ 22.19；pnpm（版本由根 `package.json` 的 `packageManager` 锁定，装任何 ≥ 10 的 pnpm 都会自动切换到它）。
- `pnpm install --frozen-lockfile` 装依赖。
- 跑真浏览器验收脚本要装 Chromium：`pnpm --filter yuanshu-harness-server exec playwright-core install chromium`（网络受限时先设 `PLAYWRIGHT_DOWNLOAD_HOST` 指向镜像）。
- 镜像冒烟需要 Docker。

## 日常开发

```bash
pnpm typecheck && pnpm lint && pnpm test    # 类型、lint、单测
pnpm build                                  # 构建 web 与 server
scripts/preview.sh                          # 构建并起一个本机预览服务，在浏览器里看效果
```

- 在对应的包里跑单个测试：`pnpm --filter yuanshu-harness-web exec vitest run <路径>`（server 同理，包名 `yuanshu-harness-server`）。不要在仓库根目录直接 `npx vitest`，它会把 `node_modules` 里的第三方测试扫进来。
- 界面、布局、滚动、输入法、终端、各处接线这类改动，单测（jsdom）测不出来，要用 `scripts/verify-*.mjs` 真浏览器脚本验证。每个脚本开头的注释写了它验什么；怎么选、怎么写见 [`.agents/skills/ys-delivery/references/verify-scripts.md`](.agents/skills/ys-delivery/references/verify-scripts.md)。
- 提 PR 前跑一遍 `scripts/check.sh`，它与 CI 是同一份（要 Docker 与 Chromium，不能跳过）。只想跑其中一段时给阶段名：`core`（类型、lint、单测、构建、装包冒烟）、`ui-settings`、`ui-chat`、`ui-workspace`、`ui-canvas`、`ui-mobile`、`browser`（真机验收）、`image`（镜像冒烟）；CI 把这些阶段并行跑。新增的 `scripts/verify-*.mjs` 要归进某个阶段，漏接会让自检失败。

## 代码与文档约定

- 先读 [AGENTS.md](AGENTS.md)，再按要改的部分读 `.agents/skills/` 下对应的 skill：前端视觉（`ys-ui-design`）、前端结构（`ys-ui-build`）、后端（`ys-server`）、手机端（`ys-mobile`）、收尾与验收（`ys-delivery`）。它们写的是这个项目的分层、标准件、红线与已踩过的坑。
- 沿用现有风格；不顺手重构、不加没被要求的「灵活性」；改动产生的孤儿代码自己删掉。
- 项目处于早期，不做数据迁移与接口兼容：旧的直接删，不留双轨。
- 行为或设计变了，同步改 `docs/model/` 里对应的文档；改动让某个 skill 过期了，同步改它。一个事实只写一处。
- 仓库公开，不要提交凭据、令牌、内部地址、个人信息（细则见 AGENTS.md）。

## 提交与 PR

- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：`<type>(<scope>): <description>`。
  - type：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `build`。
  - scope 写所在的部分，常见的有 `web`、`server`、`mobile`、`browser`、`forward`、`chat`、`canvas`、`scripts`、`skills`、`docs`。
  - description 用英文祈使句，不超过 72 个字符；破坏性变更写 `type!:` 或加 `BREAKING CHANGE:` footer。
- 语义内聚的一批文件放同一个提交（常见切法：代码与测试 / 验收脚本 / 文档），别把不相干的改动混在一起，也别拆得过细。
- 分支名全小写、连字符分隔，前缀 `feat/` `fix/` `chore/` `refactor/` `test/` `docs/`。
- PR 描述写清：改了什么、为什么、怎么验证的（跑了哪些命令或脚本、结论如何）、没验证到的部分。界面改动请附截图。

## 许可

向本仓库提交的贡献按 [MIT](LICENSE) 授权，不需要签署 CLA。部分代码改写自第三方项目，见 [NOTICE](NOTICE)。
