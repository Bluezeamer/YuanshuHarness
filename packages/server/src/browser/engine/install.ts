// 找 / 装 Chromium：优先用 playwright-core 自带的 CLI，不自己写下载。
// 浏览器放数据目录下（PLAYWRIGHT_BROWSERS_PATH），下载源可换镜像——国内访问官方源常常不通。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const BROWSER_ENV = "YUANSHU_BROWSER"; // 指向自备可执行文件（优先级最高）
export const AUTO_INSTALL_ENV = "YUANSHU_BROWSER_AUTO_INSTALL"; // 设为 "0" 关闭自动下载
export const MIRROR_ENV = "PLAYWRIGHT_DOWNLOAD_HOST";
const DEFAULT_SOURCE = "Playwright 默认源";

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onLine?: (line: string) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunFn = (
  cmd: string,
  args: string[],
  opts: RunOptions,
) => Promise<RunResult>;

export interface InstallDeps {
  dataDir: string;
  // 下载镜像地址（设置页的值，每次现取）；空则用环境变量或 Playwright 默认源。
  mirror?: () => string | null;
  env?: NodeJS.ProcessEnv; // 默认 process.env
  run?: RunFn; // 子进程执行，测试注入；默认 spawn
}

export class InstallError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(message);
  }
}

export const browsersPath = (dataDir: string): string =>
  path.join(dataDir, "browser");

const PKG = createRequire(import.meta.url).resolve(
  "playwright-core/package.json",
);
const PKG_DIR = path.dirname(PKG);
const CLI = path.join(PKG_DIR, "cli.js");
const INDEX = createRequire(import.meta.url).resolve("playwright-core");

// 用户手填的镜像可能带尾斜杠；Playwright 自己拼路径，去掉更稳。
const cleanMirror = (raw: string | null | undefined): string | null => {
  const v = raw?.trim().replace(/\/+$/, "");
  return v ? v : null;
};

export function downloadSource(deps: InstallDeps): {
  source: string;
  host: string | null;
} {
  const host = cleanMirror(
    deps.mirror?.() || (deps.env ?? process.env)[MIRROR_ENV],
  );
  return { source: host ?? DEFAULT_SOURCE, host };
}

export const defaultRun: RunFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // 下游按行回调进度；进度条用 \r 刷新，所以 \r 也当换行。
    const feed = (chunk: Buffer, sink: "out" | "err") => {
      const text = chunk.toString("utf8");
      if (sink === "out") stdout += text;
      else stderr += text;
      if (!opts.onLine) return;
      for (const line of text.split(/[\r\n]+/))
        if (line.trim()) opts.onLine(line.trim());
    };
    child.stdout?.on("data", (c: Buffer) => feed(c, "out"));
    child.stderr?.on("data", (c: Buffer) => feed(c, "err"));
    child.on("error", (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`找不到 ${cmd}`)
          : err,
      ),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const runOf = (deps: InstallDeps): RunFn => deps.run ?? defaultRun;

// 启动用的环境：只带 PLAYWRIGHT_BROWSERS_PATH（浏览器落在数据目录）。
function browserEnv(
  deps: InstallDeps,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...(deps.env ?? process.env),
    PLAYWRIGHT_BROWSERS_PATH: browsersPath(deps.dataDir),
    ...extra,
  };
}

// Playwright 的浏览器目录是模块加载时从环境变量读的，所以要在子进程里问它装到哪。
const PROBE = `console.log(require(${JSON.stringify(INDEX)}).chromium.executablePath())`;

const cache = new Map<string, string | null>();

export async function findExecutable(
  deps: InstallDeps,
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const own = env[BROWSER_ENV];
  if (own) return existsSync(own) ? own : null;

  const key = browsersPath(deps.dataDir);
  if (cache.has(key)) return cache.get(key) ?? null;
  let found: string | null = null;
  try {
    const r = await runOf(deps)(process.execPath, ["-e", PROBE], {
      env: browserEnv(deps),
    });
    const line = r.stdout.trim().split("\n").pop()?.trim();
    if (r.code === 0 && line && existsSync(line)) found = line;
  } catch {
    found = null; // 探测失败等同于没装，由调用方给安装提示
  }
  cache.set(key, found);
  return found;
}

export async function installChromium(
  deps: InstallDeps,
  onLine?: (line: string) => void,
): Promise<void> {
  mkdirSync(browsersPath(deps.dataDir), { recursive: true, mode: 0o700 });
  const { source, host } = downloadSource(deps);
  const env = browserEnv(deps, host ? { [MIRROR_ENV]: host } : {});
  let result: RunResult;
  try {
    result = await runOf(deps)(
      process.execPath,
      [CLI, "install", "chromium", "--no-shell"],
      { env, onLine },
    );
  } catch (err) {
    throw new InstallError(
      `下载浏览器失败：${err instanceof Error ? err.message : String(err)}\n下载源：${source}\n国内网络可在设置里填浏览器下载镜像，或设置环境变量 ${MIRROR_ENV} 后重试。`,
      source,
    );
  }
  if (result.code !== 0) {
    const tail = `${result.stderr}\n${result.stdout}`
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-6)
      .join("\n");
    throw new InstallError(
      `下载浏览器失败（退出码 ${result.code}）\n下载源：${source}\n${tail}\n国内网络可在设置里填浏览器下载镜像，或设置环境变量 ${MIRROR_ENV} 后重试。`,
      source,
    );
  }
  cache.delete(browsersPath(deps.dataDir));
}
