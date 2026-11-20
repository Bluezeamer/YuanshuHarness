// 登录态的「提示保存 / 保存 / 管理」：保存即授权。
// 新建上下文注入整份；保存 / 启用一个站点的那一刻，把该站点的状态补进还没这个站点任何状态的已开上下文
// （已有的不覆盖；IndexedDB 补不进已存在的上下文，跳过）。

import type {
  BrowserLoginStore,
  LoginMeta,
} from "../../store/browser-logins.js";
import type { StorageState } from "../engine/types.js";
import { countOf, fingerprint, pickSite, siteOf } from "./site.js";

export type LoginErrorCode = "no_site" | "no_state";

export class LoginError extends Error {
  constructor(
    readonly code: LoginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

export interface LoginDeps {
  store: BrowserLoginStore;
  /** 工作区上下文此刻的完整状态；上下文不在（浏览器没起、崩过）返回 null。 */
  stateOf(workspaceKey: string): Promise<StorageState | null>;
  /** 此刻开着的上下文所属的工作区；用来把登录态补进它们。 */
  liveKeys(): string[];
  /** 把一份状态补进某个工作区的已存在上下文（见 BrowserCtx.seed）。 */
  seed(workspaceKey: string, state: StorageState): Promise<void>;
  /** 用户的动作留痕：只写站点，不写任何状态内容。 */
  audit?(entry: { summary: string; detail: Record<string, unknown> }): void;
}

export interface LoginOffer {
  site: string | null; // 页面所属站点；null = 这类页面没有登录状态可言
  saved: boolean; // 这个站点已有保存
  offer: boolean; // 当前状态与已保存的不同（或还没存过）且确有内容：值得提示用户保存
}

const empty = (state: StorageState): boolean => {
  const n = countOf(state);
  return n.cookies === 0 && n.origins === 0;
};

export class LoginService {
  private readonly store: BrowserLoginStore;
  private readonly stateOf: (
    workspaceKey: string,
  ) => Promise<StorageState | null>;
  private readonly liveKeys: () => string[];
  private readonly seed: (
    workspaceKey: string,
    state: StorageState,
  ) => Promise<void>;
  private readonly audit?: LoginDeps["audit"];

  constructor(deps: LoginDeps) {
    this.store = deps.store;
    this.stateOf = deps.stateOf;
    this.liveKeys = deps.liveKeys;
    this.seed = deps.seed;
    this.audit = deps.audit;
  }

  /** 页面（地址为 url、所在工作区为 workspaceKey）当前值不值得提示保存。 */
  async offer(workspaceKey: string, url: string): Promise<LoginOffer> {
    const site = siteOf(url);
    if (site === null) return { site: null, saved: false, offer: false };
    const stored = this.store.get(site);
    const saved = stored !== null;
    const state = await this.stateOf(workspaceKey);
    if (state === null) return { site, saved, offer: false };
    const current = pickSite(state, site);
    if (empty(current)) return { site, saved, offer: false };
    return {
      site,
      saved,
      offer: stored === null || fingerprint(stored) !== fingerprint(current),
    };
  }

  /** 把页面所属站点的当前状态存下来（覆盖旧的）。 */
  async save(workspaceKey: string, url: string): Promise<LoginMeta> {
    const site = siteOf(url);
    if (site === null)
      throw new LoginError(
        "no_site",
        "这个页面没有可保存的登录状态：本机地址、IP 和不带域名的主机不支持。",
      );
    const state = await this.stateOf(workspaceKey);
    if (state === null)
      throw new LoginError(
        "no_state",
        "浏览器当前没在运行，没有可保存的登录状态。",
      );
    const picked = pickSite(state, site);
    if (empty(picked))
      throw new LoginError(
        "no_state",
        "这个站点在浏览器里还没有 cookie 或本地存储，先登录再保存。",
      );
    const meta = this.store.put(site, picked);
    // 站点此前被用户关掉启用的，保存也不往里补。
    if (meta.enabled) await this.spread(site, picked);
    this.audit?.({
      summary: `browser_login saved: ${site}`,
      detail: { op: "browser_login", target: site, result: "saved" },
    });
    return meta;
  }

  list(): LoginMeta[] {
    return this.store.list();
  }

  async setEnabled(site: string, enabled: boolean): Promise<boolean> {
    const ok = this.store.setEnabled(site, enabled);
    if (!ok) return false;
    this.note(site, enabled ? "enabled" : "disabled");
    // 刚允许 agent 用的站点：补进已开着的上下文（解密失败 / 没存过就跳过）。
    if (enabled) {
      const state = this.store.get(site);
      if (state !== null) await this.spread(site, state);
    }
    return true;
  }

  remove(site: string): boolean {
    const ok = this.store.remove(site);
    if (ok) this.note(site, "removed");
    return ok;
  }

  clear(): number {
    const n = this.store.clear();
    if (n > 0) this.note("all", "cleared", n);
    return n;
  }

  /** 创建工作区上下文时注入的状态；没有可注入的返回 null。 */
  injected(): StorageState | null {
    return this.store.injected();
  }

  /**
   * 把一份站点的状态补进已开着的上下文：只给那些里还没有该站点任何东西的（有 cookie 或有 localStorage 都算有）。
   * 每个上下文各自 try/catch：一个崩了的上下文不能让保存失败，也不影响别的。
   */
  private async spread(site: string, state: StorageState): Promise<void> {
    for (const key of this.liveKeys()) {
      try {
        const cur = await this.stateOf(key);
        if (cur === null) continue;
        if (!empty(pickSite(cur, site))) continue;
        await this.seed(key, pickSite(state, site));
      } catch {
        // 这个上下文写不进去（已经崩了、正在关）：跳过，别的照旧。
      }
    }
  }

  private note(
    site: string,
    result: "enabled" | "disabled" | "removed" | "cleared",
    n = 0,
  ): void {
    this.audit?.({
      summary:
        result === "cleared"
          ? `browser_login cleared: ${n} sites`
          : `browser_login ${result}: ${site}`,
      detail: { op: "browser_login", target: site, result },
    });
  }
}
