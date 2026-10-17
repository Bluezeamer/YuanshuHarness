# Intent: 主干（四）最小命令行客户端
Author: bluezeamer
Status: closed
Date: 2026-10-17
Lane: build
Why: 不新增协议、持久化形状或鉴权规则，只是 ADR-0021/0024/0026 的第一个真实消费者，出错时当场可见，revert 一个提交可恢复，所以不是决策档；命中"静默"（序号缺口、重连、乱序、依赖 Node 全局 WebSocket 的真实行为），按标准档加固。

## Links
来源: ROADMAP 第 3 条（主干）的最后一块
上游: [ROADMAP](../../../ROADMAP.md)、[ADR-0019](../../../genesis/adr/0019-release-artifacts.md)、[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)、[ADR-0024](../../../genesis/adr/0024-session-rest-and-history.md)、[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)
下游: 定稿后回填

## Problem
Server 的会话、事件流、持久化、认证都已合入，但只有测试里的客户端说过这套协议。没有真实客户端，下面几件事没有被端到端验证过：令牌从启动参数到 WebSocket 子协议的整条路径、快照与事件的衔接、缺口后的 `resync`、排队与 `stop` 在人手操作下的表现。
ADR-0019 已把 `yuanshu serve` 之外的子命令留给命令行客户端。

已核对的一个事实：真实的 `yuanshu serve` 在第 7 条之前没有会话工厂，`POST /api/v1/sessions` 返回 501（[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)）。所以本期客户端对着真实 Server 只能列会话、接入已有会话，**无法创建会话**；创建与对话的端到端验证只能在测试里对着注入了 stub 工厂的 Server 做。

## Proposed outcome
- `yuanshu` 新增三个子命令：`sessions`（列出）、`new`（创建并打印标识）、`attach <id>`（接入会话：先显示最近窗口，再接上实时流，输入一行发一条消息）。
- 客户端只用 Node 内置的 `fetch` 与 `WebSocket`，不新增依赖；令牌来自环境变量，经子协议送出，不落盘。
- 序号出现缺口时自动发 `resync`，不需要用户干预。
- 对着 stub Server 的端到端测试覆盖：认证通过与被拒、快照衔接、排队、`stop`、缺口恢复、断线后重新接入。

## Out of scope
- 自动重连：连接断开时报告原因并以非零码退出，重新接入靠用户再执行 `attach`（会得到新的快照）。
- 创建会话的真实能力（第 7 条）；删除、重命名、翻页读历史（REST 已有，客户端本期不接）。
- 图片发送、多行输入、思考增量展示、颜色与全屏界面（TUI 最后做，[ADR-0013](../../../genesis/adr/0013-tech-stack.md)）。
- 弹窗审批与提问（依赖权限层，第 5 条）。

## Constraints
- 子命令挂在 `yuanshu` 下，`serve` 的参数与行为不变（[ADR-0019](../../../genesis/adr/0019-release-artifacts.md)）。
- 只说 `/api/v1` 现有协议，不为客户端改协议；发现协议缺陷按 `v1` 内只增不改处理（[ADR-0021](../../../genesis/adr/0021-session-wire-protocol.md)）。
- 令牌不得出现在输出、错误信息、日志里（[ADR-0026](../../../genesis/adr/0026-access-token-and-source-network.md)）。

## Decisions
以下 5 项均按建议采纳（bluezeamer，2026-10-17）。

1. **子命令名**：`sessions` / `new` / `attach`，还是别的。建议：就用这三个，短、不与 `serve` 冲突，发布前可改。
2. **令牌来源**：只读环境变量 `YUANSHU_TOKEN`，还是也接受 `--token`。建议：只读环境变量。命令行会出现在进程列表（服务端 `--token` 的文档已有同样提醒），客户端没有"必须用命令行"的场景。
3. **服务地址**：`--url` 参数与 `YUANSHU_URL` 环境变量，默认 `http://127.0.0.1:7420`。建议：照此，命令行优先于环境变量，与 [ADR-0018](../../../genesis/adr/0018-startup-params-and-health-endpoint.md) 一致。
4. **标准输入结束（EOF）的含义**：建议：等当前运行与队列清空后以 0 退出，这样 `echo 问题 | yuanshu attach <id>` 可用于脚本和测试；交互时 Ctrl-C 直接退出（会话继续运行）。
5. **按 `/stop`、`/quit` 识别控制行**：输入行以 `/stop` 发 `stop`，以 `/quit` 退出，其余行都当消息发。建议：照此，不做更多斜杠命令。

## Open questions
- Node 全局 `WebSocket` 对子协议和 1009/1013 关闭码的暴露方式，实现前用探测确认（plan 步骤 1）。
