import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { DEFAULTS, sessionsApi } from "./api/sessions.js";
import type { Config } from "./config.js";
import { prepareDataDir } from "./data-dir.js";
import { type SessionFactory, SessionPool } from "./session/pool.js";
import { type Db, openDatabase } from "./store/db.js";
import { SessionStore } from "./store/sessions.js";

// src/ 与 dist/ 都在包根的下一层，所以源码、构建产物与 npm 安装后得到同样的包根。
const PACKAGE_ROOT = new URL("../", import.meta.url);

export interface ServerOptions {
  webRoot?: string;
  logStream?: { write(msg: string): void };
  // 未提供时会话创建返回 501（真实模型接入在后续能力里）。
  sessionFactory?: SessionFactory;
  // 仅供测试缩短心跳与背压阈值。
  tuning?: Partial<
    Pick<
      Parameters<typeof sessionsApi>[1],
      | "pingIntervalMs"
      | "pongTimeoutMs"
      | "maxBufferedBytes"
      | "maxPendingBytes"
    >
  >;
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
      return within(root, realpathSync(path.join(real, "index.html")));
    }
    return true;
  } catch (err) {
    // 没有 index.html 的目录同样落在这里的 ENOENT：放行，由静态托管返回 404。
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

// 每次调用都新建 Fastify 实例，不使用模块级可变状态，同一进程内可并存多个实例。
// 未处理的 5xx 默认会把 err.message 原样返回，里面可能带本机文件路径；详情只进日志。
export function hideServerErrorDetails(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const status = err.statusCode ?? 500;
  if (status < 500) return reply.send(err);
  req.log.error({ err }, "请求处理失败");
  return reply
    .code(status)
    .send({ statusCode: status, error: "Internal Server Error" });
}

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

  app.setErrorHandler(hideServerErrorDetails);

  let db: Db | null = null;
  app.register(fastifyWebsocket, {
    options: { maxPayload: DEFAULTS.maxPayloadBytes },
    errorHandler: (err, _socket, req) => {
      // ws 对超限、协议错误会自行发关闭帧（如 1009），这里只记录，不再强杀。
      req.log.warn({ err }, "websocket 连接错误");
    },
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
      // 数据库先于监听打开：版本过新或被另一个 Server 占用时直接启动失败。
      db = openDatabase(config.dataDir);
      try {
        const sessionDir = path.join(config.dataDir, "sessions");
        mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        const store = new SessionStore(db);
        const r = store.reconcile(sessionDir, (m) => app.log.warn(m));
        app.log.info(r, "会话索引对账完成");
        const pool = new SessionPool({
          factory: options.sessionFactory ?? null,
          store,
          sessionDir,
        });
        app.register(sessionsApi, { ...DEFAULTS, ...options.tuning, pool });
      } catch (err) {
        db.close();
        db = null;
        throw err;
      }
      if (!isLoopbackHost(config.host)) {
        app.log.warn(
          `监听在非回环地址 ${config.host}，认证尚未生效，能访问该地址的人都可以访问本服务`,
        );
      }
      try {
        await app.listen({ host: config.host, port: config.port });
      } catch (err) {
        db.close();
        db = null;
        throw new Error(
          `无法监听 ${config.host}:${config.port}（${reason(err)}）`,
        );
      }
      const bound = app.server.address() as net.AddressInfo;
      return { host: bound.address, port: bound.port };
    },
    async stop() {
      await app.close();
      db?.close();
      db = null;
    },
  };
}
