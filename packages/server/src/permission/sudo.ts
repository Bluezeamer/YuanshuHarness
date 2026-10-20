// sudo 处理（ADR-0054）：解析 sudo 段、识别直接开 root shell 的写法、`sudo -n -l` 探测与缓存。
import { shq } from "../env/ssh.js";
import type { ExecEnv } from "../env/types.js";
import { isSudoWord, parseCommand } from "./bash.js";

export interface SudoSeg {
  /** `-S` / `--stdin`：从标准输入读密码。 */
  stdin: boolean;
  /** `-s` / `-i` / `--shell` / `--login`：开 shell。 */
  shell: boolean;
  /** `-n` / `--non-interactive`：需要密码时直接失败，不会等输入。 */
  noPrompt: boolean;
  /** 选项与 VAR=value 之后的命令词。 */
  cmd: string[];
}

// 带值的短选项（-u root、-p prompt …）与长选项；其余按开关处理。
const SHORT_VAL = new Set("CDghpRrTtUu");
const LONG_VAL = new Set([
  "--close-from",
  "--chdir",
  "--group",
  "--host",
  "--prompt",
  "--chroot",
  "--role",
  "--command-timeout",
  "--type",
  "--other-user",
  "--user",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const base = (w: string) => w.split("/").pop() ?? "";

/** 解析以 sudo 开头的命令段；不是 sudo 返回 null。 */
export function parseSudo(seg: string[]): SudoSeg | null {
  if (!isSudoWord(seg[0] ?? "")) return null;
  const r: SudoSeg = { stdin: false, shell: false, noPrompt: false, cmd: [] };
  let i = 1;
  for (; i < seg.length; i++) {
    const w = seg[i] as string;
    if (w === "--") {
      i++;
      break;
    }
    if (!w.startsWith("-") || w === "-") break;
    if (w.startsWith("--")) {
      if (w === "--stdin") r.stdin = true;
      else if (w === "--non-interactive") r.noPrompt = true;
      else if (w === "--shell" || w === "--login") r.shell = true;
      else if (LONG_VAL.has(w)) i++;
      continue;
    }
    // 短选项簇：遇到带值的字母，其后部分（或下一个词）就是值。
    for (let k = 1; k < w.length; k++) {
      const c = w[k] as string;
      if (SHORT_VAL.has(c)) {
        if (k === w.length - 1) i++;
        break;
      }
      if (c === "S") r.stdin = true;
      if (c === "n") r.noPrompt = true;
      if (c === "s" || c === "i") r.shell = true;
    }
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i] ?? "")) i++;
  r.cmd = seg.slice(i);
  return r;
}

/**
 * 直接开 root shell：`su`、`sudo -s/-i`、`sudo bash` 这类不带 -c 的 shell。
 * 解析不了的命令行退回粗匹配：宁可多问一次。
 */
export async function isRootShell(line: string): Promise<boolean> {
  const segs = await parseCommand(line);
  if (!segs) {
    const t = line.split(/[\s;|&<>()'"`]+/).filter(Boolean);
    const i = t.findIndex(isSudoWord);
    return (
      t.some((w) => base(w) === "su") ||
      (i >= 0 &&
        t
          .slice(i + 1)
          .some(
            (w) =>
              /^-[a-zA-Z]*[si]$/.test(w) ||
              w === "--shell" ||
              w === "--login" ||
              SHELLS.has(base(w)),
          ))
    );
  }
  return segs.some((s) => {
    if (base(s[0] ?? "") === "su") return true;
    const p = parseSudo(s);
    if (!p) return false;
    if (p.shell) return true;
    const first = base(p.cmd[0] ?? "");
    return (
      SHELLS.has(first) && !p.cmd.slice(1).some((a) => /^-[a-zA-Z]*c/.test(a))
    );
  });
}

/** 探测结论：免密可用 / 需要密码 / 认不出（交人工）。 */
export type SudoState = "nopasswd" | "password" | "unknown";

const TTL_MS = 60_000;
const PROBE_TIMEOUT_S = 10;

/**
 * `sudo -n -l <命令>` 探测（ADR-0007）：退出 0 为免密；输出含 “a password is required” 为需要密码；
 * 其余（用法错误、不允许、连接失败）认不出。LC_ALL=C 固定输出语言，不依赖翻译。
 * 结果按「环境 + cwd + 命令」缓存，TTL 到期或 invalidate 后重探；认不出的不缓存。
 */
export class SudoProbe {
  private readonly cache = new Map<string, { state: SudoState; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async probe(env: ExecEnv, cwd: string, args: string[]): Promise<SudoState> {
    const script = `LC_ALL=C sudo -n -l ${args.map(shq).join(" ")}`;
    const key = `${env.id}\0${cwd}\0${script}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.state;
    const chunks: Buffer[] = [];
    let state: SudoState = "unknown";
    try {
      const r = await env.exec(script, cwd, {
        onData: (d) => chunks.push(d),
        timeout: PROBE_TIMEOUT_S,
      });
      const out = Buffer.concat(chunks).toString("utf8");
      if (r.exitCode === 0) state = "nopasswd";
      else if (/a password is required/i.test(out)) state = "password";
    } catch {
      return "unknown";
    }
    if (state !== "unknown") this.cache.set(key, { state, at: this.now() });
    return state;
  }

  /** 环境的 sudoers 可能变了（批准了 sudo 命令、环境被改或删）：丢掉该环境的缓存，缺省全清。 */
  invalidate(envId?: string): void {
    if (envId === undefined) this.cache.clear();
    else
      for (const k of this.cache.keys())
        if (k.startsWith(`${envId}\0`)) this.cache.delete(k);
  }
}

/**
 * 命令行里每个 sudo 段各探测一次再合并：任一需要密码即「需要密码」，全部免密才「免密」，
 * 其余（含无法解析、sudo 不在段首）认不出。
 */
export async function probeCommandLine(
  probe: (cwd: string, args: string[]) => Promise<SudoState>,
  line: string,
  cwd: string,
): Promise<SudoState> {
  const segs = await parseCommand(line);
  if (!segs) return "unknown";
  const states = await Promise.all(
    segs
      .filter((s) => isSudoWord(s[0] ?? ""))
      .map((s) => probe(cwd, s.slice(1))),
  );
  if (states.length === 0) return "unknown";
  if (states.includes("password")) return "password";
  return states.every((s) => s === "nopasswd") ? "nopasswd" : "unknown";
}
