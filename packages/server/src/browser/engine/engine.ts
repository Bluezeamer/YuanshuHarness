// 浏览器进程与上下文的生命周期：一个进程，每个工作区一个上下文。
// 安装、启动失败都收成 Problem（中文、带修法），上层原样展示给人看。
import type { Browser, BrowserContext, Page } from "playwright-core";
import { CLIPBOARD_INIT } from "./clipboard.js";
import {
  AUTO_INSTALL_ENV,
  BROWSER_ENV,
  findExecutable,
  type InstallDeps,
  InstallError,
  installChromium,
} from "./install.js";
import { type LaunchResult, launchBrowser } from "./launch.js";
import { wrapPage } from "./page.js";
import { RequestJars } from "./request.js";
import type {
  BrowserCtx,
  ContextOptions,
  EngineState,
  PageHandle,
  Problem,
  StorageState,
} from "./types.js";
import { VIEWPORT } from "./types.js";

export interface EngineDeps extends Omit<InstallDeps, "run"> {
  log?: (msg: string) => void;
}

export class EngineError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message);
  }
}

const noop = () => {};

// 浏览器里的 DOM 形状（server 的 tsconfig 不含 dom 库）。
interface DomStorage {
  setItem(key: string, value: string): void;
}
interface DomStorageWindow {
  localStorage: DomStorage;
}

/** 把一批 localStorage 条目写进当前页面的源。会被序列化进浏览器执行。 */
export function setLocalStorage(
  entries: { name: string; value: string }[],
): void {
  const g = globalThis as unknown as DomStorageWindow;
  for (const e of entries) g.localStorage.setItem(e.name, e.value);
}

// 启动失败的 Playwright 原文 → Problem。装依赖要 root，只能给人可复制的命令。
export function classifyLaunchError(msg: string): Problem {
  if (/Host system is missing dependencies|install-deps/i.test(msg)) {
    const missing = msg
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("lib") || l.includes("apt-get install"));
    return {
      code: "missing_libs",
      message: `浏览器缺少系统运行库，无法启动。${missing.length ? `\n${missing.join("\n")}` : ""}`,
      fix: "npx playwright-core install-deps chromium（需要 root 权限）",
    };
  }
  if (/Executable doesn't exist|please run the following command/i.test(msg))
    return {
      code: "not_installed",
      message: "浏览器还没装好。",
      fix: "在设置里打开浏览器，或运行 npx playwright-core install chromium --no-shell",
    };
  return {
    code: "launch_failed",
    message: `浏览器启动失败：${msg}`,
  };
}

interface CtxRecord {
  ctx: BrowserContext;
  // 请求出口：页面自己的上下文加最多 8 个命名身份的隔离罐，随上下文一起关。
  jars: RequestJars;
  // newPage() 创建的页面放这里，用来和页面自己开的（弹窗）区分。
  ours: WeakSet<Page>;
  // 正在创建中的 newPage()：ctx.on("page") 先于 newPage() 返回，要等它落定才能判定归属。
  creating: Set<Promise<unknown>>;
  handles: Map<Page, PageHandle>;
  popups: Set<(p: PageHandle) => void>;
}

export class Engine {
  private readonly deps: EngineDeps;
  private current: EngineState = {
    status: "idle",
    executable: null,
    sandbox: null,
    emojiFont: null,
    problem: null,
  };
  private readonly subs = new Set<(s: EngineState) => void>();

  private launching: Promise<void> | null = null;
  private live: { browser: Browser; userAgent: string } | null = null;
  private readonly ctxs = new Map<BrowserContext, CtxRecord>();
  private readonly crashes = new Set<() => void>();
  private closed = false;

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  state(): EngineState {
    return this.current;
  }

