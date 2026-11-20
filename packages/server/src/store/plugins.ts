// pi 扩展包「是否加载」的开关（docs/model/plugin.md）：pi 的 settings.json 只记装了哪些包，
// 开关存我们自己的库。存 meta 表里的一条 JSON 数组；没有记录 = 全关，
// 装在 pi 里但没在这里打开过的包不会进任何会话。
import type { Db } from "./db.js";

const KEY = "enabled_plugins";

export class PluginSwitchStore {
  constructor(private readonly db: Db) {}

  /** 每次会话创建 / 重载时即时读 */
  enabled(): ReadonlySet<string> {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(KEY) as { value: string } | undefined;
    return new Set(row ? (JSON.parse(row.value) as string[]) : []);
  }

  set(source: string, on: boolean): void {
    const next = new Set(this.enabled());
    if (on) next.add(source);
    else next.delete(source);
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY, JSON.stringify([...next]));
  }
}
