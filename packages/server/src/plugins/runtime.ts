// pi 包的安装、启停、卸载（docs/model/plugin.md，B7）：直接复用 pi 的包管理器，
// 登记（settings.json 的 packages）与包体（npm / git）都落在 pi 自己的 agentDir 下，
// 与 pi TUI 共用一份。元枢补三件事：安装前预览、不在 Server 上跑包里的安装脚本，
// 以及「会话加载哪些包」的开关——存我们自己的库（默认全关），不写 pi 的 settings.json。
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  type ResolvedPaths,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { HttpError } from "../lib/http-error.js";
import type { PluginSwitchStore } from "../store/plugins.js";
import { sourceOf } from "./enabled.js";

// npm 一律带 --ignore-scripts：包里的生命周期脚本不在 Server 上跑，用户显式允许时才短暂放开。
// 用内存里的 getter 覆盖实现，不写进 settings.json（与 pi TUI 共用的那份不该被我们污染）。
const NPM_IGNORE_SCRIPTS = ["npm", "--ignore-scripts"];
// npm / git 安装时会跑的脚本名；预览据实告诉用户「这个包带脚本」。
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"] as const;

export interface PluginPreview {
  source: string;
  /** 包自己 package.json 里的版本；读不到为 null */
  version: string | null;
  extensionCount: number;
  skillCount: number;
  /** 包是否带安装脚本（默认不跑，要用户勾选） */
  hasInstallScript: boolean;
}

export interface PluginRecord {
  /** pi 登记里的来源原文，开关与卸载都用它 */
  source: string;
  version: string | null;
  /** 整包开关（我们的库里记的）：关着的包不进任何会话 */
  enabled: boolean;
  /** 包体是否已就位（登记了但没装上时为 false） */
  installed: boolean;
  extensionCount: number;
  skillCount: number;
}

const reason = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

interface Manifest {
  version?: string;
  scripts?: Record<string, unknown>;
}

// 读包自己的 package.json：版本与脚本声明，读不到就当没有。
function readManifest(dir: string | undefined): Manifest | null {
  if (dir === undefined) return null;
  try {
    const body: unknown = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    return typeof body === "object" && body !== null
      ? (body as Manifest)
      : null;
  } catch {
    return null;
  }
}

/** 解析结果里第一个带 packageRoot 的资源指向包根；整包没有资源时为 null。 */
function packageRoot(resolved: ResolvedPaths): string | undefined {
  const all = [
    ...resolved.extensions,
    ...resolved.skills,
    ...resolved.prompts,
    ...resolved.themes,
  ];
  return all.find((r) => r.metadata.packageRoot !== undefined)?.metadata
    .packageRoot;
}

