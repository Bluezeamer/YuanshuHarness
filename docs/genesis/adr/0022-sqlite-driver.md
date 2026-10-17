# ADR-0022: SQLite 驱动：better-sqlite3

状态：已定稿
日期：2026-10-17
可逆性：难逆
取代：无
被取代：——
引用入口：ARCHITECTURE「技术选型」存储一行；ROADMAP 第 3 条

## 背景
[ADR-0004](0004-state-storage-recovery.md) 定了 Server 状态放 SQLite，没有选驱动。驱动的 API 会遍布所有持久化代码，更换要改全部调用点，且它是新的外部依赖，所以难逆。

2026-10-17 实测（Node 22.19.0 与 24.13.1，临时目录，未改仓库）：
| | `node:sqlite` | `better-sqlite3` 13.0.3 |
|---|---|---|
| 依赖 | 内置 | `node-addon-api`；包内自带预编译（linux x64/arm64 的 glibc 与 musl、macOS、Windows），无安装脚本、不联网、无需编译工具，约 12 MB |
| Node 22.19 | 可用，SQLite 3.50.4 | `engines` 为 `>=22` |
| Node 24 | 可用，SQLite 3.51.2 | 可用，SQLite 3.53.4 |
| 稳定性 | Node 文档标 1.1 Active Development，两个版本都打印 ExperimentalWarning | 成熟，事实标准 |

调研（pi 检索，未独立复核）称 better-sqlite3 在 Node 24 存在预编译缺口；实测不成立。

## 候选方案
### 方案 A：`node:sqlite`
零依赖。代价：API 可能随 Node 版本变化，每次启动打印实验性警告。
### 方案 B：`better-sqlite3`
同步接口，API 稳定。代价：多一个依赖与约 12 MB 的预编译文件。

## 决定
方案 B。精确锁定版本，升级随核对变更说明与 Node 兼容性进行。

## 理由
- SQLite 将承载规则、密码库、审批队列等关键状态，不应建在实验性 API 上。
- 预编译随包携带，对 npm 包与镜像构建的影响很小。

## 影响
- 新增一个运行时依赖；镜像与 npm 包体积增加约 12 MB。
- 驱动是同步的，写入在事件循环线程上执行；表小、本机单用户，本期可接受，出现瓶颈再评估。
- 排除：`node:sqlite`（待其稳定后可作为单独变更重新评估）。
