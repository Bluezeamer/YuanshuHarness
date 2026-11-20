import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { agentSettingsApi } from "./api/agent-settings.js";
import { agentsMdApi } from "./api/agents-md.js";
import { attachmentsApi } from "./api/attachments.js";
import { auditApi } from "./api/audit.js";
import { browserApi } from "./api/browser.js";
import { browserLoginsApi } from "./api/browser-logins.js";
import { browserStreamApi } from "./api/browser-stream.js";
import { callsApi } from "./api/calls.js";
import { canvasApi } from "./api/canvas.js";
import { connectionsApi } from "./api/connections.js";
import { defaultModelApi } from "./api/default-model.js";
import { defaultsApi } from "./api/defaults.js";
import { devicesApi } from "./api/devices.js";
import { directoriesApi } from "./api/directories.js";
import { environmentsApi } from "./api/environments.js";
import { filesApi } from "./api/files.js";
import { flowsApi } from "./api/flows.js";
import { forwardsApi } from "./api/forwards.js";
import { fsApi } from "./api/fs.js";
import { gitApi } from "./api/git.js";
import { hooksApi } from "./api/hooks.js";
import { jobsApi } from "./api/jobs.js";
import { libraryStreamApi } from "./api/library-stream.js";
import { mcpApi } from "./api/mcp.js";
import { modelsApi } from "./api/models.js";
import { permissionApi } from "./api/permission.js";
import { pluginsApi } from "./api/plugins.js";
import { markOauth, providerLoginApi } from "./api/provider-login.js";
import { providersApi } from "./api/providers.js";
import { pushApi } from "./api/push.js";
import { reviewPromptApi } from "./api/review-prompt.js";
import { sessionDirectoriesApi } from "./api/session-directories.js";
import { DEFAULTS, sessionsApi } from "./api/sessions.js";
import { skillsApi } from "./api/skills.js";
import { studioApi } from "./api/studio.js";
import { teamApi } from "./api/team.js";
import { terminalsApi } from "./api/terminals.js";
import { toolsApi } from "./api/tools.js";
import { topologyApi } from "./api/topology.js";
import { turnChangesApi } from "./api/turn-changes.js";
import { variablesApi } from "./api/variables.js";
import { registerWorkspaceCapabilityRoutes } from "./api/workspace-capabilities.js";
import { workspaceGroupsApi } from "./api/workspace-groups.js";
import { workspacesApi } from "./api/workspaces.js";
import {
  authOf,
  clearCookie,
  createAuthHook,
  extractToken,
  type RateLimitOptions,
  sessionCookie,
} from "./auth.js";
import { createCleaner } from "./browser/agent/clean/index.js";
import { Engine } from "./browser/engine/engine.js";
import { resolveTarget, TargetError } from "./browser/net/target.js";
import { targetOptions, workspaceReach } from "./browser/reach.js";
import { BrowserService } from "./browser/service.js";
import { StreamHub } from "./browser/stream/index.js";
import { LinkService } from "./canvas/link.js";
import {
  CanvasService,
  canvasHostId,
  canvasHostName,
} from "./canvas/service.js";
import { ThumbService, workerResize } from "./canvas/thumb.js";
import { TurnChangeStore } from "./changes/store.js";
import { ChangeTracker } from "./changes/tracker.js";
import type { Config } from "./config.js";
import { prepareDataDir } from "./data-dir.js";
import { DeviceConnections } from "./devices/connections.js";
import { PairingCodes } from "./devices/pairing.js";
import { EnvHub } from "./env/hub.js";
import { createForwardAuthorizer } from "./forward/authorize.js";
import { createForwardHandler } from "./forward/handler.js";
import {
  createForwardService,
  type ForwardService,
} from "./forward/service.js";
import { GitStatusService } from "./git/status.js";
import { HookRuntime } from "./hooks/runtime.js";
import { JobManager } from "./job/manager.js";
import { McpRuntime } from "./mcp/runtime.js";
import { Masker } from "./permission/masking.js";
import type { ReviewerFactory } from "./permission/review.js";
import { resolveCriteria } from "./permission/review-policy.js";
import { PluginRuntime } from "./plugins/runtime.js";
import { ensureBuiltinAgents } from "./prompt/builtin-agents.js";
import { Catalog } from "./provider/catalog.js";
import { DEFAULT_MAX_CONCURRENT, RequestLimiter } from "./provider/limiter.js";
import { LoginManager, type LoginRuntime } from "./provider/login.js";
import { ModelResolver } from "./provider/resolve.js";
import { PushNotifier } from "./push/notifier.js";
import { createSender, type PushSender } from "./push/sender.js";
import { loadVapid } from "./push/vapid.js";
import { AgentSettingsFile } from "./session/agent-settings.js";
import { readAgentsFiles } from "./session/agents-md.js";
import { GlobalAgentsMdFile } from "./session/agents-md-presets.js";
import { AttachmentDirectories } from "./session/attachments.js";
import { createAuxRunner } from "./session/aux.js";
import { DirectoryResolver } from "./session/directory-resolver.js";
import type { ImageResize } from "./session/image-compression.js";
import { SessionLibrary, sessionTitle } from "./session/library.js";
import { type SessionFactory, SessionPool } from "./session/pool.js";
import { modeViewOf, selectPresets } from "./session/preset-selection.js";
import { createReviewerFactory } from "./session/reviewer.js";
import { SessionConfigService } from "./session/session-config.js";
import { SessionFeed } from "./session/session-feed.js";
import { WorkspaceLifecycle } from "./session/workspace-lifecycle.js";
import { WorkspaceService } from "./session/workspaces.js";
import { PiSkillFetcher, type SkillFetcher } from "./skills/fetch.js";
import { SkillLibrary } from "./skills/library.js";
import { SkillRuntime } from "./skills/runtime.js";
import { AuditLog } from "./store/audit.js";
import { CallStore } from "./store/calls.js";
import { CapabilityStore } from "./store/capabilities.js";
import { ConnectionStore } from "./store/connections.js";
import { type Db, openDatabase } from "./store/db.js";
import { DefaultsStore, type ImageCompression } from "./store/defaults.js";
import { DeviceStore } from "./store/devices.js";
import { DirectoryStore } from "./store/directories.js";
import { EnvironmentStore } from "./store/environments.js";
import { ForwardStore } from "./store/forwards.js";
import { HookStore } from "./store/hooks.js";
import { JobStore } from "./store/jobs.js";
import { McpStore } from "./store/mcp.js";
import { ModelStore } from "./store/models.js";
import { PluginSwitchStore } from "./store/plugins.js";
import { PromptCardStore } from "./store/prompt-cards.js";
import { PromptPresetStore } from "./store/prompt-presets.js";
import { ProviderStore } from "./store/providers.js";
import { PushStore } from "./store/push.js";
import { ReferenceStore } from "./store/references.js";
import { RuleStore } from "./store/rules.js";
import { loadMasterKey, SecretStore } from "./store/secrets.js";
import { SessionConfigStore } from "./store/session-configs.js";
import { SessionFileStore } from "./store/session-files.js";
import { SessionStateStore } from "./store/session-state.js";
import { SessionStore } from "./store/sessions.js";
import { SkillStore } from "./store/skills.js";
import { SubagentStore } from "./store/subagents.js";
import { TeamStore } from "./store/teams.js";
import { ToolDescriptionStore } from "./store/tool-descriptions.js";
import { ToolRuleStore } from "./store/tool-rules.js";
import { WorkspaceDirectoryStore } from "./store/workspace-directories.js";
import { WorkspaceGroupStore } from "./store/workspace-groups.js";
import { WorkspaceLayoutStore } from "./store/workspace-layouts.js";
import { WorkspaceVariableStore } from "./store/workspace-variables.js";
import { WorkspaceStore } from "./store/workspaces.js";
import { CollabArea } from "./subagent/collab.js";
import { SubagentRuntime } from "./subagent/runtime.js";
import { withTools } from "./subagent/tools.js";
import { BOARD_SUMMARY_SYSTEM, boardSummaryPrompt } from "./team/messages.js";
import { memberHooks, TeamRuntime } from "./team/runtime.js";
import { teamExtension } from "./team/tools.js";
import { membersIdle } from "./team/view.js";
import { TerminalManager, type TerminalOptions } from "./terminal/manager.js";
import { WatchHub } from "./watch/hub.js";
import { NamedWorkflows } from "./workflow/named.js";
import { WorkflowRuntime } from "./workflow/runtime.js";
import { workflowExtension } from "./workflow/tools.js";

