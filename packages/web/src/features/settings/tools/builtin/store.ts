import { loadToken } from "../../../../api/http";
import {
  listTools,
  setToolRules,
  type ToolRow,
} from "../../../../api/toolRules";
import { fail, type Outcome } from "../common/errors";
import { createSignal } from "../common/signal";
import type { Rules } from "./model";

export type ToolsState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; tools: ToolRow[] };

export interface StoreDeps {
  token?: () => string | null;
}

// 内置工具规则的 store：设置先在页面上进草稿，点保存时一次提交所有改动。
export function createToolsStore(deps: StoreDeps = {}) {
  const token = deps.token ?? loadToken;
  const sig = createSignal<ToolsState>({ phase: "loading" });

  return {
    subscribe: sig.subscribe,
    getSnapshot: sig.get,

    async load(): Promise<void> {
      if (sig.get().phase !== "ready") sig.set({ phase: "loading" });
      try {
        sig.set({ phase: "ready", tools: await listTools(token()) });
      } catch (e) {
        if (sig.get().phase !== "ready")
          sig.set({ phase: "error", message: fail(e).message });
      }
    },

    /** 原子保存；成功后用服务端返回的全量替换。 */
    async save(rules: Rules): Promise<Outcome<ToolRow[]>> {
      try {
        const tools = await setToolRules(token(), rules);
        sig.set({ phase: "ready", tools });
        return { ok: true, data: tools };
      } catch (e) {
        return fail(e);
      }
    },
  };
}

export type ToolsStore = ReturnType<typeof createToolsStore>;
