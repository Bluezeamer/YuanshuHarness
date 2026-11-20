import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ClientChannel } from "ssh2";

// 终端后端：本机 pty 与 ssh shell 通道抹平成同一组操作，管理器不关心来源。
export interface PtyBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** 停止读取输出：pty 内核缓冲写满后子进程写 stdout 会阻塞，ssh 通道不再放大窗口让对端阻塞；shell 本身不受影响。 */
  pause(): void;
  resume(): void;
  /** 前台是否有 shell 之外的进程；无法判断（ssh）返回 null。 */
  busy(): boolean | null;
  onData(cb: (chunk: Buffer) => void): void;
  /** exitCode 为 null 表示被信号终止。 */
  onExit(cb: (exitCode: number | null) => void): void;
}

export class SpawnError extends Error {
  constructor(
    readonly code: "pty_unavailable" | "spawn_failed",
    message: string,
  ) {
    super(message);
  }
}

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

type NodePty = typeof import("@homebridge/node-pty-prebuilt-multiarch");
let ptyModule: Promise<NodePty> | undefined;

// 懒加载：原生模块加载失败（没有对应平台的预编译）只让本机终端不可用，不拖垮 Server 启动。
function loadPty(): Promise<NodePty> {
  ptyModule ??= import("@homebridge/node-pty-prebuilt-multiarch");
  ptyModule.catch(() => {
    ptyModule = undefined;
  });
  return ptyModule;
}

// Server 以 Linux 为目标（VISION）；本机 shell 取用户登录 shell。
function localShell(): string {
  return (
    process.env.SHELL ?? (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh")
  );
}

export async function openLocal(opts: {
  cols: number;
  rows: number;
  cwd?: string;
}): Promise<PtyBackend & { pid: number }> {
  let pty: NodePty;
  try {
    pty = await loadPty();
  } catch (err) {
    throw new SpawnError("pty_unavailable", `本机伪终端不可用：${reason(err)}`);
  }
  // 终端里的程序不应拿到 Server 自己的访问令牌等配置。
  const env: Record<string, string> = { COLORTERM: "truecolor" };
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("YUANSHU_")) env[k] = v;
  const shell = localShell();
  let term: ReturnType<NodePty["spawn"]>;
  try {
    term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? homedir(),
      env,
    });
  } catch (err) {
    throw new SpawnError("spawn_failed", `启动本机 shell 失败：${reason(err)}`);
  }
  return {
    pid: term.pid,
    write: (d) => term.write(d),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: () => term.kill(),
    pause: () => term.pause(),
    resume: () => term.resume(),
    // 前台进程组的名字不是 shell 自己，说明有命令在跑。
    busy: () => path.basename(term.process) !== path.basename(shell),
    onData: (cb) => {
      term.onData((d) => cb(Buffer.from(d)));
    },
    onExit: (cb) => {
      term.onExit((e) => cb(e.signal ? null : e.exitCode));
    },
  };
}

export function fromChannel(ch: ClientChannel): PtyBackend {
  let code: number | null = null;
  return {
    write: (d) => {
      ch.write(d);
    },
    resize: (cols, rows) => {
      ch.setWindow(rows, cols, 0, 0);
    },
    kill: () => {
      ch.close();
    },
    pause: () => {
      ch.pause();
    },
    resume: () => {
      ch.resume();
    },
    busy: () => null,
    onData: (cb) => {
      ch.on("data", cb);
    },
    onExit: (cb) => {
      // exit 携带退出码或信号；close 在通道彻底关闭后触发，两者都要等。
      ch.on("exit", (c: number | null | undefined) => {
        code = typeof c === "number" ? c : null;
      });
      ch.once("close", () => cb(code));
    },
  };
}
