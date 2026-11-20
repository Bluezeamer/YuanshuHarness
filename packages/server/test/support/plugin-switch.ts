import type { PluginSwitchStore } from "../../src/store/plugins.js";

// 内存版的包开关，给不需要真实库的测试用。
export function memorySwitch(): Pick<PluginSwitchStore, "enabled" | "set"> {
  const on = new Set<string>();
  return {
    enabled: () => new Set(on),
    set: (source, enable) => {
      if (enable) on.add(source);
      else on.delete(source);
    },
  };
}
