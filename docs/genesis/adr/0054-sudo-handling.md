# ADR-0054: sudo 三类处理与 interactive 判定

状态：实施中  
日期：2026-10-20  
可逆性：中  
取代：无  
被取代：——  
引用入口：[ADR-0007](0007-private-variables.md)；[ADR-0030](0030-permission-rules.md)；[ADR-0051](0051-placeholder-substitution.md)；[ADR-0052](0052-variable-scope-check.md)

## 背景
含 sudo 的命令不交自动审核模型，始终弹给用户（ADR-0030/0031）。ADR-0007 定了方向：优先免密配置；用 `sudo -n -l` 探测；需要密码时经隐私变量注入。本 ADR 记录落地时的具体判定。

## 决定

### 探测
`LC_ALL=C sudo -n -l <命令词…>` 在会话当前环境里执行（本机或 ssh），命令行里每个 sudo 段各探一次再合并：

| 探测结果 | 判定 |
|---|---|
| 退出 0 | `nopasswd` |
| 输出含 `a password is required` | `password` |
| 其余（用法错误、不允许、连接失败、超时） | `unknown` |

合并：任一段 `password` 即 `password`；全部 `nopasswd` 才 `nopasswd`；其余 `unknown`（含无法解析、sudo 不在段首）。`unknown` 不影响原有流程，仍交人工。

缓存键为「环境 id + cwd + 探测脚本」，TTL 60 秒，`unknown` 不缓存。批准执行了 sudo 命令后丢弃该环境的缓存（sudoers 可能被改）。缓存在 `SessionPool` 内，所有会话共享。

### 三类处理（`permission/extension.ts`）
1. **免密**：照常走权限判定；弹窗里加一行“sudo 免密可用”。
2. **需要密码，且命令按 `printf '%s\n' @名字 | sudo -S …` 提供了 sudo 范围的变量**：照常走权限判定（sudo 命令不交审核模型，所以 rules/auto 档弹窗，`full` 档且变量档位为 `full` 才直接放行）；弹窗写明“将使用隐私变量 @名字 作为 sudo 密码，只传给这一条命令”，不显示值。
3. **需要密码，但命令没有提供变量**：不弹窗，直接阻断，把原因和写法返回给模型——有 sudo 变量就列出名字和命令模板，没有就让用户去设置里登记或配置 NOPASSWD。弹窗给人看一个必然失败的命令没有意义。

多个 sudo 变量时不替模型挑，列出全部由模型按用途选。

### root shell
`su`、`sudo -s/-i/--shell/--login`、`sudo bash`（不带 `-c` 的 shell）任何档位都人工审批、不可记住、不交审核模型，弹窗标注警告。`full` 档也不例外（`decide` 里先于档位判断）。解析不了的命令行退回词级粗匹配，宁可多问一次。

### interactive 判定（给 subagent 等无人值守的调用方）
`permission/interactive.ts` 导出：

```ts
isInteractive(command: string, sudo?: SudoState): Promise<
  { interactive: false } | { interactive: true; reason: string }>
```

纯函数，无副作用。`sudo` 参数是命令行里 sudo 的探测结论（`SudoProbe.probe` / `probeCommandLine` 给出），缺省当 `unknown`。规则见文件头注释：root shell、sudo 需要密码且无 `-S`/`-n`、编辑器与全屏程序、无参数的 shell/解释器、ssh 登录或 `-t`、telnet/ftp/sftp、docker/kubectl 的 `-t`；sudo 之后的命令递归判断。只认明确情形，认不出的当非交互，调用方仍需有执行超时兜底。

## 已知局限
- `sudo -n -l` 的输出格式随版本和平台不同；只在 Debian 13（sudo 1.9.16p2）实测过，macOS 等留待实测。`LC_ALL=C` 固定语言，但不处理自定义 `passprompt` 以外的文案差异。
- 单用户场景，不按 `sudo -u` 的目标用户匹配密码。
- 注入密码后命令本身仍可能要求交互确认（如 `apt install` 的 `[Y/n]`），不在本机制范围，由执行超时处理。
- 密码被命令回显由 ADR-0053 遮罩；短于 `MASK_MIN` 的密码不遮罩（ADR-0050 的 `maskable: false`）。
