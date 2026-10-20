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
import { agentsApi } from "./api/agents.js";
import { browserApi } from "./api/browser.js";
import { auditApi } from "./api/audit.js";
import { environmentsApi } from "./api/environments.js";
import { filesApi } from "./api/files.js";
import { fsApi } from "./api/fs.js";
import { mcpApi } from "./api/mcp.js";
import { modelsApi } from "./api/models.js";
import { promptApi } from "./api/prompt.js";
import { DEFAULTS, sessionsApi } from "./api/sessions.js";
import { skillsApi } from "./api/skills.js";
import { terminalsApi } from "./api/terminals.js";
import { topologyApi } from "./api/topology.js";
import { variablesApi } from "./api/variables.js";
import { workbenchApi } from "./api/workbench.js";
import { workspacesApi } from "./api/workspaces.js";
import { createAuthHook, type RateLimitOptions } from "./auth.js";
import type { Config } from "./config.js";
import { prepareDataDir } from "./data-dir.js";
import { EnvHub } from "./env/hub.js";
import { BrowserManager } from "./browser/manager.js";
import { McpRuntime } from "./mcp/runtime.js";
import type { ReviewerFactory } from "./permission/review.js";
import { GlobalConventions } from "./prompt/conventions.js";
import { SEED_AGENTS, SEED_BLOCKS } from "./prompt/seeds.js";
import { PromptService } from "./prompt/service.js";
import { type SessionFactory, SessionPool } from "./session/pool.js";
import { SkillRuntime } from "./skills/runtime.js";
import { AgentStore } from "./store/agents.js";
import { AuditLog } from "./store/audit.js";
import { BlockStore } from "./store/blocks.js";
import { CapabilityStore } from "./store/capabilities.js";
import { type Db, openDatabase } from "./store/db.js";
import { EnvironmentStore } from "./store/environments.js";
import { McpStore } from "./store/mcp.js";
import { ModelStore } from "./store/models.js";
import { RuleStore } from "./store/rules.js";
import { loadMasterKey, SecretStore } from "./store/secrets.js";
import { SessionStore } from "./store/sessions.js";
import { SkillStore } from "./store/skills.js";
import { SubagentStore } from "./store/subagents.js";
import { WorkbenchStore } from "./store/workbench.js";
import { WorkspaceStore } from "./store/workspaces.js";
import { SubagentRuntime } from "./subagent/runtime.js";
import { TerminalManager, type TerminalOptions } from "./terminal/manager.js";

// src/ 与 dist/ 都在包根的下一层，所以源码、构建产物与 npm 安装后得到同样的包根。
const PACKAGE_ROOT = new URL("../", import.meta.url);

export interface ServerOptions {
  webRoot?: string;
  logStream?: { write(msg: string): void };
  // 未提供时会话创建返回 501（真实模型接入在后续能力里）。
  sessionFactory?: SessionFactory;
  // 需要服务内依赖（模型登记、密码库）时用它构造工厂；与 sessionFactory 二选一。
  makeSessionFactory?: (deps: {
    models: ModelStore;
    secrets: SecretStore;
    agentDir: string;
  }) => SessionFactory;
  // 注入的审核会话工厂（ADR-0031）；未提供时 auto 档同 rules。
  reviewerFactory?: ReviewerFactory;
  // 仅供测试缩短审核超时。
  reviewTimeoutMs?: number;
  // 首次启动登记为默认 workspace 的目录；缺省取进程工作目录。
  startDir?: string;
  // 仅供测试缩短终端的数量上限、空闲回收与回放缓冲。
  terminals?: Partial<TerminalOptions>;
  // 仅供测试注入限流的时钟与数值。
  authLimiter?: Partial<RateLimitOptions>;
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

const WS_PROTOCOL = "yuanshu.v1";

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

  app.setErrorHandler(hideServerErrorDetails);

