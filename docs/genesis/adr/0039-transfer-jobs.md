# ADR-0039: 后台传输任务

状态：已定稿
日期：2026-10-20
可逆性：高
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」

## 背景
M1 的 `POST /api/v1/transfers` 同步等到复制结束，大目录会让请求挂很久，界面也拿不到进度。需要一个能立即返回、可轮询进度的入口。传输方式只走 sftp（经 `ExecEnv` 读写流），不提供 rsync、scp 选择。

## 决定
- **入口**：`POST /api/v1/transfer-jobs`，body 同 `/transfers`（`from`、`to`、`overwrite`、`sessionId`），端点非法 400，否则 202 返回任务；`GET /api/v1/transfer-jobs/:id` 取当前状态，未知 id 404。同步的 `/transfers` 保留。
- **任务形状**：`{id, state: running|done|failed, from, to, sessionId, startedAt, finishedAt?, totalFiles, totalBytes, files, bytes, skippedLinks?, error?}`。扫描阶段 `totalFiles`、`totalBytes` 为 null；之后给出总量，`bytes` 随数据块增长，`files` 在每个文件完成时加一。失败时 HTTP 仍是 200，原因在 `error.code`（`src_missing`、`conflict`、`bad_request`、`copy_failed`）。
- **只在内存**：Server 重启任务即丢；最多保留 100 个，超出丢弃最早的已结束任务，运行中的不丢。
- **审计**：结束时写一条 `kind=transfer`，与同步接口同一格式（`op`、`target`、`result`、`durationMs`、`files`、`bytes`），带 `sessionId` 归属；不含文件内容。

## 理由
- 轮询比再开一条推送通道简单，单用户场景下足够；任务不落库，避免为一次性进度引入迁移。

## 影响
- 新增 `env/transfer-jobs.ts`；`env/transfer.ts` 增加 `onProgress` 回调；`api/environments.ts` 追加两个路由。
- 排除：取消、暂停、断点续传；任务持久化。
