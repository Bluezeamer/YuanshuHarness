import path from "node:path";
import {
  createMcpExtension,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  answerVerdict,
  browserTools,
  createApproveDownload,
  createApproveOpen,
  createApproveUpload,
  resolveUploadFile,
} from "../browser/agent/index.js";
import { targetOptions } from "../browser/reach.js";
import { CanvasError } from "../canvas/service.js";
import { canvasExtension, canvasSyncExtension } from "../canvas/tool.js";
import { routedToolsExtension } from "../env/tools.js";
import type { ExecEnv } from "../env/types.js";
import { hooksExtension } from "../hooks/extension.js";
import type { PointId } from "../hooks/points.js";
import { hookCtx } from "../hooks/runtime.js";
import { combineViews, jobExtension } from "../job/tools.js";
import { configSig, type PiMcpConfig } from "../mcp/pi-config.js";
import type { McpSessionStatus } from "../mcp/session-status.js";
import type { McpToolDef } from "../mcp/tools.js";
import { type McpHome, mcpTransportFactory } from "../mcp/transport.js";
import {
  type DirectoryCtx,
  type Located,
  permissionExtension,
} from "../permission/extension.js";
import { Masker } from "../permission/masking.js";
import { maskingExtension } from "../permission/masking-extension.js";
import { runReview } from "../permission/review.js";
import { DEFAULT_CRITERIA } from "../permission/review-policy.js";
import type { SudoProbe } from "../permission/sudo.js";
import type { Tier } from "../permission/tier.js";
import { PI_IMAGE_COMPRESSION } from "../store/defaults.js";
import type { Directory } from "../store/directories.js";
import {
  type ChatEntry,
  readMessages,
  readToolOutputs,
} from "../store/history.js";
import type { McpServerMeta } from "../store/mcp.js";
import { findSessionFile } from "../store/sessions.js";
import type { SubagentSpec } from "../store/subagents.js";
import { SUBAGENT_LIMITS } from "../subagent/limits.js";
import { teamJobView } from "../team/view.js";
import type { NamedWorkflows } from "../workflow/named.js";
import { workflowJobView } from "../workflow/view.js";
import type { AddressBook } from "./address.js";
import { attachmentLine } from "./attachments.js";
import { callCaptureExtension } from "./call-capture.js";
import { callToolExtension } from "./call-tool.js";
import {
  type Delivery,
  type DeliveryHost,
  deliveryExtension,
  makeDelivery,
} from "./delivery.js";
import { type DirectoryView, directoryExtension } from "./directory-tools.js";
import { goalToolsExtension } from "./goal-tools.js";
import { compressImage } from "./image-compression.js";
import type { PoolDeps, SessionEntry, SubagentHooks } from "./pool.js";
import { promptSectionsExtension } from "./prompt-apply.js";
import type { RenderOutput } from "./prompt-source.js";
import type { PromptResult, PromptSpec } from "./prompts.js";
import { todoWriteExtension } from "./session-state.js";
import { type ModeChoice, switchModeExtension } from "./switch-mode.js";
import { takeoverExtension } from "./takeover.js";
import { askUserExtension } from "./tools.js";
import { transferExtension } from "./transfer-tool.js";
import { userPromptExtension } from "./user-prompt.js";
import { variableNoticeExtension } from "./variable-notice.js";

