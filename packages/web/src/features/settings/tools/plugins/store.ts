import { loadToken } from "../../../../api/http";
import {
  installPlugin,
  listPlugins,
  type PluginPreview,
  type PluginView,
  previewPlugin,
  setPluginEnabled,
  uninstallPlugin,
} from "../../../../api/pluginLibrary";
import { fail, type Outcome } from "../common/errors";
import { createSignal } from "../common/signal";

export type PluginState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      plugins: PluginView[];
      /** 正在跑的行级操作（来源 → 行上显示的文案）。 */
      busy: Readonly<Record<string, string>>;
    };

export type PluginReady = Extract<PluginState, { phase: "ready" }>;

export interface StoreDeps {
  token?: () => string | null;
}

export function createPluginStore(deps: StoreDeps = {}) {
  const token = deps.token ?? loadToken;
  const sig = createSignal<PluginState>({ phase: "loading" });

  const ready = (): PluginReady | null => {
    const s = sig.get();
    return s.phase === "ready" ? s : null;
  };

  // 登记在 settings.json 里，pi TUI 也可能改它；每次写之后都以服务端的列表为准
  const reload = async (): Promise<PluginView[]> => {
    const plugins = await listPlugins(token());
    const cur = ready();
    sig.set({ phase: "ready", plugins, busy: cur?.busy ?? {} });
    return plugins;
  };

  const write = async <T>(
    source: string | null,
    text: string,
    job: () => Promise<T>,
  ): Promise<Outcome<T>> => {
    const mark = (on: boolean) => {
      const s = ready();
      if (!s || source === null) return;
      const busy = { ...s.busy };
      if (on) busy[source] = text;
      else delete busy[source];
      sig.set({ ...s, busy });
    };
    mark(true);
    try {
      const data = await job();
      return { ok: true, data };
    } catch (e) {
      return fail(e);
    } finally {
      mark(false);
    }
  };

  return {
    subscribe: sig.subscribe,
    getSnapshot: sig.get,

    async load(): Promise<void> {
      if (!ready()) sig.set({ phase: "loading" });
      try {
        await reload();
      } catch (e) {
        if (!ready()) sig.set({ phase: "error", message: fail(e).message });
      }
    },

    /** 安装前预览：临时装一份看内容，不改登记，不是保存操作。 */
    async preview(source: string): Promise<Outcome<PluginPreview>> {
      try {
        return { ok: true, data: await previewPlugin(token(), source) };
      } catch (e) {
        return fail(e);
      }
    },

    /** 装好后返回登记里这一条的来源（pi 会把本地路径规范化，与输入不一定相同）。 */
    async install(
      source: string,
      allowScript: boolean,
    ): Promise<Outcome<string | null>> {
      const before = new Set((ready()?.plugins ?? []).map((p) => p.source));
      const r = await write(null, "", async () => {
        await installPlugin(token(), source, allowScript);
        const plugins = await reload();
        return plugins.find((p) => !before.has(p.source))?.source ?? null;
      });
      return r;
    },

    setEnabled: (source: string, enabled: boolean) =>
      write(source, enabled ? "启用中" : "停用中", async () => {
        await setPluginEnabled(token(), source, enabled);
        await reload();
      }),

    remove: (source: string) =>
      write(source, "卸载中", async () => {
        await uninstallPlugin(token(), source);
        await reload();
      }),
  };
}

export type PluginStore = ReturnType<typeof createPluginStore>;
