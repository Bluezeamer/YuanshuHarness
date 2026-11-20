// 浏览器服务：把引擎、出站代理、页面注册表、清洗层与站点批准记录装在一起，
// 供接线（server.ts）、会话工具与 HTTP 接口共用。代理在第一次要上下文时才起，Server 没人用浏览器就不占端口。
import path from "node:path";
import { BrowserLoginStore } from "../store/browser-logins.js";
import { BrowserPageStore } from "../store/browser-pages.js";
import { BrowserStepStore } from "../store/browser-steps.js";
import type { Db } from "../store/db.js";
import type { WatchHub } from "../watch/hub.js";
import type { AccessState } from "./agent/access.js";
import type { Cleaner } from "./agent/clean/types.js";
import {
  createPendingDownloads,
  type PendingDownloads,
} from "./downloads/pending.js";
import {
  createDownloadWindows,
  type DownloadWindows,
} from "./downloads/windows.js";
import type { Engine } from "./engine/engine.js";
import type { BrowserCtx } from "./engine/types.js";
import { type LoginDeps, LoginService } from "./login/login.js";
import {
  type Proxy as EgressProxy,
  type ProxyContext,
  type ProxyDeps,
  type Registration,
  startProxy,
} from "./net/proxy.js";
import { PageRegistry } from "./pages/registry.js";
import { createFileReload } from "./pages/reload.js";
import { ThumbStore } from "./pages/thumbs.js";
import type { Limits } from "./pages/types.js";
import { PortBook } from "./ports/book.js";
import { isListening } from "./ports/probe.js";
import { FrameStore } from "./replay/frames.js";
import { Replay } from "./replay/replay.js";
import { createShowBus, type ShowBus } from "./show.js";
import {
  createPendingUploads,
  type PendingUploads,
} from "./uploads/pending.js";

export interface BrowserServiceDeps {
  dataDir: string;
  db: Db;
  /** 主密钥：浏览器登录态与密码库同一把。 */
  masterKey: Buffer;
  engine: Pick<Engine, "context" | "onCrash" | "close">;
  proxy: ProxyDeps;
  cleaner: Cleaner;
  /** 文件变更监听（文件页跟着文件变化自动刷新用）。 */
  watch: Pick<WatchHub, "set" | "release" | "onChanged">;
  /** 工作区的出站范围：裸 localhost 指向哪个环境、哪些服务与文件可达。 */
  scope(workspaceKey: string): ProxyContext;
  /** 会话的根会话（子代理 → 它的根）；没有层级的返回自己。 */
  rootOf(sessionId: string): string;
  /** 根会话此刻是不是在跑一轮。 */
  isBusy(rootSessionId: string): boolean;
  label?(sessionId: string): string;
  limits?: Partial<Limits>;
  /** 登录态动作的留痕；只记站点，不记状态内容。 */
  audit?: LoginDeps["audit"];
}

export class BrowserService {
  readonly registry: PageRegistry;
  readonly cleaner: Cleaner;
  /** 回放：agent 动作之后的画面与说明，供事后的时间线。 */
  readonly replay: Replay;
  /** 本工作区已批准的外部站点；记在内存里，重启后重新问。 */
  readonly access: AccessState;
  /** 本工作区见过的本机端口（bash 输出里认出来的）；也在内存里，重启即忘。 */
  readonly ports = new PortBook();
  /** 登录态：全局按站点保存，新建上下文时注入，保存 / 启用时补进已开着的上下文。 */
  readonly login: LoginService;
  /** 下载窗口：agent 一次动作期间收下载，窗口外的取消。 */
  readonly downloads: DownloadWindows;
  /** 用户页上挂起、等用户决定存到哪的下载。 */
  readonly pending: PendingDownloads;
  /** 用户页上挂起、等用户选本机文件的选择器。 */
  readonly pendingUploads: PendingUploads;
  /** 工作区级的「展示给用户」广播：agent 用 browser_show 提示用户看某个页面。 */
  readonly show: ShowBus = createShowBus();
  private readonly deps: BrowserServiceDeps;
  private proxy: Promise<EgressProxy> | null = null;
  private readonly regs = new Map<string, Registration>();
  private readonly approvedOrigins = new Map<string, Set<string>>();

