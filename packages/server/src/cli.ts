import { parseConfig } from "./config.js";
import { createServer } from "./server.js";

export interface Deps {
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  // 触发后停止服务并返回 0；真实进程里由 SIGTERM/SIGINT 触发。
  signal: AbortSignal;
  webRoot?: string;
  logStream?: { write(msg: string): void };
}

const USAGE = `用法：yuanshu serve [选项]

选项（命令行优先于环境变量）：
  --host <地址>      监听地址      环境变量 YUANSHU_HOST       默认 127.0.0.1
  --port <端口>      监听端口      环境变量 YUANSHU_PORT       默认 7420
  --data-dir <目录>  数据目录      环境变量 YUANSHU_DATA_DIR   默认 ~/.yuanshu
  --token <令牌>     访问令牌      环境变量 YUANSHU_TOKEN      至少 32 字符 A-Za-z0-9._~-
                     监听非回环地址时必须提供；推荐用环境变量，命令行会出现在进程列表
  --allow-cidr <列表> 允许的来源网段（逗号分隔） 环境变量 YUANSHU_ALLOW_CIDR  默认不限制
  -h, --help         显示本帮助
`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

// 返回退出码，不直接结束进程，便于在进程内测试。
export async function execute(argv: string[], deps: Deps): Promise<number> {
  const parsed = parseConfig(argv, deps.env, deps.home, deps.cwd);

  if (parsed.kind === "help") {
    deps.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    deps.stderr.write(`yuanshu: ${parsed.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const server = createServer(parsed.config, {
    webRoot: deps.webRoot,
    logStream: deps.logStream,
  });
  try {
    await server.start();
  } catch (err) {
    deps.stderr.write(
      `yuanshu: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT_FAILURE;
  }

  await new Promise<void>((resolve) => {
    if (deps.signal.aborted) resolve();
    else deps.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await server.stop();
  return 0;
}