/** 装配扩展需要从会话池取的东西；池在创建 / 装载会话时现场组一个，测试可以换成假的。 */
export interface ExtensionHost {
  readonly deps: PoolDeps;
  readonly entries: ReadonlyMap<string, SessionEntry>;
  readonly sudoProbe: SudoProbe;
  /** 事后挂接（subagent 运行时与池互相引用），挂接前创建的会话没有 subagent 工具。 */
  subagentHooks(): SubagentHooks | null;
  observe(
    point: PointId,
    sessionId: string,
    ws: Directory,
    data: Record<string, unknown>,
  ): void;
  envOf(ws: Directory): ExecEnv | null;
  visibleDirectories(sessionId: string): Directory[];
  /** 会话所属的工作区；没有就是 null。 */
  workspaceIdOf(sessionId: string): string | null;
  directoryViews(sessionId: string, currentId: string): DirectoryView[];
  switchDirectory(sessionId: string, ref: string): DirectoryView;
  /** 会话的地址簿（池里唯一的接线）：工具、权限、传输、上传与画布解析都经它。 */
  addressBookOf(sessionId: string): AddressBook;
  switchSkillNotice(entry: SessionEntry): Promise<string>;
  sessionTier(id: string): Tier;
  /** 会话生效档与子代理派发上限取较严的一档 */
  effectiveTier(id: string, spec: SubagentSpec | undefined): Tier;
  toolDescriptionOverrides(): Record<string, string> | undefined;
  /** 提示词送达所需：基线工具、当前模式与可切换模式、我们生成的系统段 */
  delivery: DeliveryHost;
  /** 登记这个会话的送达计算，池据此回答「现在启用了哪些工具」 */
  bindDelivery(id: string, d: Delivery): void;
  /** 会话可切换的模式清单 */
  modeChoices(id: string): ModeChoice[];
  /** 此刻按预设渲染的提示词（活引用） */
  liveRender(id: string): RenderOutput | null;
  setActiveMode(id: string, modeId: string | null): void;
  permissionCtxOf(
    id: string,
    ws: Directory,
    spec: SubagentSpec | undefined,
  ): DirectoryCtx;
  /** 会话的主目录（local），地址簿的主机命名与 <cwd> 段取它。 */
  primaryDirectory(sessionId: string): Directory;
  /** 环境的连接名（地址里的主机名取它）。 */
  connectionName(envId: string): string | undefined;
}

export interface McpSetup {
  /** 每次现取：登记、全局开关、工作区勾选改了，下一次读就是新的。 */
  servers: () => McpServerMeta[];
  /** 此刻该交给 pi 的配置（变量值已解析）。 */
  config: () => PiMcpConfig;
  /** 逻辑 local 目录及其环境；stdio 服务就起在它的主机上。 */
  home: McpHome | null;
  /** 会话里各服务此刻的连接状态；重载前清空。 */
  status: McpSessionStatus;
  /** pi 上一次读走的配置：指纹与服务名。与 config() 的指纹不同，说明登记变了、还没连上，要重连。 */
  loaded: { sig: string | null; names: Set<string> };
}

