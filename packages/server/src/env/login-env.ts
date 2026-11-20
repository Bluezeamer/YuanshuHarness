// 主机的「登录环境」：agent 的命令与 MCP 进程要像用户直接 ssh 登录那样，找得到 ~/.local/bin、nvm 装的 node 等。
// sshd 的 exec 通道是非登录、非交互 shell，不读 .profile / .bashrc，PATH 只有系统目录。
// 做法：每个环境对象抓一次「交互登录 shell」的环境，与 exec 默认环境做差，只把差异注入每条命令。
const BEGIN = "<<<YS_ENV_BEGIN>>>";
const END = "<<<YS_ENV_END>>>";
// 不含单引号，整段可以直接放进 `sh -c '…'`
const DUMP = `printf "${BEGIN}"; env -0; printf "${END}"`;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 随进程而变、与「登录环境」无关的变量；SSH_ / XDG_SESSION_ 是会话自己的，BASH_FUNC_ 是导出的函数
const VOLATILE = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM", "LS_COLORS"]);
const VOLATILE_PREFIX = ["SSH_", "XDG_SESSION_", "BASH_FUNC_"];
const LOGIN_TIMEOUT_MS = 8000;

/** 执行命令，返回 stdout 与 stderr 合流的输出；超时、被信号终止也照常返回已有的输出，通道出错才抛。 */
export type RunCapture = (
  command: string,
  timeoutMs: number,
) => Promise<Buffer>;

/** 取出两个标记之间的 `env -0` 输出；标记不全返回 null。标记之外的 rc 输出与 stderr 噪声都丢掉。 */
export function parseEnv(out: Buffer): Record<string, string> | null {
  const s = out.toString("utf8");
  const b = s.indexOf(BEGIN);
  const e = s.lastIndexOf(END);
  if (b < 0 || e < b) return null;
  const vars: Record<string, string> = {};
  for (const item of s.slice(b + BEGIN.length, e).split("\0")) {
    const i = item.indexOf("=");
    if (i <= 0) continue;
    const k = item.slice(0, i);
    if (NAME.test(k)) vars[k] = item.slice(i + 1);
  }
  return vars;
}

/** 登录环境里与默认环境不同（新增或改值）的变量，去掉随进程而变的那些。 */
export function diffEnv(
  base: Record<string, string>,
  login: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(login)) {
    if (VOLATILE.has(k) || VOLATILE_PREFIX.some((p) => k.startsWith(p)))
      continue;
    if (base[k] !== v) out[k] = v;
  }
  return out;
}

export interface LoginEnv {
  vars: Record<string, string>;
  /**
   * 两次抓取都真正跑过（哪怕登录 shell 没给出东西）才算完整，可以缓存；
   * 通道层面出错（抛错）则不完整，下次再试，免得一次瞬时故障把「没有登录环境」缓存下来。
   */
  complete: boolean;
}

export async function captureLoginEnv(run: RunCapture): Promise<LoginEnv> {
  try {
    const base = parseEnv(await run(DUMP, LOGIN_TIMEOUT_MS));
    // 连 env -0 都不支持（很老的系统）：没有办法做差，放弃注入
    if (base === null) return { vars: {}, complete: true };
    // 先 -lic（读 .bashrc，nvm 等通常写在这里），rc 脚本把它卡死或截断时退回 -lc
    for (const flags of ["-lic", "-lc"]) {
      const login = parseEnv(
        await run(
          `"\${SHELL:-/bin/sh}" ${flags} '${DUMP}' </dev/null`,
          LOGIN_TIMEOUT_MS,
        ),
      );
      if (login !== null) return { vars: diffEnv(base, login), complete: true };
    }
    return { vars: {}, complete: true };
  } catch {
    return { vars: {}, complete: false };
  }
}
