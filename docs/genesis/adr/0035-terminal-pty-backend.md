# ADR-0035: 本机终端的伪终端后端

状态：已定稿
日期：2026-10-20
可逆性：易逆
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」

## 背景
WebUI 的终端 pane 要在 Server 所在机器上拉起交互 shell，需要伪终端（pty）才能正确处理行编辑、颜色、全屏程序和窗口大小。远程终端走 ssh2 的 `shell()`（[ADR-0033](0033-secret-store-and-ssh-environments.md) 的环境连接），不需要本机 pty。本篇只定本机 pty 怎么来。

## 决定
- **依赖**：`@homebridge/node-pty-prebuilt-multiarch@0.14.1`（node-pty 的预编译分发，engines 为 Node `>=20 <27`）。
- **只承诺 Linux**：该包的 tarball 自带 linux-x64/arm64/arm/ia32 的预编译（含 musl，Node ABI 111 至 147）。Server 以 Linux 为目标（VISION），已验证：本机测试、`scripts/smoke-package.sh`（npm 装到仓库外后实际拉起一次 pty）、镜像冒烟。macOS 与 Windows 依赖它的 install 脚本在安装时下载，**未验证**。
- **pnpm 不运行它的安装脚本**：`pnpm-workspace.yaml` 的 `allowBuilds` 里设为 `false`，与现有的 `@google/genai` 等一致；Linux 不需要脚本（预编译随包）。代价是 macOS 上用 pnpm 开发时本机终端不可用（见下），ssh 终端不受影响。
- **懒加载并隔离失败**：首次开本机终端时才 `import`，失败抛 `SpawnError("pty_unavailable")`，接口返回 501，Server 启动与其他功能不受影响。
- **统一后端接口**：本机 pty 与 ssh 通道都适配成 `PtyBackend`（write、resize、kill、onData、onExit），管理器不区分来源。
- **本机 shell**：取 `$SHELL`，缺省 `/bin/bash` 再退到 `/bin/sh`；子进程环境剔除 `YUANSHU_*`，避免访问令牌泄给终端里的程序。

## 理由
- 预编译随包发布，npm 全局安装与 Docker 镜像都不需要 C++ 工具链和 node-gyp，`scripts/check.sh` 的装包与镜像冒烟不受影响。
- 备选的 `script -qfec` 或 python3 `pty` 依赖宿主机命令版本，且窗口大小变化要额外绕路（先改 `stty` 再发 SIGWINCH），行为不如原生 pty 可控。

## 影响
- `packages/server/package.json` 新增一个依赖；锁文件随之更新。
- Windows 远程（Git Bash）的 shell 选择只在代码里处理，标注“未验证”。
- 排除：自行编译 node-pty；macOS 与 Windows 作为 Server 宿主的支持。