  subscribe(cb: (s: EngineState) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  private set(patch: Partial<EngineState>): void {
    this.current = { ...this.current, ...patch };
    for (const cb of this.subs) cb(this.current);
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  private async start(): Promise<void> {
    const env = this.deps.env ?? process.env;
    const executable = await findExecutable(this.deps);
    if (!executable) {
      if (env[AUTO_INSTALL_ENV] === "0") {
        const problem: Problem = {
          code: "not_installed",
          message: "浏览器还没装好，自动下载已被环境变量关闭。",
          fix: `运行 npx playwright-core install chromium --no-shell，或去掉 ${AUTO_INSTALL_ENV}=0 后重启 Server。`,
        };
        this.set({
          status: "failed",
          executable: null,
          sandbox: null,
          emojiFont: null,
          problem,
        });
        throw new EngineError(problem);
      }
      this.set({
        status: "installing",
        executable: null,
        sandbox: null,
        emojiFont: null,
        problem: null,
      });
      try {
        await installChromium(this.deps, (line) => this.log(line));
      } catch (err) {
        const problem: Problem = {
          code: "download_failed",
          message:
            err instanceof InstallError
              ? err.message
              : `下载浏览器失败：${String(err)}`,
        };
        this.set({
          status: "failed",
          executable: null,
          sandbox: null,
          emojiFont: null,
          problem,
        });
        throw new EngineError(problem);
      }
    }
    const exe = executable ?? (await findExecutable(this.deps));
    if (!exe) {
      const problem: Problem = {
        code: "not_installed",
        message: "浏览器装好了但找不到可执行文件。",
        fix: `检查数据目录下 browser/ 里有没有 chromium 目录，或用环境变量 ${BROWSER_ENV} 指向自备的浏览器。`,
      };
      this.set({
        status: "failed",
        executable: null,
        sandbox: null,
        emojiFont: null,
        problem,
      });
      throw new EngineError(problem);
    }

    this.set({
      status: "starting",
      executable: exe,
      sandbox: null,
      emojiFont: null,
      problem: null,
    });
    let result: LaunchResult;
    try {
      result = await launchBrowser(exe, this.deps);
    } catch (err) {
      const problem = classifyLaunchError(
        err instanceof Error ? err.message : String(err),
      );
      this.set({
        status: "failed",
        executable: exe,
        sandbox: null,
        emojiFont: null,
        problem,
      });
      throw new EngineError(problem);
    }
    this.attach(result.browser, exe, result);
  }

  private attach(
    browser: Browser,
    executable: string,
    result: LaunchResult,
  ): void {
    this.live = { browser, userAgent: result.userAgent };
    this.set({
      status: "ready",
      executable,
      sandbox: result.sandbox,
      emojiFont: result.emojiFont,
      problem: null,
    });
    browser.on("disconnected", () => {
      if (this.live?.browser !== browser) return;
      this.live = null;
      for (const rec of this.ctxs.values()) rec.handles.clear();
      this.ctxs.clear();
      if (this.closed) return;
      this.set({
        status: "idle",
        sandbox: null,
        emojiFont: null,
        problem: null,
      });
      for (const cb of this.crashes) cb();
    });
  }

  /** 保证浏览器可用：没装就装（除非自动下载被关），再启动。并发调用共享同一次。 */
  async ensure(): Promise<void> {
    if (this.closed) throw new Error("浏览器引擎已关闭");
    if (this.live) return;
    if (!this.launching) {
      this.launching = this.start().finally(() => {
        this.launching = null;
      });
    }
    await this.launching;
  }

  private async browser(): Promise<{ browser: Browser; userAgent: string }> {
    await this.ensure();
    const live = this.live;
    if (!live)
      throw new EngineError({
        code: "launch_failed",
        message: "浏览器进程不在，请重试。",
      });
    return live;
  }

  async context(opts: ContextOptions): Promise<BrowserCtx> {
    const { browser, userAgent } = await this.browser();
    const ctx = await browser.newContext({
      viewport: { ...VIEWPORT },
      permissions: [],
      acceptDownloads: true, // 下载落进会话附件区；由 page 层包装成 PageDownload 并派发（见 engine/page.ts）
      userAgent,
      proxy: opts.proxy,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    // 页面里的复制（分享按钮之类）在 JS 层截获，见 clipboard.ts；不给上下文任何剪贴板权限。
    await ctx.addInitScript(CLIPBOARD_INIT);
    // 命名身份要跟页面走同一个出口、同一份 UA（request.newContext 默认 UA 是 Playwright/…）。
    const jars = new RequestJars(ctx, opts.proxy, userAgent);
    const rec: CtxRecord = {
      ctx,
      jars,
      ours: new WeakSet<Page>(),
      creating: new Set<Promise<unknown>>(),
      handles: new Map<Page, PageHandle>(),
      popups: new Set<(p: PageHandle) => void>(),
    };
    this.ctxs.set(ctx, rec);

    // 页面自己开的（window.open、target=_blank）在这里冒出来；newPage() 创建的已在 ours 里。
    ctx.on("page", (page) => {
      void (async () => {
        await Promise.allSettled([...rec.creating]);
        if (rec.ours.has(page) || rec.handles.has(page)) return;
        await this.adopt(rec, page);
      })();
    });

    return {
      newPage: async () => {
        // 在 then 里登记，保证等在 creating 上的 handler 醒来时归属已经定下来。
        const pending = ctx.newPage().then((p) => {
          rec.ours.add(p);
          return p;
        });
        rec.creating.add(pending);
        try {
          return this.track(rec, await pending, null);
        } finally {
          rec.creating.delete(pending);
        }
      },
      onPopup: (cb) => {
        rec.popups.add(cb);
        return () => {
          rec.popups.delete(cb);
        };
      },
      storageState: () => ctx.storageState({ indexedDB: true }),
      seed: (state) => this.seed(rec, state),
      close: async () => {
        this.ctxs.delete(ctx);
        rec.handles.clear();
        await jars.close();
        await ctx.close().catch(noop);
      },
    };
  }

  /**
   * 把登录态补进已存在的上下文：cookie 直接加，localStorage 靠临时页写。
   * IndexedDB 没有写入已存在上下文的接口，不补（新建上下文注入时会带上）。
   */
  private async seed(rec: CtxRecord, state: StorageState): Promise<void> {
    if (state.cookies.length > 0) await rec.ctx.addCookies(state.cookies);
    for (const entry of state.origins) {
      if (entry.localStorage.length === 0) continue;
      // 登记手法同 newPage：先等落到 ours 里，ctx.on("page") 才不会把它当弹窗收养。
      const pending = rec.ctx.newPage().then((p) => {
        rec.ours.add(p);
        return p;
      });
      rec.creating.add(pending);
      let page: Page;
      try {
        page = await pending;
      } finally {
        rec.creating.delete(pending);
      }
      try {
        // 临时页不出网：路由把一切请求就地回掉（空的 HTML），所以不走代理。
        await page.route("**/*", (route) =>
          route.fulfill({ contentType: "text/html", body: "" }),
        );
        await page.goto(`${entry.origin}/`);
        await page.evaluate(setLocalStorage, entry.localStorage);
      } finally {
        await page.close().catch(noop);
      }
    }
  }

  private track(
    rec: CtxRecord,
    page: Page,
    opener: PageHandle | null,
  ): PageHandle {
    const existing = rec.handles.get(page);
    if (existing) return existing;
    const handle = wrapPage(page, rec.ctx, rec.jars, opener);
    rec.handles.set(page, handle);
    handle.onClose(() => rec.handles.delete(page));
    return handle;
  }

  private async adopt(rec: CtxRecord, page: Page): Promise<void> {
    // 先等它的来源页面登记好，才能把 opener 指对。
    const source = await page.opener().catch(() => null);
    const opener = source ? (rec.handles.get(source) ?? null) : null;
    const handle = this.track(rec, page, opener);
    for (const cb of rec.popups) cb(handle);
  }

  contextCount(): number {
    return this.ctxs.size;
  }

  /** 浏览器进程意外退出时回调（所有上下文作废）；下一次 ensure / context 会重新启动。 */
  onCrash(cb: () => void): () => void {
    this.crashes.add(cb);
    return () => {
      this.crashes.delete(cb);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.crashes.clear();
    const live = this.live;
    this.live = null;
    this.ctxs.clear();
    if (live) await live.browser.close().catch(noop);
    this.set({ status: "idle", sandbox: null, emojiFont: null, problem: null });
  }
}