// 会话创建时会话条目还不存在，扩展按 id 惰性取。
export function buildExtensions(
  host: ExtensionHost,
  id: string,
  ws: Directory,
  mcpTools: McpToolDef[] = [],
  // null = 这个池没有 MCP 能力；有但一个服务都没勾选也要装，之后登记了、重载才接得上
  mcp: McpSetup | null = null,
  // 子会话的派发约束；有它就是无人值守，档位与可切换的 directory 都被收窄。
  spec?: SubagentSpec,
): ExtensionFactory[] {
  const { directories, reviewerFactory, browser } = host.deps;
  const subagentHooks = host.subagentHooks();
  const delivery = makeDelivery(
    host.delivery,
    id,
    mcpTools,
    spec,
    mcp?.servers,
  );
  host.bindDelivery(id, delivery);
  // 会话当前所在的 directory：切换会改条目上的 id，创建期间条目还没有就用起始值。
  const current = (): Directory =>
    directories.get(host.entries.get(id)?.directoryId ?? ws.id) ?? ws;
  const ask = (spec: PromptSpec, signal?: AbortSignal) => {
    if (spec.source === "approval")
      host.observe("ApprovalRequested", id, current(), {
        tool_name: String(spec.detail?.tool ?? ""),
        summary: String(spec.detail?.summary ?? spec.title),
      });
    return (
      host.entries.get(id)?.ask(spec, signal) ??
      Promise.resolve<PromptResult>({ outcome: "cancelled" })
    );
  };
  // 浏览器的审计：动作摘要只写页面编号与长度；批准类沿用权限审计的形状。
  const recordBrowserAudit = (rec: {
    kind: "tool" | "permission";
    actor: "user" | "agent" | "system";
    summary: string;
    detail: Record<string, unknown>;
  }) =>
    host.deps.audit?.record({
      ...rec,
      sessionId: id,
      environmentId: current().environmentId,
    });
  // 目录所在的可用环境；取不到沿用「主机不可用」的原话。
  const dirEnv = (w: Directory): ExecEnv => {
    const env = host.envOf(w);
    if (!env)
      throw new Error(
        `Host "${host.connectionName(w.environmentId) ?? w.environmentId}" is not available.`,
      );
    return env;
  };
  // 地址簿：目录与环境每次现取，切换目录后立即生效。工具、权限、传输与上传共用池里那一个接线。
  const book = host.addressBookOf(id);
  // 一个目录引用（bash 的 host）解析成目录：缺省 = 当前目录，给了的只收 `<host>:<name>`
  // （裸主机、不在清单里的目录、附件区都由地址簿报原文错误）。执行与权限共用这一处。
  const directoryOf = (ref: string | undefined): Directory =>
    ref === undefined || ref.trim() === "" ? current() : book.directory(ref);
  // bash 的工作目录：host 只选目录，命令就在那个目录里跑，起点不会漂移。
  const locateDirectory = async (ref: string | undefined) => {
    const dir = directoryOf(ref);
    return { env: dirEnv(dir), cwd: dir.path };
  };
  // 权限层要的命令类上下文：与 locateDirectory 同一个目录解析，上下文取不到时同样只说「不可用」。
  const directoryCtx = async (ref: string | undefined) => {
    const dir = directoryOf(ref);
    try {
      return host.permissionCtxOf(id, dir, spec);
    } catch {
      throw new Error(
        `The permission context for ${book.refOf(dir)} is unavailable, so the call was denied.`,
      );
    }
  };
  // 文件工具与上传用的适配：env + 绝对路径 + 归属目录的 cwd。
  const locateForTool = async (
    hostName: string | undefined,
    path: string | undefined,
  ) => {
    const at = await book.locate(hostName, path);
    return { env: at.env, path: at.path, cwd: at.directory.path, at };
  };
  // 权限层要的 Located：归属目录的判定上下文由池给出（规则与「记住」都落在那个目录上）。
  // 上下文取不到（规则表读失败一类）只说「不可用」，不把内部错误原文交给模型。
  const locateCtx = async (
    hostName: string | undefined,
    path: string | undefined,
  ): Promise<Located> => {
    const at = await book.locate(hostName, path);
    let ctx: DirectoryCtx;
    try {
      ctx = host.permissionCtxOf(id, at.directory, spec);
    } catch {
      throw new Error(
        `The permission context for ${at.shown} is unavailable, so the call was denied.`,
      );
    }
    return {
      host: at.host,
      shown: at.shown,
      env: at.env,
      path: at.path,
      ctx,
    };
  };
  // canvas_edit 的 directory 解析：`<host>:<name>` 走地址簿；缺省 = 会话的主目录（画布标签永远绑它，
  // 不跟着 current() 走）。主目录不在这个会话的可见目录里（子代理在别的目录）就是拿不到。
  const canvasService = host.deps.canvas;
  const resolveCanvas = (ref?: string) => {
    if (!canvasService) throw new CanvasError("env_unavailable", "画布不可用");
    let hit: Directory;
    if (ref) {
      try {
        hit = book.directory(ref);
      } catch (err) {
        throw new CanvasError(
          "not_found",
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      // 缺省是主目录：它必须在会话的可见目录里（子代理在别的目录时拿不到）
      const primary = host.primaryDirectory(id);
      const seen = host.visibleDirectories(id).some((w) => w.id === primary.id);
      if (!seen)
        throw new CanvasError(
          "env_unavailable",
          `画布不可用：主目录 ${book.refOf(primary)} 不在这个会话的目录清单里。`,
        );
      hit = primary;
    }
    return {
      repo: canvasService.repo(hit.environmentId, hit.path),
      label: book.refOf(hit),
      envId: hit.environmentId,
    };
  };
  // 变量只在会话所属工作区启用了才可见（默认全不开），子代理会话与父同属一个工作区。
  // 每回合现查，改了启用关系后下一回合的清单与替换立即跟着变。
  // 看不见的变量对这个会话等于没登记：不替换、不进上下文清单，引用只留一条 unknown 记录。
  const visibleVars = <T>(list: readonly T[], idOf: (x: T) => string): T[] => {
    const ws = host.workspaceIdOf(id);
    if (ws === null) return [];
    const enabled = host.deps.workspaceVariables?.enabledIds(ws);
    return enabled ? list.filter((x) => enabled.has(idOf(x))) : [];
  };
  return [
    // user 通道：会话开头注入一次（尾部注入，display:false，不进可见历史）
    userPromptExtension(() => host.entries.get(id)?.userPromptText ?? null),
    // 接管开头系统消息：冻结物顶替 pi 写的系统条目，前缀不随设置变化。
    takeoverExtension({
      descriptions: () => host.toolDescriptionOverrides(),
      state: delivery.mapping,
    }),
    // 接管 pi 的提示词构建：preamble 之外的所有段由槽位管线产出。
    promptSectionsExtension(
      () => host.liveRender(id) ?? host.entries.get(id)?.promptRender ?? null,
    ),
    // MCP 交给 pi：连接、握手、工具注册（mcp__<server>__<tool>）都由它负责，
    // exposure 只有 direct（直接声明给模型）与 hidden 两种。
    // 排在送达扩展之前：它的 before_agent_start 会等「直连」的服务连上，送达层随后才看得到刚新增的工具，
    // 当条消息就能用尾部通知告诉模型，而不是晚一轮。
    ...(mcp
      ? [
          createMcpExtension({
            loadConfig: () => {
              const cfg = mcp.config();
              mcp.loaded.sig = configSig(cfg);
              mcp.loaded.names = new Set([
                ...cfg.servers.map((s) => s.name),
                ...cfg.failed.map((f) => f.name),
              ]);
              for (const f of cfg.failed) mcp.status.failed(f.name, f.message);
              return cfg;
            },
            // 只换传输层：stdio 服务起在逻辑 local 目录所在的主机上
            createTransport: mcpTransportFactory(mcp.home, mcp.status),
          }),
        ]
      : []),
    // 送达：启用工具集、状态通知、拦截不可用的工具。模式是上限，排在权限扩展之前。
    deliveryExtension(delivery),
    // 占位工具：新增的工具不进冻结声明，经它调用。
    callToolExtension({ callable: delivery.callable }),
    // 模型自己切换模式；没有可切换的模式时不启用。
    ...(spec
      ? []
      : [
          switchModeExtension({
            list: () => host.modeChoices(id),
            current: () => host.entries.get(id)?.activeModeId ?? null,
            switchTo: (modeId) => host.setActiveMode(id, modeId),
            mapping: delivery.mapping,
            skillPath: delivery.skillPath,
          }),
        ]),
    ...(host.deps.hooks
      ? [
          hooksExtension({
            runtime: host.deps.hooks,
            ctx: () => hookCtx(current(), id),
            reject: (message) => host.entries.get(id)?.reject(message),
          }),
        ]
      : []),
    // 子会话没有弹窗，也就没有可提问的人（ADR-0010）。
    ...(spec ? [] : [askUserExtension(ask)]),
    // 目标：续跑由驱动在空闲时注入，工具只在根会话里有（子代理本来就是做完交付）。
    ...(spec ? [] : [goalToolsExtension(() => host.entries.get(id)?.goal)]),
    // 任务清单由模型写入、落到会话状态。
    todoWriteExtension((todos) => {
      const entry = host.entries.get(id);
      if (!entry) throw new Error("会话尚未就绪");
      entry.state.setTodos(todos);
    }),
    routedToolsExtension(
      locateDirectory,
      () => {
        const vars = visibleVars(
          host.deps.secrets?.variableValues() ?? [],
          (v) => v.meta.id,
        );
        return new Map(vars.map((v) => [v.name, v.value]));
      },
      host.deps.jobs ? { jobs: host.deps.jobs, owner: id } : undefined,
      browser
        ? {
            note: (envId, port) =>
              browser.ports.note(
                host.workspaceIdOf(id) ?? `session:${id}`,
                envId,
                port,
              ),
          }
        : undefined,
      locateForTool,
    ),
    ...(host.deps.secrets
      ? [
          variableNoticeExtension({
            list: () =>
              visibleVars(
                host.deps.secrets?.listVariables() ?? [],
                (v) => v.id,
              ),
          }),
          maskingExtension(() => host.deps.secrets?.maskVars() ?? []),
        ]
      : []),
    ...(browser && !spec
      ? [
          browserTools(
            {
              registry: browser.registry,
              cleaner: browser.cleaner,
              targetOptions: () =>
                targetOptions(
                  () => host.deps.environments?.list() ?? [],
                  current().environmentId,
                  host.primaryDirectory(id).environmentId,
                ),
              // 页面归工作区；没有工作区的旧会话用只属于自己的键。
              workspaceKey: () => host.workspaceIdOf(id) ?? `session:${id}`,
              approveOpen: createApproveOpen({
                // 完全允许档或工具规则放行时不问；其余按站点问，通过后记在工作区里。
                auto: () =>
                  host.sessionTier(id) === "full" ||
                  host.deps.toolRules?.effective("browser_open")?.inside ===
                    "allow",
                ask,
                remember: (origin) =>
                  browser.approve(
                    host.workspaceIdOf(id) ?? `session:${id}`,
                    origin,
                  ),
                audit: (rec) =>
                  recordBrowserAudit({
                    kind: "permission",
                    actor: rec.by === "user" ? "user" : "system",
                    summary: `${rec.decision} browser_open: ${rec.origin}`,
                    detail: {
                      op: "browser_open",
                      target: rec.origin,
                      result: rec.decision,
                      tool: "browser_open",
                      decision: rec.decision,
                      by: rec.by,
                    },
                  }),
              }),
              access: browser.access,
              ask,
              // 展示给用户：广播给本工作区此刻在线的界面，只返回送达个数（0 = 没有人看到）。
              show: ({ pageId, title, url, note }) =>
                browser.show.publish(
                  host.workspaceIdOf(id) ?? `session:${id}`,
                  {
                    sessionId: id,
                    by: browser.label(id),
                    pageId,
                    title,
                    url,
                    note,
                  },
                ),
              audit: (entry) =>
                recordBrowserAudit({
                  kind: "tool",
                  actor: "agent",
                  summary: `${entry.tool}: ${entry.summary}`,
                  detail: {
                    op: entry.tool,
                    target: entry.pageId ?? "",
                    result: "ok",
                  },
                }),
              recordStep: (a) => browser.replay.record(a),
              // 工具层拿到的截图与页面图片：先进会话附件区，再按同一套压缩参数交给模型。
              saveAsset: async ({ sessionId: sid, name, bytes }) => {
                const dirs = host.deps.attachments;
                if (!dirs) throw new Error("附件区不可用");
                return {
                  marker: attachmentLine(await dirs.save(sid, name, bytes)),
                };
              },
              // 下载：agent 一次动作期间收到的下载，每次问（完全允许档不问），通过后流式存进会话附件区。
              downloads: browser.downloads,
              approveDownload: createApproveDownload({
                auto: () => host.sessionTier(id) === "full",
                ask,
                audit: (rec) =>
                  recordBrowserAudit({
                    kind: "permission",
                    actor: rec.by === "user" ? "user" : "system",
                    summary: `${rec.decision} browser_download: ${rec.filename}`,
                    detail: {
                      op: "browser_download",
                      target: rec.origin,
                      result: rec.decision,
                      tool: "browser_download",
                      decision: rec.decision,
                      by: rec.by,
                    },
                  }),
              }),
              saveFile: async ({ sessionId: sid, name, write }) => {
                const dirs = host.deps.attachments;
                if (!dirs) throw new Error("附件区不可用");
                const saved = await dirs.saveFrom(sid, name, write);
                return {
                  marker: attachmentLine(saved),
                  size: saved.size,
                  sizeText: saved.sizeText,
                };
              },
              // 下载与上传共用设置里的单个文件上限
              fileMaxBytes: () =>
                host.deps.uploadMaxBytes?.() ?? Number.MAX_SAFE_INTEGER,
              // 上传：来源文件用同一套地址，realpath 之后仍须留在它的归属目录内
              resolveUpload: (hostName, path) =>
                resolveUploadFile(
                  { locate: (h, p) => book.locate(h, p) },
                  hostName,
                  path,
                  host.deps.uploadMaxBytes?.() ?? Number.MAX_SAFE_INTEGER,
                ),
              approveUpload: createApproveUpload({
                // 完全允许档或工具规则放行时不问；其余每次问，不记住。
                auto: () =>
                  host.sessionTier(id) === "full" ||
                  host.deps.toolRules?.effective("browser_upload")?.inside ===
                    "allow",
                ask,
                audit: (rec) =>
                  recordBrowserAudit({
                    kind: "permission",
                    actor: rec.by === "user" ? "user" : "system",
                    summary: `${rec.decision} browser_upload: ${rec.files.join("、")} → ${rec.origin}`,
                    detail: {
                      op: "browser_upload",
                      target: rec.origin,
                      result: rec.decision,
                      tool: "browser_upload",
                      decision: rec.decision,
                      by: rec.by,
                    },
                  }),
              }),
              modelImage: (bytes, mime) =>
                compressImage(
                  bytes,
                  mime,
                  host.deps.imageCompression?.() ?? PI_IMAGE_COMPRESSION,
                  host.deps.imageResize,
                ),
              // 落成附件的文字不过扩展的遮罩，所以工具落文件前自己遮（同 server.ts 里 cleaner 的 mask）。
              mask: (text) =>
                Masker.of(host.deps.secrets?.maskVars() ?? []).mask(text),
              // 高敏感站点每个动作都确认；完全允许档视为用户已接受不再被打扰。
              confirmAction: async ({ tool, host: site, summary }) => {
                if (host.sessionTier(id) === "full") return { allowed: true };
                const r = await ask({
                  source: "approval",
                  input: "text",
                  title: `允许 agent 在 ${site} 上操作？`,
                  body: `${summary}\n\n这类站点（邮箱、云控制台、支付、代码托管等）的每个动作都需要你确认。`,
                  options: [
                    { id: "allow", label: "仅此次通过" },
                    { id: "deny", label: "拒绝" },
                  ],
                  detail: { tool, summary: `${site}：${summary}` },
                });
                const allowed =
                  r.outcome === "answered" && r.optionId === "allow";
                recordBrowserAudit({
                  kind: "permission",
                  actor: r.outcome === "answered" ? "user" : "system",
                  summary: `${allowed ? "allow" : "deny"} ${tool}: ${site} ${summary}`,
                  detail: {
                    op: tool,
                    target: site,
                    result: allowed ? "allow" : "deny",
                    tool,
                    decision: allowed ? "allow" : "deny",
                    by: r.outcome === "answered" ? "user" : r.outcome,
                  },
                });
                return answerVerdict(r);
              },
            },
            id,
          ),
        ]
      : []),
    ...(subagentHooks ? [subagentHooks.tools(id, spec !== undefined)] : []),
    ...(host.deps.jobs
      ? [
          jobExtension(
            host.deps.jobs,
            id,
            delivery.callable,
            combineViews(
              ...(host.deps.teams && host.deps.subagents
                ? [teamJobView(host.deps.teams, host.deps.subagents)]
                : []),
              workflowJobView,
            ),
          ),
        ]
      : []),
    // 灵感画布：只当池里装了 CanvasService 才装；子会话同样能写画布，不特殊处理。
    ...(canvasService
      ? [
          canvasExtension({
            sessionId: id,
            resolve: resolveCanvas,
            // 画布里的主机名相对画布所在的环境：默认画布（主目录）上与地址簿一致
            resolveHost: (t, homeEnvId) => canvasService.hostId(t, homeEnvId),
          }),
          canvasSyncExtension(() => {
            const w = current();
            return canvasService.settle(w.environmentId, w.path, 8000);
          }),
        ]
      : []),
    // 目录：子会话只在一个目录里工作，不装 switch_directory（没有切换的工具，也不可能切）。
    directoryExtension({
      list: () => host.directoryViews(id, current().id),
      ...(spec
        ? {}
        : { switchTo: (ref: string) => host.switchDirectory(id, ref) }),
      takeNotice: async () => {
        const entry = host.entries.get(id);
        const n = entry?.directoryNotice ?? null;
        if (!entry || n === null) return null;
        entry.directoryNotice = null;
        return n + (await host.switchSkillNotice(entry));
      },
    }),
    // 跨主机传文件：两端都是地址，权限见下面的 locate。
    transferExtension({
      sessionId: id,
      locate: (hostName, path) => book.locate(hostName, path),
      audit: host.deps.audit,
    }),
    permissionExtension({
      // 命令类工具的目标目录（bash 的 host）；文件类与传输两端用下面的 locate。
      directoryCtx,
      // 每次工具调用即时读取：改规则立刻对进行中的会话生效。
      toolPolicy: (tool) => host.deps.toolRules?.effective(tool) ?? null,
      mcpApproval: (tool) => {
        // 已注册的 MCP 工具名 → 所属服务，据此取该服务的审批档
        const server = delivery.serverOf(tool);
        return server === undefined
          ? null
          : (host.deps.mcp?.approvalOf(server) ?? null);
      },
      // 命名流程的解析要在审批前发生（弹窗显示真正会运行的脚本），按会话自己的目录与层。
      ...(host.deps.namedWorkflows
        ? {
            namedWorkflows: {
              resolveRun: (name: string, a: unknown) =>
                // 会话当前的目录与层在解析时现读
                (host.deps.namedWorkflows as NamedWorkflows).resolveRun(
                  id,
                  name,
                  a,
                ),
            },
          }
        : {}),
      // 每次工具调用即时读取：改档位/删规则立刻生效；directory 被删时按最严的一档。
      tier: () => host.effectiveTier(id, spec),
      unattended: spec !== undefined,
      ...(host.deps.collab
        ? {
            // 协作区虚拟主机的读写判定：按会话所在的那棵树，子会话只能写自己那份
            collab: {
              allows: (access: "read" | "write", p: string) =>
                host.deps.collab?.allows(
                  host.deps.subagents?.rootOf(id) ?? id,
                  spec ? id : null,
                  access,
                  p,
                ) ?? false,
            },
          }
        : {}),
      // 文件工具与传输的两端都按目标地址的归属目录判（档位、规则、环境与 cwd 都按那一端）。
      locate: locateCtx,
      ask,
      audit: (rec) => {
        if (spec && rec.detail.decision === "deny")
          host.deps.subagents?.addDenial(
            id,
            `${String(rec.detail.tool)}：${String(rec.detail.reason ?? rec.detail.by)}`.slice(
              0,
              160,
            ),
            SUBAGENT_LIMITS.deniedReasons,
          );
        host.deps.audit?.record({
          ...rec,
          kind: "permission",
          sessionId: id,
          environmentId: rec.environmentId ?? current().environmentId,
        });
        host.observe("ApprovalResolved", id, current(), {
          tool_name: String(rec.detail.tool ?? ""),
          decision: String(rec.detail.decision ?? ""),
          by: String(rec.detail.by ?? ""),
          summary: String(rec.detail.target ?? ""),
          ...(rec.detail.reason ? { reason: String(rec.detail.reason) } : {}),
        });
      },
      variables: () =>
        visibleVars(
          host.deps.secrets?.listVariableRecords() ?? [],
          (v) => v.id,
        ),
      ...(host.deps.references
        ? {
            references: {
              // 成功引用顺带维护变量的 lastUsedAt。
              record: (rec) => {
                host.deps.references?.record({
                  ...rec,
                  runId: host.entries.get(id)?.runId ?? null,
                });
                if (rec.result === "ok")
                  host.deps.secrets?.touchVariable(
                    rec.name,
                    new Date().toISOString(),
                  );
              },
            },
          }
        : {}),
      // sudo 探测按这次命令实际所在的环境：不同目录可能在不同主机上。
      sudo: {
        probe: (env, cwd, args) => host.sudoProbe.probe(env, cwd, args),
        invalidate: (envId) => host.sudoProbe.invalidate(envId),
      },
      ...(reviewerFactory
        ? {
            review: (call) => {
              const entry = host.entries.get(id);
              let history: ChatEntry[] = [];
              let toolOutputs: string[] = [];
              try {
                const file = findSessionFile(host.deps.sessionDir, id);
                if (file) {
                  history = readMessages(file, path.dirname(file), id);
                  toolOutputs = readToolOutputs(file, path.dirname(file), id);
                }
              } catch {
                // 取不到证据就只带空证据，仍由审核方或降级兜底
              }
              return runReview(
                reviewerFactory,
                host.deps.reviewCriteria?.(host.workspaceIdOf(id)) ??
                  DEFAULT_CRITERIA,
                call,
                entry?.evidence(history, toolOutputs) ?? {
                  trusted: [],
                  untrusted: [],
                },
                host.deps.reviewTimeoutMs,
              );
            },
          }
        : {}),
    }),
    // 最后注册：看到的就是其它扩展改写之后真正发出的请求体。
    ...(host.deps.calls
      ? [
          callCaptureExtension({
            store: host.deps.calls,
            sessionId: id,
            subagent: spec !== undefined,
            runId: () => host.entries.get(id)?.runId ?? null,
          }),
        ]
      : []),
  ];
}
