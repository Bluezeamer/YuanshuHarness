import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { Config } from "./config.js";
import { prepareDataDir } from "./data-dir.js";

// src/ 与 dist/ 都在包根的下一层，所以源码、构建产物与 npm 安装后得到同样的包根。
const PACKAGE_ROOT = new URL("../", import.meta.url);

export interface ServerOptions {
  webRoot?: string;
  logStream?: { write(msg: string): void };
}

export interface Address {
  host: string;
  port: number;
}

export interface YuanshuServer {
  start(): Promise<Address>;
  stop(): Promise<void>;
}

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// 只认 127.0.0.0/8 的 IPv4 字面量、::1 与 localhost；拿不准的一律按非回环处理，宁可多警告。
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return net.isIPv4(host) && host.startsWith("127.");
}

const within = (root: string, real: string) =>
  real === root || real.startsWith(root + path.sep);

async function assertWebRoot(webRoot: string): Promise<void> {
  try {
    const root = await realpath(webRoot);
    const index = await realpath(path.join(webRoot, "index.html"));
    if (!within(root, index)) throw new Error("index.html 指向 web 目录之外");
    if (!(await stat(index)).isFile()) throw new Error("index.html 不是文件");
  } catch (err) {
    throw new Error(`web 静态目录不可用：${webRoot}（${reason(err)}）`);
  }
}

// 符号链接可能让请求路径解析到 web 目录之外。@fastify/static 会跟随链接，且对目录请求
// 是先过 allowedPath、之后才拼上 index.html 去读，所以目录请求要把 index.html 也解析进去检查。
// 只有"不存在"才放行（交给静态托管返回 404）；符号链接环等其他错误一律拒绝，免得 500 带出服务器路径。
function isInsideWebRoot(webRoot: string, pathName: string): boolean {
  try {
    const root = realpathSync(webRoot);
    const real = realpathSync(path.join(webRoot, pathName));
    if (!within(root, real)) return false;
    if (statSync(real).isDirectory()) {
      const index = path.join(real, "index.html");
      return !existsSync(index) || within(root, realpathSync(index));
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

// 每次调用都新建 Fastify 实例，不使用模块级可变状态，同一进程内可并存多个实例。
export function createServer(
  config: Config,
  options: ServerOptions = {},
): YuanshuServer {
  const webRoot =
    options.webRoot ?? fileURLToPath(new URL("web", PACKAGE_ROOT));
  const { version } = JSON.parse(
    readFileSync(new URL("package.json", PACKAGE_ROOT), "utf8"),
  ) as { version: string };

  const app = Fastify({
    // 关闭时强制断开所有连接。默认只关"空闲"连接，已连接但没发完请求的连接会让进程一直等下去，
    // 在容器里表现为 docker stop 被强杀（退出码 137）。
    forceCloseConnections: true,
    logger: options.logStream
      ? { level: "info", stream: options.logStream }
      : { level: "info" },
  });

  app.get("/healthz", async () => ({ status: "ok", version }));
  app.register(fastifyStatic, {
    root: webRoot,
    index: ["index.html"],
    wildcard: true,
    redirect: false,
    dotfiles: "deny",
    // @fastify/static 会跟随符号链接；web 目录内指向目录外的链接要拒绝。
    allowedPath: (pathName) => isInsideWebRoot(webRoot, pathName),
  });

  return {
    async start() {
      // 顺序固定：前端缺失时不创建数据目录，数据目录不可用时不监听。
      await assertWebRoot(webRoot);
      await prepareDataDir(config.dataDir);
      if (!isLoopbackHost(config.host)) {
        app.log.warn(
          `监听在非回环地址 ${config.host}，认证尚未生效，能访问该地址的人都可以访问本服务`,
        );
      }
      try {
        await app.listen({ host: config.host, port: config.port });
      } catch (err) {
        throw new Error(
          `无法监听 ${config.host}:${config.port}（${reason(err)}）`,
        );
      }
      const bound = app.server.address() as net.AddressInfo;
      return { host: bound.address, port: bound.port };
    },
    async stop() {
      await app.close();
    },
  };
}
