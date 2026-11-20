import { mkdirSync, writeFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadableSources } from "../plugins/enabled.js";
import { limitRequests, type RequestLimiter } from "../provider/limiter.js";
import type { ModelResolver } from "../provider/resolve.js";
import { mergeSkills } from "../skills/runtime.js";
import type { ImageCompression } from "../store/defaults.js";
import type { AgentSettingsFile } from "./agent-settings.js";
import { overlayAgentSettings } from "./agent-settings.js";
import { EXCLUDED_TOOLS } from "./delivery.js";
import { HEAD_TYPE } from "./frozen.js";
import type { SessionFactory } from "./pool.js";

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

/**
 * 新会话的 SessionManager，会话头在创建时就落盘。
 * pi 默认等到第一条用户消息才写文件，那样没发过消息的会话重启后就没了，会话库里的标题、配置、分组、布局随之成了孤儿。
 * 这里先用 pi 自己生成的头写出文件（wx：绝不覆盖已有文件），再按已有文件打开，之后 pi 照常追加。
 */
export function createPersistedManager(
  cwd: string,
  sessionDir: string,
  id: string,
): SessionManager {
  const fresh = SessionManager.create(cwd, sessionDir, { id });
  const file = fresh.getSessionFile();
  const header = fresh.getHeader();
  if (!file || !header) return fresh;
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
  return SessionManager.open(file, sessionDir, cwd);
}

// 真实会话工厂。按 agent / 会话选的模型、再按全局默认来取模型（密钥运行时注入）；都没有则沿用 SDK 默认配置目录。
export function createSessionFactory(deps?: {
  resolver: ModelResolver;
  imageCompression?: () => ImageCompression;
  // `<ysHome>/settings.json`：压缩与重试的覆盖值；缺省只按 pi 自己的配置。
  agentSettings?: AgentSettingsFile;
  limiter?: RequestLimiter;
  // 开着的 pi 扩展包（来源集合）；缺省 = 全关。创建与重载时即时读。
  pluginEnabled?: () => ReadonlySet<string>;
}): SessionFactory {
  return async ({
    id,
    sessionDir,
    cwd,
    file,
    extensions,
    agent,
    skills,
    seedHead,
    ui,
  }) => {
    // 会话级设置管理器：除图片压缩开关外沿用 SDK 的全局设置。
    // projectTrusted: false —— 这个 cwd 是用户随时切换的工作目录，项目里的 .pi/ 不读也不写；
    // 插件只认全局（PL4），项目设置一读就等于让仓库自己塞进扩展。加载器与会话共用这一份。
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), {
      projectTrusted: false,
    });
    // pi 的 settings.json 只记装了哪些包，会话加载哪些由我们的开关定（默认全关，整包进或不进）。
    const registered = settingsManager.getGlobalSettings.bind(settingsManager);
    Object.defineProperty(settingsManager, "getGlobalSettings", {
      value: () => {
        const settings = registered();
        return {
          ...settings,
          packages: loadableSources(
            settings.packages,
            deps?.pluginEnabled?.() ?? new Set(),
          ),
        };
      },
    });
    // 压缩 / 重试按 `<ysHome>/settings.json` 覆盖：没写的键仍走 pi 自己的配置。
    if (deps?.agentSettings)
      overlayAgentSettings(settingsManager, deps.agentSettings);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      extensionFactories: extensions,
      // 有 agent 定义时提示词完全由 Server 组装：接管 preamble/tools/rules/docs，
      // 关掉 pi 自带的 AGENTS.md 读取（我们自己按槽位注入）。
      ...(agent
        ? {
            noContextFiles: true,
            // identity 槽 → customPrompt。设置它会让 pi 跳过 tools/rules/docs 的构建，
            // 这三段改由 promptSectionsExtension 按槽位提供。
            systemPromptOverride: (base: string | undefined) =>
              agent.identity() || base,
          }
        : {}),
      // 有库内 skill 时按会话重排提示词里的 skill；缺省不动 pi 的自动发现（ADR-0055）。
      skillsOverride: (base) =>
        skills ? { ...base, skills: mergeSkills(base.skills, skills()) } : base,
    });
    await resourceLoader.reload();
    const sessionManager = file
      ? SessionManager.open(file, sessionDir, cwd)
      : createPersistedManager(cwd, sessionDir, id);
    if (seedHead && !file)
      sessionManager.appendCustomEntry(HEAD_TYPE, seedHead);
    const picked = deps
      ? await deps.resolver.build(
          agent?.modelId ?? null,
          agent?.modelName ?? null,
        )
      : null;
    // agent / 会话没指定档位时，用全局默认模型自带的启动档位
    const thinkingLevel =
      agent?.thinkingLevel ??
      (picked ? deps?.resolver.default()?.thinking : null);
    if (deps?.imageCompression) {
      // 用户消息里的图片在 SessionPool.sendUserMessage 里按设置压缩；这里让 SDK 自己的
      // autoResize 开关与设置保持一致，避免关闭压缩后 SDK 又按 pi 默认压一次。
      const read = deps.imageCompression;
      Object.defineProperty(settingsManager, "getImageAutoResize", {
        value: () => read().enabled,
      });
    }
    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      resourceLoader,
      sessionManager,
      settingsManager,
      ...(picked ? { modelRuntime: picked.runtime, model: picked.model } : {}),
      ...(agent ? { tools: agent.tools } : {}),
      // 白名单里有一个通配 `*`（插件工具的名字不可预知），pi 自带但不归我们的内置工具在这里排除。
      ...(agent ? { excludeTools: [...EXCLUDED_TOOLS] } : {}),
      ...(thinkingLevel
        ? { thinkingLevel: thinkingLevel as ThinkingLevel }
        : {}),
    });
    // 供应商的并发请求数上限：排队与释放都在流函数这一层（压缩与摘要用的也是它）
    limitRequests(session, deps?.limiter);
    // 必须在创建后显式 bind：`session_start` 是在 bindExtensions 里发出的，pi 自己的
    // print / interactive / rpc 三种模式都这么做。不 bind 的话，依赖 session_start 的扩展
    // （最典型的是 pi 的 MCP 扩展：它在 session_start 里读配置、建连接、注册工具）永远不会启动。
    // onError 不是为了处理错误：pi 的 reload 只在会话「有绑定」时才重发 session_start，
    // 没有任何绑定的话，重载之后 MCP 扩展不会重启、工具全部消失。
    // 有 UI 通道时用 rpc 模式：插件按 ctx.mode / hasUI 分流，print 模式下 ui.* 是空操作。
    await session.bindExtensions({
      mode: ui ? "rpc" : "print",
      ...(ui ? { uiContext: ui } : {}),
      onError: () => {},
    });
    return session;
  };
}
