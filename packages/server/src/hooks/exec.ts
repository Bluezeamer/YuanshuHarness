import { spawn } from "node:child_process";

// hook 子进程的执行器（ADR-0086）：shell 一整行、载荷走 stdin、环境白名单、超时强杀整个进程组。

export const OUTPUT_MAX = 64 * 1024;

// 只传这些：不继承 Server 的环境，访问令牌、密钥之类不会进 hook。
const ENV_KEEP = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
] as const;

export function hookEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

export interface ExecInput {
  command: string;
  /** 写进 stdin 的 JSON 文本。 */
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface ExecResult {
  /** 被信号终止或根本没启动时为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 启动失败或被信号杀死的说明；超时单独用 timedOut 表示。 */
  error?: string;
  durationMs: number;
}

// 同一进程组一并杀掉（shell 会再起子进程）；Windows 没有进程组，只能杀 shell 本身（未验证）。
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // 进程组已不存在，走兜底
    }
  }
  fallback();
}

export function runCommand(input: ExecInput): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: Omit<ExecResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const child = spawn(input.command, {
      shell: true,
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
    }, input.timeoutMs);
    const collect = (cur: string, chunk: Buffer) =>
      cur.length >= OUTPUT_MAX
        ? cur
        : (cur + chunk.toString("utf8")).slice(0, OUTPUT_MAX);
    child.stdout.on("data", (c: Buffer) => {
      stdout = collect(stdout, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = collect(stderr, c);
    });
    // hook 不读 stdin 就退出会得到 EPIPE，不是错误。
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin);
    child.on("error", (err) =>
      done({
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        error: `无法启动：${err.message}`,
      }),
    );
    child.on("close", (code, signal) =>
      done({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        ...(code === null && !timedOut
          ? { error: `被信号终止：${signal ?? "未知"}` }
          : {}),
      }),
    );
  });
}
