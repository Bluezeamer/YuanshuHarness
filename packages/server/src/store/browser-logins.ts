import type { StorageState } from "../browser/engine/types.js";
import { mergeStates } from "../browser/login/site.js";
import type { Db } from "./db.js";
import { seal, unseal } from "./seal.js";

// 浏览器登录态：一个站点一份（全局，不按工作区），state 是加密后的整段 storageState。
// cookies / origins 是条数，设置页不解密就能列出。
export interface LoginMeta {
  site: string;
  enabled: boolean;
  savedAt: string; // ISO
  cookies: number;
  origins: number;
}

type Row = {
  site: string;
  enabled: number;
  state: Buffer;
  cookies: number;
  origins: number;
  saved_at: string;
};

// 列表用：不取 state，避免把密文读出来（反正不解密）。
type MetaRow = Omit<Row, "state">;

const toMeta = (r: MetaRow): LoginMeta => ({
  site: r.site,
  enabled: r.enabled === 1,
  savedAt: r.saved_at,
  cookies: r.cookies,
  origins: r.origins,
});

export class BrowserLoginStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  /** 全部站点，按 site 升序；不解密。 */
  list(): LoginMeta[] {
    return (
      this.db
        .prepare(
          "SELECT site, enabled, cookies, origins, saved_at FROM browser_logins ORDER BY site",
        )
        .all() as MetaRow[]
    ).map(toMeta);
  }

  /** 解密后的完整状态；没有返回 null。 */
  get(site: string): StorageState | null {
    const r = this.db
      .prepare("SELECT state FROM browser_logins WHERE site = ?")
      .get(site) as { state: Buffer } | undefined;
    return r ? (JSON.parse(unseal(this.key, r.state)) as StorageState) : null;
  }

  /** 覆盖一个站点的状态，保留它原来的 enabled（新站点默认启用）。 */
  put(site: string, state: StorageState, now = new Date()): LoginMeta {
    const cookies = state.cookies.length;
    const origins = state.origins.length;
    const row: Row = {
      site,
      enabled: 1,
      state: seal(this.key, JSON.stringify(state)),
      cookies,
      origins,
      saved_at: now.toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO browser_logins (site, enabled, state, cookies, origins, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET
           state = excluded.state,
           cookies = excluded.cookies,
           origins = excluded.origins,
           saved_at = excluded.saved_at`,
      )
      .run(site, row.enabled, row.state, cookies, origins, row.saved_at);
    return this.meta(site);
  }

  setEnabled(site: string, enabled: boolean): boolean {
    return (
      this.db
        .prepare("UPDATE browser_logins SET enabled = ? WHERE site = ?")
        .run(enabled ? 1 : 0, site).changes > 0
    );
  }

  remove(site: string): boolean {
    return (
      this.db.prepare("DELETE FROM browser_logins WHERE site = ?").run(site)
        .changes > 0
    );
  }

  /** 清空，返回删了几个站点。 */
  clear(): number {
    return this.db.prepare("DELETE FROM browser_logins").run().changes;
  }

  /**
   * 所有 enabled 站点合并成的一份状态；没有启用的站点返回 null。
   * 读不出的站点（主密钥换过、数据被改）跳过：一个坏站点不能让所有工作区都打不开浏览器。
   */
  injected(): StorageState | null {
    const rows = this.db
      .prepare(
        "SELECT state FROM browser_logins WHERE enabled = 1 ORDER BY site",
      )
      .all() as { state: Buffer }[];
    const states: StorageState[] = [];
    for (const r of rows) {
      try {
        states.push(JSON.parse(unseal(this.key, r.state)) as StorageState);
      } catch {
        // 跳过这一个站点
      }
    }
    return states.length === 0 ? null : mergeStates(states);
  }

  private meta(site: string): LoginMeta {
    const r = this.db
      .prepare(
        "SELECT site, enabled, cookies, origins, saved_at FROM browser_logins WHERE site = ?",
      )
      .get(site) as MetaRow;
    return toMeta(r);
  }
}
