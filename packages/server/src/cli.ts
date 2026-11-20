import { mkdirSync } from "node:fs";
import path from "node:path";
import { CLIENT_COMMANDS, runClient } from "./client/command.js";
import { parseConfig } from "./config.js";
import { createServer } from "./server.js";
import { createSessionFactory } from "./session/factory.js";
import { TERMINAL_DEFAULTS } from "./terminal/manager.js";

export interface Deps {
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  stdin?: NodeJS.ReadableStream;
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
  --trusted-origin <列表> 额外放行的页面来源（逗号分隔） 环境变量 YUANSHU_TRUSTED_ORIGINS  默认只认与 Host 一致的
                     反代改写了 Host 又没带 X-Forwarded-Host 时，把对外地址（如 https://ys.example.com）填在这里
  --forward-ports <端口段> 转发出来的服务用的端口段，写成 起-止 环境变量 YUANSHU_FORWARD_PORTS  默认 24100-24199；容器要同样发布这段端口
  --max-terminals <数量> 终端数量上限   环境变量 YUANSHU_MAX_TERMINALS  默认 ${TERMINAL_DEFAULTS.max}
                     终端不会因无人连接而回收，只在关闭、shell 退出或 Server 停止时结束
  -h, --help         显示本帮助

浏览器（环境变量）：
  YUANSHU_BROWSER               指向自备的 Chromium 可执行文件（优先于自动下载）
  YUANSHU_BROWSER_AUTO_INSTALL  设为 0 关闭首次使用时的自动下载
  PLAYWRIGHT_DOWNLOAD_HOST      下载镜像地址（国内访问官方源不通时用；设置 → 浏览器里填的优先）
`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

// 返回退出码，不直接结束进程，便于在进程内测试。
export async function execute(argv: string[], deps: Deps): Promise<number> {
  const [first, ...rest] = argv;
  if ((CLIENT_COMMANDS as readonly string[]).includes(first ?? "")) {
    return runClient(first as string, rest, {
      env: deps.env,
      stdin: deps.stdin ?? process.stdin,
      stdout: deps.stdout,
      stderr: deps.stderr,
      signal: deps.signal,
    });
  }
  const parsed = parseConfig(argv, deps.env, deps.home, deps.cwd);

  if (parsed.kind === "help") {
    deps.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    deps.stderr.write(`yuanshu: ${parsed.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  // 默认 directory 固定为 ~/yuanshu-workspace，不存在则创建。
  const defaultDir = path.join(deps.home, "yuanshu-workspace");
  mkdirSync(defaultDir, { recursive: true });
  const server = createServer(parsed.config, {
    webRoot: deps.webRoot,
    startDir: defaultDir,
    makeSessionFactory: createSessionFactory,
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
