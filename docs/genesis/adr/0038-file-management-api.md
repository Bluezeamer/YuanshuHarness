# ADR-0038: 文件管理接口

状态：已定稿
日期：2026-10-20
可逆性：中
取代：无
被取代：——
引用入口：ARCHITECTURE「边界与约定」

## 背景
WebUI 的文件管理与预览 pane 要浏览、读写、预览任意已登记环境上的文件。[ADR-0032](0032-directory-browse-api.md) 的目录浏览只管本机选目录；本篇经 `ExecEnv` 原语覆盖本机与 ssh，并补上写类原语。

## 决定
- **原语**：`ExecEnv` 新增 `readlink`、`rename`、`remove(path, recursive)`，`readStream` 增加字节区间参数，本机与 ssh（sftp）各实现一份，由同一套契约测试覆盖两边。ssh 的 `rename` 优先用 OpenSSH 的 posix-rename 原子替换。
- **接口**：`/api/v1/environments/:envId/files/…`，`envId` 可为 `local`；路径一律是绝对 POSIX 路径，相对路径 400。
  - `GET list?path=&hidden=1`：目录在前再按名字；条目含 `name`、`type`（dir、file、other）、`size`、`mtimeMs`，链接带 `symlink` 目标，悬空链接记为 other 并带 `broken`。最多 10000 项，超出 `truncated:true`。
  - `GET stat?path=`：单项描述。
  - `GET content?path=&download=1&as=text`：按扩展名给 Content-Type，支持单段 `Range`；无 Range 的整体响应上限 64 MB，超出 413（`download=1` 不受限）。文本类（`text/*`、json，含 `as=text`）无 Range 且非下载时只返回前 2 MB，截在完整的 UTF-8 字符边界，带 `X-Truncated: 1` 与 `X-File-Size`；其余部分用 `Range` 取。
  - `PUT content?path=&overwrite=1`：原始 body 流式写到同目录隐藏临时名，写完再 rename 到位；失败或断开不留残文件。已存在且无 `overwrite` 得 409。
  - `POST mkdir {path}`、`POST rename {from,to,overwrite?}`、`DELETE entry?path=&recursive=1`。目录永不被 rename 覆盖，删除非空目录必须显式 `recursive`。
- **预览安全**：所有内容响应带 `X-Content-Type-Options: nosniff` 与 `Cache-Control: no-store`；html 与 svg 加 `Content-Security-Policy: sandbox`；pdf 以 `application/pdf` 内联且不加 sandbox（会让 Chrome 内置查看器失效）；脚本类与 xml 按纯文本给出。
- **权限边界**：调用者是用户本人，不受 agent 权限档位约束；不处理符号链接逃逸。写类操作写审计（`actor=user, kind=file`，[ADR-0037](0037-execution-audit.md)），成功与 IO 失败都记，带耗时，只记操作与路径，不记内容。`PUT`、`mkdir`、`rename`、`DELETE` 可选带 `sessionId`，用来把记录归到会话的审计时间线；缺省或不合法则不归属。

## 理由
- 先写临时名再 rename，读者永远看不到半截文件。
- 下载与预览共用一条读取路径，只靠参数区分，前端少一套契约。

## 影响
- 新增 `api/files.ts`；`env/types.ts`、`env/local.ts`、`env/ssh.ts`、`ssh/connection.ts` 增加原语。
- 排除：文件内容搜索；多段 Range；chmod 与复制。
