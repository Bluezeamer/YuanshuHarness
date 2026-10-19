# ADR-0034: 工具按 workspace 的环境路由，路径判定走环境原语

状态：已定稿
日期：2026-10-19
可逆性：难逆
取代：无（扩展 [ADR-0029](0029-minimal-workspace.md) 中“environment_id 本期恒为 local”）
被取代：——
引用入口：ARCHITECTURE「边界与约定」；ROADMAP 第 6 条

## 背景
[ADR-0002](0002-thin-environment-ssh.md) 定了薄环境：工具逻辑在 Server，环境只提供原语。[ADR-0033](0033-secret-store-and-ssh-environments.md) 已有密码库与环境登记。本篇定如何把 read、edit、write、bash、ls、grep、find 路由到 workspace 所属环境，以及 workspace 在会话中途切换时怎样保持工具与权限判定一致。

## 决定
- **环境原语（`ExecEnv`）**：读写字节、建目录、`stat`/`lstat`/`realpath`/`readdir`、取 home、执行带标准输入输出的命令。本机与 ssh 各一个实现；所有环境相关代码只依赖这个接口。
- **连接是 Server 级服务**：每个已登记 ssh 环境一个共享连接，首次使用时建立，掉线后下一次使用重连；会话不持有连接。环境状态（已连接、断开、最近错误）可查询。
- **工具路由**：向会话注册同名的自定义工具覆盖内置的 7 个，每次调用按会话**当前** workspace 的环境取原语，再委托给 SDK 的工具实现（read、edit、write、bash、ls 经其 `operations` 接口）。grep 与 find 的 SDK 实现固定在本机起 `rg`/`fd`，不可替换，所以环境为 ssh 时由本篇的实现经 `exec` 运行 `rg`/`grep` 与 `fd`/`find`，缺 rg/fd 自动退回基础命令。本机环境不传 `operations`，行为与现状一致。
- **路径语义**：ssh 环境的 workspace `path` 就是远程绝对路径，工具参数里的路径同理，不做本机与远程之间的前缀映射。
- **权限判定走同一组原语**：`resolveTarget`、目录判定、敏感文件扫描、只读命令的操作数检查改为异步并接受环境原语，“cwd 内还是外”“符号链接指向哪”由目标环境回答。解析失败仍按 cwd 外处理，不放行。
- **workspace 唯一性**：`path` 不再全局唯一，改为 `(environment_id, path)` 唯一（迁移 v7，重建表）。登记 ssh workspace 时经该环境验证目录存在并取 `realpath`。
- **切换 workspace**：会话持有可变的“当前 workspace”。切换只发生在空闲时，由用户或 agent 的 `switch_workspace` 工具触发（agent 只能切到已登记的 workspace，不能新增）。切换后的第一条用户消息之前，在上下文末尾追加一条固定格式的尾部通知（[ADR-0009](0009-prompt-assembly-injection.md)），不改前面的内容。档位按**切换后**的 workspace 判；`switch_workspace` 本身不弹审批。
- **跨环境传输**：只走 sftp，`transfer` 工具把源 workspace 内的文件或目录复制到目的 workspace，源按读、目的按写各判一次（[ADR-0006](0006-permission-tiers.md)），两边不同档位取较严者。

## 理由
- 路由放在“同名覆盖 + 每次调用取当前环境”，才能在不改 SDK 的前提下支持会话中途换环境。
- 权限判定若仍用本机文件系统，远程路径会被当成本机路径误判，必须与工具共用同一套原语。
- 连接放在 Server 级，多个会话与 WebUI 的文件、终端 pane 才能共用，也满足 ADR-0002 对连接管理的要求。

## 影响
- 迁移 v7：`workspaces` 唯一约束改为 `(environment_id, path)`。
- `permission/paths.ts`、`permission/bash.ts`、`permission/extension.ts` 的文件系统访问改为异步，签名随之变化。
- Windows 环境的路径解析（盘符、大小写不敏感、联接点）仍按 ADR-0002 留给后续；本篇的 ssh 实现只覆盖 POSIX 路径，Windows 路径标注“未验证”。
- 排除：本机与远程之间的路径前缀映射；会话内自动切换环境；agent 登记新 workspace。
