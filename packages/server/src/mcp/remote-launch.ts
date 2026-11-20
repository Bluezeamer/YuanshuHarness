// 把远端 stdio 服务的启动方式拆成「临时脚本 + 一行 exec」：密钥与环境变量只出现在脚本里（0600 且自删），
// 命令行上看不到它们；脚本里的 `$$` 就是 sshd 给这条 exec 会话建的进程组号，供整组 kill 用。
import { shq } from "../env/ssh.js";

export interface RemoteLaunchInput {
  command: string;
  args: readonly string[];
  /** 远端绝对路径 */
  cwd: string;
  vars: Readonly<Record<string, string>>;
  /** 临时脚本的随机后缀，由调用方给（测试里可固定） */
  nonce: string;
}

export interface RemoteLaunch {
  /** 远端临时脚本路径：/tmp/yuanshu-mcp-<nonce>.sh */
  scriptPath: string;
  /** 脚本内容（含密钥，调用方写成 0600、绝不日志） */
  script: string;
  /** 经 sshd exec 通道执行的那一行命令 */
  shellCommand: string;
}

export const PGID_MARKER = "YUANSHU_PGID=";

// 变量名会原样进脚本，用户配置进来的东西，只放过合法的 shell 标识符。
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function remoteLaunch(i: RemoteLaunchInput): RemoteLaunch {
  if (!/^[A-Za-z0-9]+$/.test(i.nonce)) throw new Error("invalid nonce");
  for (const k of Object.keys(i.vars))
    if (!NAME.test(k))
      throw new Error(`invalid environment variable name: ${k}`);
  const scriptPath = `/tmp/yuanshu-mcp-${i.nonce}.sh`;
  const lines = [
    "#!/bin/sh",
    'rm -f "$0"',
    `echo "${PGID_MARKER}$$" >&2`,
    ...Object.entries(i.vars).map(([k, v]) => `export ${k}=${shq(v)}`),
    // cd 自己会把失败原因写到 stderr
    `cd ${shq(i.cwd)} || exit 1`,
    `exec ${[i.command, ...i.args].map(shq).join(" ")}`,
  ];
  return {
    scriptPath,
    script: `${lines.join("\n")}\n`,
    // sshd 的 exec 是非登录 shell；PATH 等由调用方带来的登录环境快照补上，这里再经登录 shell 兜底快照取不到的主机。
    shellCommand: `exec "\${SHELL:-/bin/sh}" -lc ${shq(`exec sh ${shq(scriptPath)}`)}`,
  };
}
