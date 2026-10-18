import type { PaneEntry, PaneType } from "./types";

// 以类型标识为键。标识是持久化的字符串，写进用户布局后不能改名。
export class Registry {
  private types = new Map<string, PaneType<never>>();

  register<C>(t: PaneType<C>): this {
    this.types.set(t.id, t as unknown as PaneType<never>);
    return this;
  }

  get(id: string): PaneType<never> | undefined {
    return this.types.get(id);
  }

  list(): PaneType<never>[] {
    return [...this.types.values()];
  }

  newEntry(id: string): PaneEntry | null {
    const t = this.types.get(id);
    if (!t) return null;
    return {
      type: id,
      configVersion: t.configVersion,
      config: t.defaultConfig(),
    };
  }

  // 返回可渲染的配置、迁移后版本号，或 null 表示按"未知 pane"处理（原条目由调用方原样保留）。
  resolve(e: PaneEntry): {
    type: PaneType<never>;
    config: unknown;
    configVersion: number;
  } | null {
    const t = this.types.get(e.type);
    if (!t) return null;
    if (e.configVersion > t.configVersion) return null;
    if (e.configVersion === t.configVersion)
      return { type: t, config: e.config, configVersion: t.configVersion };
    if (!t.migrateConfig) return null;
    try {
      return {
        type: t,
        config: t.migrateConfig(e.config as never, e.configVersion),
        configVersion: t.configVersion,
      };
    } catch {
      return null;
    }
  }
}
