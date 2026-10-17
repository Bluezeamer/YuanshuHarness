import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
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

async function assertWebRoot(webRoot: string): Promise<void> {
  const index = path.join(webRoot, "index.html");
  try {
    if (!(await stat(index)).isFile()) throw new Error("不是文件");
  } catch (err) {
    throw new Error(`web 静态目录不可用：${webRoot}（${reason(err)}）`);
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
    serveDotFiles: false,
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
