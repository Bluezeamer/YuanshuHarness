# YuanshuHarness（元枢）

> 元枢 —— 万象之枢，昼夜不怠。

基于 [Pi SDK](https://github.com/earendil-works/pi)（不 fork）的常驻 Agent Server：托管 coding agent 与助理 agent，WebUI、命令行、IM 等客户端共享同一个会话池，随时接入与断开，不打断正在运行的任务。

## 当前状态

早期：只有项目骨架，没有可用功能。设计见 [docs/genesis/VISION.md](docs/genesis/VISION.md)、[docs/genesis/ARCHITECTURE.md](docs/genesis/ARCHITECTURE.md)，路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 本地检查

需要 Node ≥ 22.19（自带 corepack）和 Python ≥ 3.11。pnpm 不需要单独安装：运行一次 `corepack enable`，之后 corepack 会按 `package.json` 里锁定的版本提供它。脚本是 bash，Windows 上用 Git Bash 或 WSL。

```bash
corepack enable   # 只需一次
scripts/check.sh
```

它依次做：前置检查、冻结锁文件安装、类型检查、lint、测试、构建、aisdlc 校验。CI 跑的是同一份。

## 许可

[MIT](LICENSE)
