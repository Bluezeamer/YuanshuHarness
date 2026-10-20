// interactive 判定（ADR-0054）：这条命令会不会停下来等 tty 上的人工输入。
// 给无人值守的调用方（subagent 等）用：判定为交互的命令不该交给它们执行。
//
// 只认明确的情形，认不出的当非交互（调用方仍应有执行超时兜底）：
// - root shell：su、sudo -s/-i、sudo bash（不带 -c）。
// - sudo 需要密码（sudo 参数为 probe 的结论）且没有 -S 也没有 -n。
// - 编辑器与全屏程序：vi vim nvim nano emacs pico top htop btop tmux screen mc ranger
//   （emacs --batch、vim -es、nvim --headless、top -b 除外）。
// - 不带任何参数的 shell / 解释器（bash、python3、node …）：开 REPL。
//   前面有管道或带 < 重定向时 stdin 不是终端，不算。
// - ssh 登录（host 后没有命令）或带 -t；telnet、ftp、sftp。
// - docker/podman run|exec、kubectl exec|run 带 -t / --tty / -it。
// sudo 后面的命令按同样规则递归判断（sudo vim 也是交互）。
import { parseWithConnectors } from "./bash.js";
import { isRootShell, parseSudo, type SudoState } from "./sudo.js";

export type Interactive =
  | { interactive: false }
  | { interactive: true; reason: string };

const EDITORS = new Set(["vi", "vim", "nvim", "nano", "emacs", "pico"]);
const TUIS = new Set(["top", "htop", "btop", "tmux", "screen", "mc", "ranger"]);
const BATCH = /^(--batch|-batch|--headless|-es|-Es)$/;
const REPLS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python3",
  "node",
  "ruby",
  "irb",
  "perl",
  "php",
  "lua",
]);
const NET_CLIENTS = new Set(["telnet", "ftp", "sftp"]);
const WRAPPERS = new Set(["env", "time", "nohup", "exec", "command"]);
// ssh 里带值的短选项：值不是 host 也不是命令。
const SSH_VAL = new Set("bcDEeFIiJLlmOopQRSWw");

interface Part {
  words: string[];
  /** stdin 来自管道或重定向，不是终端。 */
  stdinFed: boolean;
}

const base = (w: string) => w.split("/").pop() ?? "";

async function split(line: string): Promise<Part[]> {
  const r = await parseWithConnectors(line);
  if (r)
    return r.segs.map((words, i) => ({
      words,
      stdinFed: i > 0 && r.conns[i - 1] === "|",
    }));
  // 解析不了（重定向、换行等）：按连接符粗切，词不做引号处理。
  const parts: Part[] = [];
  let piped = false;
  for (const tok of line.split(/(\|\||&&|[;&\n]|\|)/)) {
    if (/^(\|\||&&|[;&\n]|\|)$/.test(tok)) {
      piped = tok === "|";
      continue;
    }
    const words = tok.trim().split(/\s+/).filter(Boolean);
    if (words.length > 0)
      parts.push({ words, stdinFed: piped || /</.test(tok) });
    piped = false;
  }
  return parts;
}

function ssh(args: string[]): string | null {
  const pos: string[] = [];
  let tty = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as string;
    if (pos.length > 0) {
      pos.push(w);
      continue;
    }
    if (!w.startsWith("-")) {
      pos.push(w);
      continue;
    }
    if (/^-[a-zA-Z0-9]*t/.test(w)) tty = true;
    const last = w[w.length - 1] as string;
    if (w.length === 2 && SSH_VAL.has(last)) i++;
  }
  if (tty) return "ssh 带 -t 会分配终端";
  return pos.length === 1 ? "ssh 登录远端 shell" : null;
}

function inner(words: string[], stdinFed: boolean): string | null {
  let i = 0;
  while (
    i < words.length &&
    (WRAPPERS.has(base(words[i] as string)) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string))
  )
    i++;
  const cmd = base(words[i] ?? "");
  const args = words.slice(i + 1);
  if (!cmd) return null;
  if (EDITORS.has(cmd))
    return args.some((a) => BATCH.test(a)) ? null : `${cmd} 是编辑器`;
  if (TUIS.has(cmd)) {
    if (cmd === "top" && args.some((a) => /^-[a-zA-Z0-9]*b/.test(a)))
      return null;
    return `${cmd} 是全屏程序`;
  }
  if (REPLS.has(cmd) && args.length === 0 && !stdinFed)
    return `${cmd} 不带参数会开交互界面`;
  if (NET_CLIENTS.has(cmd) && !stdinFed) return `${cmd} 是交互式客户端`;
  if (cmd === "ssh" && !stdinFed) return ssh(args);
  const tty = args.some(
    (a) => a === "--tty" || /^-[a-zA-Z]*t[a-zA-Z]*$/.test(a),
  );
  const detached = args.some(
    (a) => a === "--detach" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a),
  );
  if (
    tty &&
    !detached &&
    (((cmd === "docker" || cmd === "podman") &&
      ["run", "exec"].includes(args[0] ?? "")) ||
      (cmd === "kubectl" && ["exec", "run"].includes(args[0] ?? "")))
  )
    return `${cmd} ${args[0]} 带 -t 会分配终端`;
  return null;
}

/**
 * @param sudo 命令行里 sudo 的探测结论（SudoProbe / probeCommandLine 给出）；缺省当认不出。
 */
export async function isInteractive(
  command: string,
  sudo: SudoState = "unknown",
): Promise<Interactive> {
  if (await isRootShell(command))
    return { interactive: true, reason: "会打开 root shell" };
  for (const { words, stdinFed } of await split(command)) {
    const s = parseSudo(words);
    if (s) {
      if (sudo === "password" && !s.stdin && !s.noPrompt)
        return {
          interactive: true,
          reason: "sudo 需要密码，且没有用 -S 从标准输入提供",
        };
      const reason = inner(s.cmd, stdinFed);
      if (reason) return { interactive: true, reason };
      continue;
    }
    const reason = inner(words, stdinFed);
    if (reason) return { interactive: true, reason };
  }
  return { interactive: false };
}