// src/ 与 dist/ 都在包根的下一层，所以源码、构建产物与 npm 安装后得到同样的包根。
const PACKAGE_ROOT = new URL("../", import.meta.url);

export interface ServerOptions {
  webRoot?: string;
  logStream?: { write(msg: string): void };
  // 未提供时会话创建返回 501（真实模型接入在后续能力里）。
  sessionFactory?: SessionFactory;
  // 需要服务内依赖（模型登记、密码库）时用它构造工厂；与 sessionFactory 二选一。
  makeSessionFactory?: (deps: {
    resolver: ModelResolver;
    imageCompression?: () => ImageCompression;
    // 压缩 / 重试的覆盖值：`<ysHome>/settings.json`
    agentSettings?: AgentSettingsFile;
    limiter?: RequestLimiter;
    pluginEnabled?: () => ReadonlySet<string>;
  }) => SessionFactory;
  // 仅供测试替换图片压缩实现（省掉真实 WASM 压缩）。
  imageResize?: ImageResize;
  // 注入的审核会话工厂（ADR-0031）；未提供时 auto 档同 rules。
  reviewerFactory?: ReviewerFactory;
  // 仅供测试缩短审核超时。
  reviewTimeoutMs?: number;
  // 仅供测试缩短供应商探测与连接测试的每阶段超时。
  providerTimeoutMs?: number;
  // 仅供测试替换订阅登录的 pi 运行时（不联网、不走真 OAuth）。
  loginRuntime?: LoginRuntime;
  // 仅供测试替换技能来源取回（npm / git），避免访问外网。
  skillFetcher?: SkillFetcher;
  // 首次启动登记为默认 directory 的目录；缺省取进程工作目录。
  startDir?: string;
  // 仅供测试覆盖终端的数量上限与回放缓冲。
  terminals?: Partial<TerminalOptions>;
  // 仅供测试注入限流的时钟与数值。
  authLimiter?: Partial<RateLimitOptions>;
  // 仅供测试替换推送发送（避开真实推送服务）。
  pushSender?: PushSender;
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
/** 页面读内容时辅助模型单次调用最多等多久：它在工具调用的路径上，实测一次 3–20 秒，大页面更久。 */
const PAGE_AUX_TIMEOUT_MS = 90_000;
/** 读大页面的只读 agent 的总时限（设计稿 §8.3 的预算）。 */
const PAGE_READER_TIMEOUT_MS = 120_000;
// 服务转发的出口端口段（含两端）：没配 --forward-ports 时用它；容器要同样发布这段端口。
// 选在少见的位置，免得侵占本机常用服务的端口：低于 k8s NodePort（30000 起）与 Linux 临时端口段（32768 起），也不在常见开发 / 数据库端口附近。
const DEFAULT_FORWARD_PORTS = { from: 24100, to: 24199 };

// VAPID 的联系方式：只用 mailto（`https://localhost` 在 Safari 会回 BadJwtToken）。
const PUSH_VAPID_SUBJECT = "mailto:admin@example.com";

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

// 手机入口是同一个前端包的第二份 HTML：/m 下的静态资源照常发，其余路径（/m/s/<id> 这类深链接）
// 回退到 m/index.html，刷新或直接打开时才不会 404。取哪个文件只看存不存在，越界仍由 sendFile 的 allowedPath（isInsideWebRoot）拦。
function isMobileFile(webRoot: string, rest: string): boolean {
  if (rest === "") return false;
  // 空段与点段一律当深链接：规范形式的文件路径不会长这样
  if (rest.split("/").some((s) => s === "" || s.startsWith("."))) return false;
  try {
    return statSync(path.join(webRoot, "m", rest)).isFile();
  } catch {
    return false;
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
  let browserService: BrowserService | null = null;
  let browserStreams: StreamHub | null = null;
  let forwardService: ForwardService | null = null;
  let jobsRef: JobManager | null = null;
  let thumbResize: ReturnType<typeof workerResize> | null = null;
  let canvasRef: CanvasService | null = null;
  // Server 实际监听的端口：listen 之后才知道，代理层用它拒绝浏览器访问 Server 自己。
  let boundPort: number | null = null;
  let loginManager: LoginManager | null = null;
  let pushNotifierRef: PushNotifier | null = null;
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
  // 前端用 History 路由，设置页是 /settings/<页>：刷新或直接打开这些地址时回 index.html，其余未知路径仍是 404。
  for (const route of ["/settings", "/settings/*"])
    app.get(route, async (_req, reply) => reply.sendFile("index.html"));
  // 手机版同理：/m/ 下有的文件照发，没有的回 m/index.html（它不存在时与普通静态一样是 404）。
  for (const route of ["/m", "/m/*"])
    app.get<{ Params: { "*"?: string } }>(route, async (req, reply) => {
      const rest = req.params["*"] ?? "";
      return reply.sendFile(
        isMobileFile(webRoot, rest) ? path.join("m", rest) : "m/index.html",
      );
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
        const directories = new DirectoryStore(db);
        // 全局默认值（目录起点、图片压缩参数），设置接口与会话都读同一份。
        const defaults = new DefaultsStore(db as Db);
        // 每个工作区一块隐藏的 attachment directory（首次上传时创建）与虚拟附件环境。
        // 属主要问池，而池在下面才建：惰性闭包，别改创建顺序。
        let poolRef: SessionPool | null = null;
        const attachments = new AttachmentDirectories(
          directories,
          config.dataDir,
          (sessionId) => poolRef?.workspaceIdOf(sessionId) ?? sessionId,
        );
        const rules = new RuleStore(db);
        const toolRules = new ToolRuleStore(db as Db);
        const created = directories.ensureDefault(
          options.startDir ?? process.cwd(),
        );
        if (created)
          app.log.info({ path: created.path }, "已登记默认 directory");
        const masterKey = loadMasterKey(config.dataDir);
        const secrets = new SecretStore(db as Db, masterKey);
        const models = new ModelStore(config.dataDir);
        const agentDir = path.join(config.dataDir, "agent");
        const environments = new EnvironmentStore(db as Db);
        const connections = new ConnectionStore(db as Db);
        const audit = new AuditLog(db as Db);
        // 协作区要先于 EnvHub：hub 要在环境那里交出它的虚拟环境（collab）。
        const collab = new CollabArea(
          path.join(config.dataDir, "collab"),
          (root) => membersIdle(teamStore, subagentStore, root),
        );
        const hub = new EnvHub(
          environments,
          secrets,
          connections,
          audit,
          attachments.env,
          collab.env,
          config.dataDir,
        );
        envHub = hub;
        // 文件变更监听（有限感知刷新）与 git 状态：都按需创建，装配给会话流与文件接口。
        const watcher = new WatchHub({ env: (id) => hub.get(id) });
        const git = new GitStatusService();
        // 灵感画布：按 (environment, 目录) 取仓库，会话的工具与接口共用同一份实例。
        const canvas = new CanvasService({
          env: (id) => hub.get(id),
          replicaDir: path.join(config.dataDir, "canvas"),
          // 主机名相对画布所在的环境（与会话地址簿同一份命名规则）
          hostName: (envId, homeEnvId) =>
            canvasHostName(() => environments.list(), envId, homeEnvId),
          hostId: (target, homeEnvId) =>
            canvasHostId(() => environments.list(), target, homeEnvId),
        });
        canvasRef = canvas;
        // 画布图片的缩略图：worker 里跑光子 WASM，缩略图缓存在 Server 磁盘上。
        thumbResize = workerResize();
        const thumbs = new ThumbService({
          cacheDir: path.join(config.dataDir, "cache", "canvas-thumbs"),
          resize: thumbResize,
          settings: () => {
            const m = defaults.canvasMedia();
            return {
              maxSide: m.thumbMaxSide,
              quality: m.thumbQuality,
              gifMaxBytes: m.gifMaxMB * 1024 * 1024,
              sourceMaxBytes: m.sourceMaxMB * 1024 * 1024,
            };
          },
        });
        const references = new ReferenceStore(db as Db, () =>
          secrets.maskVars(),
        );
        const providers = new ProviderStore(db as Db);
        const catalog = await Catalog.create(agentDir);
        // 订阅登录：登录成功的回调里把这条供应商的认证方式记成 oauth。
        const login = new LoginManager(
          options.loginRuntime ?? catalog.runtime,
          {
            onDone: (id) => markOauth(catalog, providers, id),
          },
        );
        loginManager = login;
        const resolver = new ModelResolver({
          db: db as Db,
          models,
          providers,
          catalog,
          secrets,
          agentDir,
        });
        const promptCards = new PromptCardStore(db as Db);
        const promptPresets = new PromptPresetStore(db as Db);
        // 工具页调优的描述覆盖：设置接口写、会话装配读，两个入口共用一份。
        const toolDescriptions = new ToolDescriptionStore(db as Db);
        // 内置卡片与内置预设（默认行为构建、页面阅读 agent）按代码里的定义覆盖，不需要别的种子
        ensureBuiltinAgents({ cards: promptCards, presets: promptPresets });
        const skills = new SkillStore(
          db as Db,
          path.join(config.dataDir, "skills"),
        );
        const capabilities = new CapabilityStore(db as Db);
        const workspaceDirectories = new WorkspaceDirectoryStore(db as Db);
        // 技能库：来源安装（npm / git 经 pi 的包管理器，装在专用目录）、版本与分发。
        const skillLibrary = new SkillLibrary({
          skills,
          capabilities,
          directories,
          workspaceDirectories,
          environments,
          hub,
          fetcher:
            options.skillFetcher ??
            new PiSkillFetcher({
              dir: path.join(config.dataDir, "skill-fetch"),
            }),
        });
        const skillRuntime = new SkillRuntime({
          skills,
          capabilities,
          audit,
          load: (meta) => skillLibrary.loadInput(meta),
        });
        const mcpStore = new McpStore(db as Db);
        secrets.addReferrer((id) => models.referencesSecret(id));
        secrets.addReferrer((id) => providers.referencesSecret(id));
        secrets.addReferrer((id) => mcpStore.referencesSecret(id));
        const mcp = new McpRuntime({
          mcp: mcpStore,
          secrets,
          capabilities,
          audit,
        });
        mcpRuntime = mcp;
        // pi 包的安装 / 启停 / 卸载（docs/model/plugin.md）：登记与包体都在 pi 自己的
        // agentDir 下，与会话加载扩展读的是同一份，与 pi TUI 共用。
        const pluginSwitch = new PluginSwitchStore(db as Db);
        const plugins = new PluginRuntime(pluginSwitch);
        // 终端管理器要在工作区服务之前建：删工作区要能找到并关掉它的终端。
        const terminalManager = new TerminalManager(audit, {
          ...(config.maxTerminals === undefined
            ? {}
            : { max: config.maxTerminals }),
          ...options.terminals,
        });
        const subagentStore = new SubagentStore(db as Db);
        const teamStore = new TeamStore(db as Db);
        const workspaceStore = new WorkspaceStore(db as Db);
        const workspaceVariables = new WorkspaceVariableStore(db as Db);
        const workspaceGroups = new WorkspaceGroupStore(db as Db);
        const workspaceLayouts = new WorkspaceLayoutStore(db as Db);
        const callStore = new CallStore(db as Db);
        const hookStore = new HookStore(db as Db);
        const hookRuntime = new HookRuntime({
          store: hookStore,
          audit,
          variables: () => secrets.maskVars(),
        });
        const jobs = new JobManager({
          store: new JobStore(db as Db),
          dir: path.join(config.dataDir, "jobs"),
          // 回调在调用方这一轮的下一步模型调用之前注入；它空闲就唤醒它。
          notify: (sessionId, text, job) =>
            pool.get(sessionId)?.notify(text, "steer", job) ?? false,
          // 任务登记 / 结束 / 重开 / 改提醒：右栏的「后台任务」据此刷新
          changed: (sessionId) =>
            pool.get(sessionId)?.publish("jobs.updated", {}),
          remindMs: () => defaults.jobRemindSeconds() * 1000,
        });
        jobsRef = jobs;
        // 每个供应商同时在途的模型请求数上限（设置里改了，之后的放行就按新的来）
        const limiter = new RequestLimiter(
          (provider) =>
            providers.get(provider)?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        );
        // 浏览器：引擎与代理都是惰性的，没人用就不起进程、不占端口。
        // 读页面内容用的辅助模型调用：只走辅助模型，超时或出错就回落成不调模型的结果。
        const pageAuxRunner = createAuxRunner({
          resolver,
          limiter,
          auxModel: () => defaults.auxModel(),
          sessionModel: () => null,
          timeoutMs: PAGE_AUX_TIMEOUT_MS,
        });
        // 读大页面的只读 agent 在 subagentRuntime 里（下面才构造），这里先留一个槽。
        let subagentRef: SubagentRuntime | null = null;
        const engine = new Engine({
          dataDir: config.dataDir,
          // 设置页的下载镜像，每次安装现取；空则退回环境变量
          mirror: () => defaults.browserMirror() || null,
          log: (msg) => app.log.info(msg),
        });
        // 工作区的目录清单（第一个是主目录）：浏览器能到达哪些环境与文件，都按它判定。
        const reachDirs = (workspaceKey: string) =>
          workspaceDirectories
            .get(workspaceKey)
            .flatMap((id) => directories.get(id) ?? [])
            .map((d) => ({ environmentId: d.environmentId, path: d.path }));
        const browser = new BrowserService({
          dataDir: config.dataDir,
          db: db as Db,
          masterKey,
          engine,
          // 文件页自动刷新与会话共用一个监听中枢：key 带 browser: 前缀，互不串
          watch: watcher,
          proxy: {
            env: (envId) => hub.get(envId),
            onDeny: ({ code, host }) =>
              app.log.info({ code, host }, "浏览器代理拒绝了一次访问"),
          },
          cleaner: createCleaner({
            // 只在配了辅助模型时调用，不退回会话自己的模型（那样每步更贵更慢）；每次现读配置。
            aux: () =>
              defaults.auxModel() === null
                ? null
                : ({ system, user }) => pageAuxRunner("", system, user),
            // 大页面交给只读的页面阅读 agent；没配辅助模型或 subagent 还不可用都按回落处理。
            reader: () => {
              const rt = subagentRef;
              if (defaults.auxModel() === null || rt === null) return null;
              return ({ sessionId, task, label, signal }) =>
                rt.readPage(sessionId, {
                  task,
                  timeoutMs: PAGE_READER_TIMEOUT_MS,
                  signal,
                  label,
                });
            },
            // 页面内容发给模型之前先过变量遮罩（全部变量，不只是当前工作区启用的）。
            mask: (text) => Masker.of(secrets.maskVars()).mask(text),
          }),
          scope: (workspaceKey) =>
            workspaceReach(
              () => reachDirs(workspaceKey),
              () => boundPort,
            ),
          rootOf: (id) => subagentStore.rootOf(id),
          isBusy: (root) => pool.get(root)?.busy === true,
          label: (id) => {
            const info = pool.info(id);
            return info ? sessionTitle(info) : id.slice(0, 8);
          },
          audit: (e) =>
            audit.record({
              actor: "user",
              kind: "secret",
              summary: e.summary,
              detail: e.detail,
            }),
        });
        browserService = browser;
        // 服务转发：每个转发一个独立端口，用户在自己的浏览器里用环境里的服务（docs/model/forward.md）。
        const forwards = createForwardService({
          store: new ForwardStore(db as Db),
          handler: createForwardHandler({
            env: (envId) => hub.get(envId),
            authorize: createForwardAuthorizer(config.token),
          }),
          range: config.forwardPorts ?? DEFAULT_FORWARD_PORTS,
          host: config.host,
          allowCidrs: config.allowCidrs,
          allow: (workspaceKey, envId, port) =>
            workspaceReach(
              () => reachDirs(workspaceKey),
              () => boundPort,
            ).allowService(envId, port),
          serverPort: () => boundPort,
        });
        forwardService = forwards;
        // 用户在地址栏输入的目标：local 与绝对路径都取该工作区主目录所在的环境（找不到主目录就是 null）。
        const browserTargets = (workspaceKey: string) => {
          const primaryEnvId =
            reachDirs(workspaceKey)[0]?.environmentId ?? null;
          // 用户自己写的 localhost:3000 指主目录所在的主机；agent 的工具不给 loopbackEnvId（要写明主机）
          return {
            ...targetOptions(
              () => environments.list(),
              primaryEnvId,
              primaryEnvId,
            ),
            loopbackEnvId: primaryEnvId,
          };
        };
        const streamHub = new StreamHub({
          registry: browser.registry,
          resolveGoto: (workspaceKey, raw) => {
            try {
              return {
                ok: true,
                url: resolveTarget(raw, browserTargets(workspaceKey)).url,
              };
            } catch (err) {
              if (err instanceof TargetError)
                return { ok: false, error: err.message };
              throw err;
            }
          },
        });
        browserStreams = streamHub;
        // 轮次改动追踪：清单进库，旧/新内容副本落在数据目录（不进库）。
        const turnChanges = new TurnChangeStore(db as Db);
        const tracker = new ChangeTracker({
          dir: path.join(config.dataDir, "turn-changes"),
        });
        const sessionConfigs = new SessionConfigService({
          store: new SessionConfigStore(db as Db),
          resolver,
          defaults,
        });
        // 全局资源目录（命名流程与全局 AGENTS.md）：Server 本机。
        const ysHome = config.ysHome ?? path.join(os.homedir(), ".ys");
        // 元枢自己的压缩 / 重试设置：与会话工厂共用同一个实例（文件按 mtime 缓存）。
        const agentSettings = new AgentSettingsFile(
          path.join(ysHome, "settings.json"),
        );
        // 全局 AGENTS.md 的文件与「是不是我们写的」的记账，激活 / 保存版本时用。
        const agentsMdFile = new GlobalAgentsMdFile({ ysHome, db: db as Db });
        const pool = new SessionPool({
          audit,
          changes: turnChanges,
          tracker,
          attachments,
          imageCompression: () => defaults.imageCompression(),
          uploadMaxBytes: () =>
            defaults.canvasMedia().uploadMaxMB * 1024 * 1024,
          defaultTier: () => defaults.permissionTier(),
          // 审核的判别准则：全局自定义 + 会话所在工作区的设置，每次审核现取。
          reviewCriteria: (wsId) =>
            resolveCriteria(
              defaults.reviewCriteria(),
              wsId === null
                ? null
                : (workspaceStore.get(wsId)?.reviewPolicy ?? null),
            ),
          ...(options.imageResize ? { imageResize: options.imageResize } : {}),
          presetView: (choice) =>
            selectPresets(promptPresets, promptCards, choice),
          agentsFiles: (directoryId) =>
            readAgentsFiles(ysHome, pool.directoryContext(directoryId)),
          agentDefs: () =>
            promptPresets
              .list("agent")
              .map((a) => ({ name: a.name, description: a.description })),
          modeView: (id, model) =>
            modeViewOf(promptPresets, promptCards, id, model),
          envHub: hub,
          environments,
          secrets,
          workspaceVariables,
          references,
          skills: skillRuntime,
          mcp,
          toolRules,
          toolDescriptions,
          browser,
          subagents: subagentStore,
          teams: teamStore,
          workspaces: workspaceStore,
          workspaceDirectories,
          calls: callStore,
          states: new SessionStateStore(db as Db),
          // 目标续跑的轮数上限：每个目标新建时按设置现取。
          goalMaxRounds: () => defaults.goalMaxRounds(),
          files: new SessionFileStore(db as Db),
          resolver,
          configs: sessionConfigs,
          hooks: hookRuntime,
          jobs,
          collab,
          factory:
            options.sessionFactory ??
            options.makeSessionFactory?.({
              resolver,
              imageCompression: () => defaults.imageCompression(),
              agentSettings,
              limiter,
              pluginEnabled: () => pluginSwitch.enabled(),
            }) ??
            null,
          // 生产里用审批模型建审核会话；测试可注入假工厂。
          reviewerFactory:
            options.reviewerFactory ??
            createReviewerFactory({
              resolver,
              reviewModel: () => defaults.reviewModel(),
              limiter,
            }),
          ...(options.reviewTimeoutMs
            ? { reviewTimeoutMs: options.reviewTimeoutMs }
            : {}),
          store,
          directories,
          rules,
          canvas,
          sessionDir,
        });
        poolRef = pool;
        // 先于监听：上一进程里还在跑的子会话在这里落成 interrupted。
        const subagentRuntime = new SubagentRuntime({
          pool,
          store: subagentStore,
          jobs,
          directories,
          presets: promptPresets,
          hasModel: (provider, model) => resolver.has(provider, model),
          auxModel: () => defaults.auxModel(),
          limits: () => defaults.subagentLimits(),
          collab,
          members: memberHooks(teamStore, collab),
        });
        subagentRef = subagentRuntime;
        // 辅助调用：用辅助模型，没配就用会话自己的模型
        const aux = createAuxRunner({
          resolver,
          limiter,
          auxModel: () => defaults.auxModel(),
          sessionModel: (id) => pool.modelRefOf(id),
        });
        const teamRuntime = new TeamRuntime({
          pool,
          rt: subagentRuntime,
          teams: teamStore,
          subagents: subagentStore,
          jobs,
          collab,
          summarize: (leadId, board) =>
            aux(leadId, BOARD_SUMMARY_SYSTEM, boardSummaryPrompt(board)),
          changes: {
            tracker,
            context: (directoryId) => pool.directoryContext(directoryId),
          },
        });
        const workflowRuntime = new WorkflowRuntime({
          rt: subagentRuntime,
          jobs,
          store: subagentStore,
          collab,
          limits: () => defaults.subagentLimits(),
        });
        // 命名流程（workflow.md §6）：全局层在 Server 本机，项目层随会话当前 directory 变。
        const named = new NamedWorkflows({
          globalDir: path.join(ysHome, "workflows"),
          project: (id) => {
            const ctx = pool.directoryContext(pool.info(id)?.directoryId ?? "");
            return ctx ? { env: ctx.env, path: ctx.root } : null;
          },
        });
        pool.attachNamedWorkflows(named);
        pool.attachSubagents(
          withTools(
            withTools(subagentRuntime.hooks(), (id) =>
              teamExtension(teamRuntime, id),
            ),
            (id) => workflowExtension(workflowRuntime, named, id),
          ),
        );
        const devices = new DeviceStore(db as Db);
        const pairing = new PairingCodes();
        const deviceConnections = new DeviceConnections();
        const { hook, limiter: authLimiter } = createAuthHook({
          ...(config.token === undefined ? {} : { token: config.token }),
          allowCidrs: config.allowCidrs,
          ...(config.trustedOrigins
            ? { trustedOrigins: config.trustedOrigins }
            : {}),
          ...(options.authLimiter ? { limiter: options.authLimiter } : {}),
          devices,
        });
        // 认证只包住 /api/v1；/healthz 与静态资源在作用域之外。
        app.register(async (scope) => {
          scope.addHook("onRequest", hook);
          // 记下设备已打开的底层连接（含升级后的 WebSocket），撤销设备时一并掐断。
          scope.addHook("onRequest", async (req) => {
            const auth = authOf(req);
            if (auth.kind === "device")
              deviceConnections.track(auth.device.id, req.raw.socket);
          });
          scope.register(devicesApi, {
            devices,
            pairing,
            connections: deviceConnections,
            limiter: authLimiter,
          });
          // 把已校验的令牌落到 HttpOnly 会话 Cookie：HTML 预览的 iframe 发不了自定义头，
          // 它内部的样式/脚本/图片请求只能靠 Cookie 带上凭据。
          scope.post("/api/v1/auth/session", async (req, reply) => {
            const given = extractToken(req.headers);
            if (given === undefined)
              return reply.code(401).send({ error: "unauthorized" });
            return reply
              .header("Set-Cookie", sessionCookie(given))
              .send({ ok: true });
          });
          scope.delete("/api/v1/auth/session", async (_req, reply) =>
            reply.header("Set-Cookie", clearCookie()).send({ ok: true }),
          );
          scope.register(sessionsApi, {
            ...DEFAULTS,
            ...options.tuning,
            pool,
            watcher,
            envs: hub,
            workspaceDefaults: (id: string) => workspaceService.defaultsFor(id),
          });
          // 列表级推送通道：会话库的视图与 feed 共用同一个实例，改名 / 归档等动作才能推出事件。
          const sessionLibrary = new SessionLibrary(pool, {
            onArchived: (id) => void browser.releaseSession(id).catch(() => {}),
          });
          const sessionFeed = new SessionFeed({
            list: () => sessionLibrary.list(),
            view: (id) => sessionLibrary.get(id),
            topOf: (id) => subagentStore.rootOf(id),
            isListed: (id) => !pool.isChild(id),
            clearMarks: (id) => pool.store.clearMarks(id),
          });
          pool.attachFeed(sessionFeed);
          subagentStore.onChange = (id) => sessionFeed.touch(id);
          scope.register(libraryStreamApi, {
            feed: sessionFeed,
            ...options.tuning,
          });
          // 手机推送：VAPID 密钥首次生成后固定，通知由 feed 事件与池的一轮结束驱动。
          const pushStore = new PushStore(db as Db);
          const vapid = loadVapid(pushStore, masterKey);
          const pushNotifier = new PushNotifier({
            store: pushStore,
            feed: sessionFeed,
            send:
              options.pushSender ??
              createSender({
                vapid: { ...vapid, subject: PUSH_VAPID_SUBJECT },
              }),
            log: (message, err) => app.log.warn({ err }, message),
          });
          pushNotifier.start();
          pushNotifierRef = pushNotifier;
          pool.attachTurnEnded((id, error) => {
            const info = pool.info(id);
            if (info) pushNotifier.turnEnded(id, sessionTitle(info), error);
          });
          scope.register(pushApi, {
            store: pushStore,
            notifier: pushNotifier,
            publicKey: vapid.publicKey,
          });
          scope.register(gitApi, { hub, git });
          scope.register(turnChangesApi, {
            changes: turnChanges,
            tracker,
            directories,
            hub,
            directoryOf: (id: string) => pool.info(id)?.directoryId ?? null,
          });
          scope.register(attachmentsApi, { pool, attachments });
          scope.register(sessionDirectoriesApi, { pool });
          const directoryResolver = new DirectoryResolver({
            hub,
            directories,
          });
          const workspaceService = new WorkspaceService({
            workspaces: workspaceStore,
            mounts: workspaceDirectories,
            groups: workspaceGroups,
            layouts: workspaceLayouts,
            directories,
            pool,
            resolver: directoryResolver,
            presets: promptPresets,
            modelCheck: (provider, model) => resolver.has(provider, model),
          });
          scope.register(workspacesApi, {
            service: workspaceService,
            presets: promptPresets,
            cards: promptCards,
            pool,
            lifecycle: new WorkspaceLifecycle({
              service: workspaceService,
              workspaces: workspaceStore,
              mounts: workspaceDirectories,
              directories,
              rules,
              hooks: hookStore,
              sessions: store,
              pool,
              terminals: terminalManager,
              browser,
              attachments,
              resolver: directoryResolver,
              sessionRoot: sessionDir,
            }),
          });
          scope.register(workspaceGroupsApi, { groups: workspaceGroups });
          scope.register(defaultsApi, { defaults, resolver });
          scope.register(reviewPromptApi, { defaults });
          scope.register(agentSettingsApi, { file: agentSettings });
          scope.register(agentsMdApi, {
            file: agentsMdFile,
            presets: promptPresets,
            cards: promptCards,
          });
          scope.register(directoriesApi, {
            directories,
            rules,
            pool,
            resolver: directoryResolver,
          });
          scope.register(environmentsApi, {
            environments,
            secrets,
            hub,
            audit,
          });
          scope.register(connectionsApi, { connections, secrets, hub, audit });
          scope.register(auditApi, { audit });
          scope.register(callsApi, {
            calls: callStore,
            pool,
            subagents: subagentStore,
          });
          scope.register(jobsApi, { jobs, pool, audit });
          scope.register(topologyApi, { pool, subagents: subagentStore });
          scope.register(flowsApi, {
            pool,
            subagents: subagentStore,
            calls: callStore,
            presets: promptPresets,
            jobs,
            teams: teamStore,
            queued: (runId) => workflowRuntime.queued(runId),
          });
          scope.register(teamApi, {
            teams: teamStore,
            collab,
            runtime: teamRuntime,
          });
          scope.register(filesApi, { hub, audit });
          scope.register(canvasApi, {
            canvas,
            hub,
            thumbs,
            links: new LinkService(),
            assetLimits: () => {
              const m = defaults.canvasMedia();
              return {
                uploadMaxBytes: m.uploadMaxMB * 1024 * 1024,
                gitMaxBytes: m.assetGitMaxMB * 1024 * 1024,
              };
            },
          });
          scope.register(terminalsApi, {
            hub,
            manager: terminalManager,
            workspaceExists: (id) => workspaceStore.get(id) !== undefined,
            ...options.tuning,
          });
          scope.register(modelsApi, { models, secrets, agentDir });
          scope.register(defaultModelApi, { resolver });
          scope.register(providersApi, {
            providers,
            secrets,
            catalog,
            agentDir,
            // 有会话把模型指定成该供应商的模型时不让删自定义端点（池内还没落库的会话也算）。
            logout: (id) => login.logout(id),
            inUse: (id) =>
              pool.list().some((s) => {
                const m = sessionConfigs.stored(s.id)?.model;
                return m?.mode === "explicit" && m.provider === id;
              }),
            ...(options.providerTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.providerTimeoutMs }),
          });
          scope.register(providerLoginApi, {
            catalog,
            providers,
            secrets,
            login,
          });
          scope.register(studioApi, {
            cards: promptCards,
            presets: promptPresets,
            tools: toolDescriptions,
            file: agentsMdFile,
            agentRefs: () => pool.agentRefCounts(),
            defaultModel: () => {
              const d = resolver.default();
              return d ? { provider: d.provider, model: d.model } : null;
            },
          });
          scope.register(variablesApi, {
            secrets,
            audit,
            references,
            workspaces: workspaceStore,
            workspaceVariables,
          });
          scope.register(permissionApi);
          scope.register(fsApi);
          // 能力库（ADR-0055、ADR-0056）：skill 与 MCP 的集中管理。
          scope.register(skillsApi, {
            skills,
            directories,
            environments,
            hub,
            runtime: skillRuntime,
            library: skillLibrary,
          });
          scope.register(mcpApi, {
            mcp: mcpStore,
            secrets,
            workspaces: workspaceStore,
            capabilities,
            runtime: mcp,
          });
          scope.register(pluginsApi, { runtime: plugins });
          scope.register(registerWorkspaceCapabilityRoutes, {
            workspaces: workspaceStore,
            capabilities,
            skills,
            mcp: mcpStore,
          });
          scope.register(toolsApi, { rules: toolRules });
          scope.register(browserApi, {
            registry: browser.registry,
            engine,
            workspaceExists: (id) => workspaceStore.get(id) !== undefined,
            targetOptions: browserTargets,
            replay: browser.replay,
            login: browser.login,
            downloads: {
              pending: browser.pending,
              directories: (wid) =>
                workspaceDirectories
                  .get(wid)
                  .flatMap((id) => directories.get(id) ?? []),
              envOf: (d) => hub.get(d.environmentId),
            },
            uploads: { pending: browser.pendingUploads },
            // 与 agent 下载、上传同一个设置，每次请求现取
            fileMaxBytes: () =>
              defaults.canvasMedia().uploadMaxMB * 1024 * 1024,
            ports: { listening: (wid) => browser.listeningPorts(wid) },
            show: browser.show,
            ...options.tuning,
          });
          scope.register(forwardsApi, {
            forwards,
            targetOptions: browserTargets,
          });
          scope.register(browserLoginsApi, { login: browser.login });
          scope.register(browserStreamApi, {
            hub: streamHub,
            pages: browser.registry,
            ...options.tuning,
          });
          // 用户可配置 hook（ADR-0085、ADR-0086）：增删改与试跑只在这里。
          scope.register(hooksApi, {
            hooks: hookStore,
            directories,
            runtime: hookRuntime,
          });
        });
      } catch (err) {
        envHub?.close();
        envHub = null;
        void mcpRuntime?.close();
        mcpRuntime = null;
        thumbResize?.close();
        thumbResize = null;
        loginManager?.dispose();
        loginManager = null;
        pushNotifierRef?.stop();
        pushNotifierRef = null;
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
        thumbResize?.close();
        thumbResize = null;
        loginManager?.dispose();
        loginManager = null;
        pushNotifierRef?.stop();
        pushNotifierRef = null;
        db.close();
        db = null;
        throw new Error(
          `无法监听 ${config.host}:${config.port}（${reason(err)}）`,
        );
      }
      const bound = app.server.address() as net.AddressInfo;
      boundPort = bound.port;
      // 要等 Server 自己的端口确定了才恢复：分配与恢复都要避开它
      await forwardService?.restore();
      return { host: bound.address, port: bound.port };
    },
    async stop() {
      jobsRef?.shutdown();
      jobsRef = null;
      pushNotifierRef?.stop();
      pushNotifierRef = null;
      thumbResize?.close();
      thumbResize = null;
      loginManager?.dispose();
      loginManager = null;
      // 先停推流（要靠浏览器还活着）再关连接与浏览器。
      browserStreams?.dispose();
      browserStreams = null;
      await forwardService?.stop();
      forwardService = null;
      await app.close();
      await browserService?.close();
      browserService = null;
      await mcpRuntime?.close();
      mcpRuntime = null;
      await canvasRef?.close();
      canvasRef = null;
      envHub?.close();
      envHub = null;
      db?.close();
      db = null;
    },
  };
}