  constructor(deps: BrowserServiceDeps) {
    this.deps = deps;
    // 待处理清单的变化要写进页面状态，而 onChange 是调用时才取 this.registry，所以这里先就绪无妨。
    this.pending = createPendingDownloads({
      root: path.join(deps.dataDir, "browser-downloads"),
      onChange: (pageId, items) =>
        this.registry.setPendingDownloads(pageId, items),
    });
    // 上次异常退出留下的暂存文件：没人再来认领，清掉。
    void this.pending.sweep().catch(() => {});
    // 用户页上的文件选择：挂起项的变化直接写进页面状态（同样在调用时才取 this.registry）。
    this.pendingUploads = createPendingUploads({
      onChange: (pageId, item) => this.registry.setPendingUpload(pageId, item),
    });
    this.downloads = createDownloadWindows({
      rootOf: deps.rootOf,
      userDownload: (page, d) => {
        if (!this.pending.add(page.id, d))
          void d.cancel("这一页待处理的下载已满，先处理掉前面的");
      },
    });
    this.cleaner = deps.cleaner;
    this.access = {
      approved: (workspaceKey, origin) =>
        this.approvedOrigins.get(workspaceKey)?.has(origin) ?? false,
      known: (workspaceKey, envId, port) =>
        this.ports.has(workspaceKey, envId, port),
    };
    this.registry = new PageRegistry({
      store: new BrowserPageStore(deps.db),
      thumbs: new ThumbStore(path.join(deps.dataDir, "browser-thumbs")),
      context: (workspaceKey) => this.openContext(workspaceKey),
      rootOf: deps.rootOf,
      isBusy: deps.isBusy,
      onDownload: (page, d) => this.downloads.dispatch(page, d),
      // 用户页上的文件选择挂起等用户选文件；agent 页上的不管，agent 自己用 browser_upload。
      onFileChooser: (page, c) => {
        if (page.controller === "user") this.pendingUploads.add(page.id, c);
      },
      ...(deps.label ? { label: deps.label } : {}),
      ...(deps.limits ? { limits: deps.limits } : {}),
    });
    this.registry.restore();
    this.login = new LoginService({
      store: new BrowserLoginStore(deps.db, deps.masterKey),
      stateOf: (key) => this.registry.storageState(key),
      liveKeys: () => this.registry.contextKeys(),
      seed: (key, state) => this.registry.seedState(key, state),
      ...(deps.audit ? { audit: deps.audit } : {}),
    });
    // 回放要的 registry 在上面装好了，这里只取它的 peek。
    this.replay = new Replay({
      steps: new BrowserStepStore(deps.db),
      frames: new FrameStore(path.join(deps.dataDir, "browser-replay")),
      registry: this.registry,
      rootOf: deps.rootOf,
    });
    // agent 控制的文件页跟着文件变化刷新：只在页面状态变化时登记 / 退订。
    const reload = createFileReload({
      watch: deps.watch,
      reload: (id) => this.registry.reloadFile(id),
    });
    // 页面没了，清洗层存的上一份快照也不再有用，挂着的下载与文件选择跟着作废。
    this.registry.subscribe((e) => {
      if (e.type === "removed") {
        reload.forget(e.id);
        deps.cleaner.forgetPage(e.id);
        void this.pending.dropPage(e.id);
        this.pendingUploads.dropPage(e.id);
      } else {
        reload.track(e.page);
      }
    });
    deps.engine.onCrash(() => this.registry.onEngineCrash());
  }

  /** 用户在审批卡片上点了通过：这个工作区之后不再问这个站点。 */
  approve(workspaceKey: string, origin: string): void {
    const set = this.approvedOrigins.get(workspaceKey) ?? new Set<string>();
    set.add(origin);
    this.approvedOrigins.set(workspaceKey, set);
  }

  /** 会话的显示名（会话名，缺省取 id 前 8 位）：展示提示里用它。 */
  label(sessionId: string): string {
    return this.deps.label?.(sessionId) ?? sessionId.slice(0, 8);
  }

  /** 根会话归档 / 删除：引用计数，没人用了的页面直接关。 */
  async releaseSession(sessionId: string): Promise<void> {
    await this.registry.releaseSession(sessionId);
  }

  /** 工作区删除：关页面、删记录、关上下文、忘掉批准记录与见过的端口。 */
  async forgetWorkspace(workspaceKey: string): Promise<void> {
    await this.registry.forgetWorkspace(workspaceKey);
    this.approvedOrigins.delete(workspaceKey);
    this.ports.forget(workspaceKey);
  }

  /** 本工作区见过、且此刻真在监听的端口；保持记下的先后。 */
  async listeningPorts(
    workspaceKey: string,
  ): Promise<{ envId: string; port: number }[]> {
    const list = this.ports.list(workspaceKey);
    const alive = await Promise.all(
      list.map((e) => isListening(this.deps.proxy.env(e.envId), e.port)),
    );
    return list.filter((_, i) => alive[i]);
  }

  async close(): Promise<void> {
    await this.registry.dispose();
    const proxy = this.proxy;
    this.proxy = null;
    await (await proxy?.catch(() => null))?.close();
    await this.deps.engine.close();
  }

  private startProxy(): Promise<EgressProxy> {
    if (!this.proxy) {
      this.proxy = startProxy(this.deps.proxy);
      // 起不来不能把失败缓存住：下次再试。
      this.proxy.catch(() => {
        this.proxy = null;
      });
    }
    return this.proxy;
  }

  /** 每个工作区一个浏览上下文，流量只走本进程的代理，代理按令牌认出是哪个工作区。 */
  private async openContext(workspaceKey: string): Promise<BrowserCtx> {
    const proxy = await this.startProxy();
    // 浏览器崩过之后重建：旧令牌随旧上下文一起作废。
    this.regs.get(workspaceKey)?.unregister();
    const reg = proxy.register(this.deps.scope(workspaceKey));
    this.regs.set(workspaceKey, reg);
    let ctx: BrowserCtx;
    try {
      // 新建的上下文注入整份；之后保存 / 启用站点的，由 LoginService 补进已开着的上下文。
      const state = this.login.injected();
      ctx = await this.deps.engine.context({
        // 代理只看用户名（令牌），密码给个占位。
        proxy: {
          server: `http://127.0.0.1:${proxy.port}`,
          username: reg.token,
          password: "x",
        },
        ...(state ? { storageState: state } : {}),
      });
    } catch (err) {
      this.drop(workspaceKey, reg);
      throw err;
    }
    return {
      newPage: () => ctx.newPage(),
      onPopup: (cb) => ctx.onPopup(cb),
      storageState: () => ctx.storageState(),
      seed: (state) => ctx.seed(state),
      close: async () => {
        this.drop(workspaceKey, reg);
        await ctx.close();
      },
    };
  }

  private drop(workspaceKey: string, reg: Registration): void {
    reg.unregister();
    if (this.regs.get(workspaceKey) === reg) this.regs.delete(workspaceKey);
  }
}