export class PluginRuntime {
  private readonly agentDir: string;
  private readonly settings: SettingsManager;
  private readonly pm: DefaultPackageManager;
  // 只在一次 install 期间为 true：npm 命令临时去掉 --ignore-scripts。
  private allowScripts = false;
  // 所有操作串行：install 会临时切换 npm 参数，临时目录也在 preview 与 install 之间共用。
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly switches: Pick<PluginSwitchStore, "enabled" | "set">,
    agentDir = getAgentDir(),
  ) {
    this.agentDir = agentDir;
    // projectTrusted: false —— 项目级 settings.json 不读也不写，包登记只认全局那份。
    this.settings = SettingsManager.create(agentDir, agentDir, {
      projectTrusted: false,
    });
    Object.defineProperty(this.settings, "getNpmCommand", {
      value: () => (this.allowScripts ? undefined : [...NPM_IGNORE_SCRIPTS]),
    });
    this.pm = new DefaultPackageManager({
      cwd: agentDir,
      agentDir,
      settingsManager: this.settings,
    });
  }

  /** 列出已登记的包（只有全局范围）。已装好的包顺带扫出扩展 / skill 数量，不联网。 */
  async list(): Promise<PluginRecord[]> {
    return this.serial(async () => {
      await this.reload();
      const configured = this.pm.listConfiguredPackages();
      const enabled = this.switches.enabled();
      const counts = await this.counts();
      return configured.map((p) => ({
        source: p.source,
        version: readManifest(p.installedPath)?.version ?? null,
        enabled: enabled.has(p.source),
        installed: p.installedPath !== undefined,
        extensionCount: counts.get(p.source)?.extensions ?? 0,
        skillCount: counts.get(p.source)?.skills ?? 0,
      }));
    });
  }

  /** 临时装一份看内容（来源、版本、扩展数、skill 数、有没有安装脚本），不改登记。 */
  async preview(source: string): Promise<PluginPreview> {
    return this.serial(async () => {
      await this.reload();
      const resolved = await this.wrap("preview_failed", () =>
        this.pm.resolveExtensionSources([source], { temporary: true }),
      );
      // 本地路径不存在时 pi 静默跳过，什么也不返回：当成来源无效，别报成「0 个扩展」。
      if (
        resolved.extensions.length === 0 &&
        resolved.skills.length === 0 &&
        resolved.prompts.length === 0 &&
        resolved.themes.length === 0
      )
        throw new HttpError(
          "source_empty",
          `这个来源里没有可加载的内容：${source}`,
          422,
        );
      const manifest = readManifest(packageRoot(resolved));
      return {
        source,
        version: manifest?.version ?? null,
        extensionCount: resolved.extensions.length,
        skillCount: resolved.skills.length,
        hasInstallScript:
          manifest?.scripts !== undefined &&
          LIFECYCLE.some((k) => typeof manifest.scripts?.[k] === "string"),
      };
    });
  }

  /**
   * 正式安装并登记（user 范围），新登记的包随即打开（用户在界面里明确装的）。
   * allowScript 为 false（默认）时 npm 带 --ignore-scripts。
   * 登记进 settings.json 的来源由 pi 规范化（本地路径会变成相对 agentDir 的写法），
   * 调用方按返回的列表取这一条。
   */
  async install(source: string, allowScript = false): Promise<void> {
    await this.serial(async () => {
      await this.reload();
      this.allowScripts = allowScript;
      const before = new Set(this.sources());
      try {
        await this.wrap("install_failed", () =>
          this.pm.installAndPersist(source),
        );
        await this.settings.flush();
      } finally {
        this.allowScripts = false;
      }
      for (const added of this.sources())
        if (!before.has(added)) this.switches.set(added, true);
    });
  }

  async uninstall(source: string): Promise<void> {
    await this.serial(async () => {
      await this.reload();
      this.require(source);
      await this.wrap("uninstall_failed", async () => {
        await this.pm.removeAndPersist(source);
        await this.settings.flush();
      });
      this.switches.set(source, false);
    });
  }

  /** 整包开关：只改我们的库，不碰 pi 的 settings.json。 */
  async toggle(source: string, enabled: boolean): Promise<void> {
    await this.serial(async () => {
      await this.reload();
      this.require(source);
      this.switches.set(source, enabled);
    });
  }

  private sources(): string[] {
    return (this.settings.getGlobalSettings().packages ?? []).map(sourceOf);
  }

  // 不在登记里就不动：前端拿到的来源一定来自 list / install，对不上说明是过期视图。
  private require(source: string): void {
    if (!this.sources().includes(source))
      throw new HttpError("not_found", `没有登记这个包：${source}`, 404);
  }

  /** 串行执行：一次只跑一个包操作。 */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 先落盘再读回：pi TUI 可能刚改过同一份 settings.json，每次操作都以磁盘为准。 */
  private async reload(): Promise<void> {
    await this.settings.flush();
    await this.settings.reload();
  }

  /**
   * 已经装好的包的资源计数。走 resolve()，登记一律按字符串写法算（忽略 pi TUI 写的 extensions 等过滤），
   * 关着的包也显示它带了什么；包体都在，不会联网；缺包时 onMissing 一律跳过，不在列表里触发安装。
   */
  private async counts(): Promise<
    Map<string, { extensions: number; skills: number }>
  > {
    const out = new Map<string, { extensions: number; skills: number }>();
    let resolved: ResolvedPaths;
    try {
      const pm = new DefaultPackageManager({
        cwd: this.agentDir,
        agentDir: this.agentDir,
        settingsManager: SettingsManager.inMemory(
          { packages: this.sources() },
          { projectTrusted: false },
        ),
      });
      resolved = await pm.resolve(async () => "skip");
    } catch {
      return out;
    }
    const bump = (source: string, key: "extensions" | "skills") => {
      const entry = out.get(source) ?? { extensions: 0, skills: 0 };
      entry[key] += 1;
      out.set(source, entry);
    };
    for (const r of resolved.extensions) bump(r.metadata.source, "extensions");
    for (const r of resolved.skills) bump(r.metadata.source, "skills");
    return out;
  }

  // pi 抛的是普通 Error（npm / git 失败、来源不存在），统一翻成 502，消息带到前端。
  private async wrap<T>(code: string, job: () => Promise<T>): Promise<T> {
    try {
      return await job();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(code, reason(err), 502);
    }
  }
}
