# ADR-0056：MCP 登记与工具注入

**作者**：bluezeamer
**状态**：Accepted
**日期**：2026-10-20

## 背景

ADR-0008 把 MCP 与 skill 并列为能力集的一部分。Pi SDK 1.3.0 自带 `createMcpExtension`（读 `mcp.json`、`pi.registerMcpServer`），但它按会话各自建连、配置在文件里、凭证只能明文。元枢需要 Server 级集中登记、凭证走密码库（ADR-0033）、多会话共享连接，以及不等 server 在线就能建会话。

## 决策

不用 SDK 自带的 MCP 扩展，由 Server 持有连接，经 `pi.registerTool` 把 MCP 工具注册为自定义工具（与 `workspace-tools` 同一机制）。

- **新依赖**：`@modelcontextprotocol/sdk@1.32.1`（官方 client，支持 stdio 与 streamable-http）；其必需 peer `zod@4.6.7`。均固定精确版本。
- **数据形状**：表 `mcp_servers(name, config, tools, tools_at, ...)`。`config` 为 stdio（command/args/env）或 http（url/headers）；env/headers 每项是明文值，或密码库引用（`secretId`，可带 `prefix` 如 `Bearer `）。库里不落明文凭证，连接时才展开。
- **连接**：每个登记 server 一条共享连接，首次使用时建立，断开后下次调用重连。登记变更或删除时丢弃旧连接。
- **工具缓存**：刷新时把工具列表写回库。会话创建/恢复读缓存；从未缓存过的 server 先连一次，连不上只是没有工具，不阻塞建会话。
- **命名**：`mcp__<server>__<tool>`，非法字符替换为 `_`，超长或撞名时尾部加哈希；server 名限 1–32 位字母数字、`_`、`-`。
- **权限**：MCP 工具名不在内置清单内，沿用现有"未知工具在 auto 档只交人工"的判定，即默认需审批。
- **引用**：生效集合 = agent 级引用 + workspace 级分配，按名字去重。agent 级由 `McpRuntime` 的 `agentMcp` 回调提供，agent 定义接入前缺省为空。

## 范围与取舍

- 只做 Server 侧运行。ADR-0008 中"非全局 MCP 在 workspace 所在环境运行"的形态不做，需要时再扩。
- 非文本结果（图片、音频等）折成一行说明；文本超 40k 字符截断。
- 工具列表只在手动刷新或首次使用时更新，不监听 server 的变更通知。

## 后果

用户可在 UI 登记 MCP server 并分配给 workspace，凭证不落库。代价是引入 MCP SDK 与 zod 两个依赖，并自己维护连接生命周期；换来的是集中管理与凭证隔离。