  let db: Db | null = null;
  let envHub: EnvHub | null = null;
  let mcpRuntime: McpRuntime | null = null;
  let browserManager: BrowserManager | null = null;
  app.register(fastifyWebsocket, {
    options: {
      maxPayload: DEFAULTS.maxPayloadBytes,
      // ws 默认回显客户端的第一个子协议，会把 bearer.<令牌> 原样写回响应头，所以只选 yuanshu.v1。
      handleProtocols: (protocols) =>
        protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false,
    },
    errorHandler: (err, _socket, req) => {
      // ws 对超限、协议错误会自行发关闭帧（如 1009），这里只记录，不再强杀。
      req.log.warn({ err }, "websocket 连接错误");
    },
  });
  // 必须在根作用域同步注册，才排在 @fastify/websocket 默认 preClose 之前；
  // 它的 client.close() 不带状态码，客户端会看到 1005 而不是 1001。
  app.addHook("preClose", async function () {
    for (const client of this.websocketServer?.clients ?? [])
      client.close(1001, "server_shutdown");
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
      // 先于任何副作用：非回环监听必须有令牌。错误信息不含令牌值。
      if (!isLoopbackHost(config.host) && config.token === undefined) {
        throw new Error(
          `监听在非回环地址 ${config.host} 必须配置访问令牌：请使用 --token 或环境变量 YUANSHU_TOKEN`,
        );
      }
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
        const workspaces = new WorkspaceStore(db);
        const rules = new RuleStore(db);
        const created = workspaces.ensureDefault(
          options.startDir ?? process.cwd(),
        );
        if (created)
          app.log.info({ path: created.path }, "已登记默认 workspace");
        const secrets = new SecretStore(
          db as Db,
          loadMasterKey(config.dataDir),
        );
        const models = new ModelStore(config.dataDir);
        const agentDir = path.join(config.dataDir, "agent");
        const environments = new EnvironmentStore(db as Db);
        const hub = new EnvHub(environments, secrets);
        envHub = hub;
        const audit = new AuditLog(db as Db);
        const blocks = new BlockStore(db as Db);
        const agents = new AgentStore(db as Db);
        blocks.seed(SEED_BLOCKS);
        agents.seed(SEED_AGENTS);
        const conventions = new GlobalConventions(config.dataDir);
        const skills = new SkillStore(
          db as Db,
          path.join(config.dataDir, "skills"),
        );
        const capabilities = new CapabilityStore(db as Db);
        const skillRuntime = new SkillRuntime({ skills, capabilities });
        const mcpStore = new McpStore(db as Db);
        const mcp = new McpRuntime({ mcp: mcpStore, secrets, capabilities });
        mcpRuntime = mcp;
        const subagentStore = new SubagentStore(db as Db);
        const browser = new BrowserManager();
        browserManager = browser;
        const pool = new SessionPool({
          audit,
          agents,
          prompts: new PromptService(blocks, conventions),
          envHub: hub,
          environments,
          secrets,
          skills: skillRuntime,
          mcp,
          browser,
          subagents: subagentStore,
          factory:
            options.sessionFactory ??
            options.makeSessionFactory?.({ models, secrets, agentDir }) ??
            null,
          ...(options.reviewerFactory
            ? { reviewerFactory: options.reviewerFactory }
            : {}),
          ...(options.reviewTimeoutMs
            ? { reviewTimeoutMs: options.reviewTimeoutMs }
            : {}),
          store,
          workspaces,
          rules,
          sessionDir,
        });
        // 先于监听：上一进程里还在跑的子会话在这里落成 interrupted。
        pool.attachSubagents(
          new SubagentRuntime({
            pool,
            store: subagentStore,
            workspaces,
            agents,
            models,
            sessionDir,
          }).hooks(),
        );
        const { hook } = createAuthHook({
          ...(config.token === undefined ? {} : { token: config.token }),
          allowCidrs: config.allowCidrs,
          ...(options.authLimiter ? { limiter: options.authLimiter } : {}),
        });
        // 认证只包住 /api/v1；/healthz 与静态资源在作用域之外。
        app.register(async (scope) => {
          scope.addHook("onRequest", hook);
          scope.register(sessionsApi, { ...DEFAULTS, ...options.tuning, pool });
          scope.register(workspacesApi, { workspaces, rules, pool, hub });
          scope.register(environmentsApi, {
            environments,
            secrets,
            hub,
            audit,
          });
          scope.register(auditApi, { audit });
          scope.register(topologyApi, { pool, subagents: subagentStore });
          scope.register(filesApi, { hub, audit });
          scope.register(terminalsApi, {
            hub,
            manager: new TerminalManager(audit, options.terminals),
            ...options.tuning,
          });
          scope.register(modelsApi, { models, secrets, agentDir });
          scope.register(agentsApi, { agents, pool });
          scope.register(promptApi, {
            blocks,
            conventions,
            agents,
            workspaces,
            pool,
          });
          scope.register(variablesApi, { secrets });
          scope.register(fsApi);
          // 能力库（ADR-0055、ADR-0056）：skill 与 MCP 的集中管理。
          scope.register(skillsApi, {
            skills,
            capabilities,
            workspaces,
            environments,
            hub,
            runtime: skillRuntime,
          });
          scope.register(mcpApi, {
            mcp: mcpStore,
            secrets,
            capabilities,
            workspaces,
            runtime: mcp,
          });
          scope.register(browserApi, {
            manager: browser,
            pool,
            ...options.tuning,
          });
          scope.register(workbenchApi, { store: new WorkbenchStore(db as Db) });
        });
      } catch (err) {
        envHub?.close();
        envHub = null;
        void mcpRuntime?.close();
        mcpRuntime = null;
        db.close();
        db = null;
        throw err;
      }
      app.log.info(
        config.token === undefined && config.allowCidrs.length === 0
          ? "认证未启用（仅回环监听）"
          : config.token === undefined
            ? `认证未启用令牌（仅回环监听），来源网段 ${config.allowCidrs.length} 条`
            : `认证已启用，来源网段 ${config.allowCidrs.length} 条`,
      );
      try {
        await app.listen({ host: config.host, port: config.port });
      } catch (err) {
        envHub?.close();
        envHub = null;
        void mcpRuntime?.close();
        mcpRuntime = null;
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
      await browserManager?.closeAll();
      browserManager = null;
      await mcpRuntime?.close();
      mcpRuntime = null;
      envHub?.close();
      envHub = null;
      db?.close();
      db = null;
    },
  };
}
