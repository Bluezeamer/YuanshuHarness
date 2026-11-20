import { loadToken } from "../../../api/http";
import {
  type CreateProviderInput,
  catalogModels,
  createProvider,
  deleteProvider,
  listProviders,
  logoutProvider,
  type ModelSpec,
  type ProviderView,
  probeModels,
  type TestResult,
  testProvider,
  type UpdateProviderInput,
  updateProvider,
} from "../../../api/providers";
import { type ActionError, describeError } from "./errors";

type Failed = { ok: false } & ActionError;
type Done<T> = { ok: true; data: T };
export type Outcome<T> = Done<T> | Failed;

export type ListState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; list: ProviderView[] };

export interface StoreDeps {
  token?: () => string | null;
}

const fail = (e: unknown): Failed => ({ ok: false, ...describeError(e) });

/**
 * 供应商列表的外部 store（配合 useSyncExternalStore）。
 * 写操作串行：每次编辑的 payload 在轮到它时才基于最新数据构造，连续快速编辑不会互相覆盖。
 */
export function createProvidersStore(deps: StoreDeps = {}) {
  const token = deps.token ?? loadToken;
  let state: ListState = { phase: "loading" };
  const subs = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();

  const set = (next: ListState) => {
    state = next;
    for (const f of subs) f();
  };
  const listOf = (): ProviderView[] =>
    state.phase === "ready" ? state.list : [];
  const put = (v: ProviderView) =>
    set({
      phase: "ready",
      list: listOf().map((p) => (p.id === v.id ? v : p)),
    });

  // 写操作的统一出口：串行。
  const write = <T>(job: () => Promise<Outcome<T>>): Promise<Outcome<T>> => {
    const run = queue.then(job);
    queue = run;
    return run;
  };

  const store = {
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    getSnapshot: (): ListState => state,

    /** 首次加载显示 loading；已有数据时静默刷新。 */
    async load(): Promise<void> {
      if (state.phase !== "ready") set({ phase: "loading" });
      try {
        set({ phase: "ready", list: await listProviders(token()) });
      } catch (e) {
        if (state.phase !== "ready")
          set({ phase: "error", message: describeError(e).message });
      }
    },

    update(
      id: string,
      build: (cur: ProviderView) => UpdateProviderInput,
    ): Promise<Outcome<ProviderView>> {
      return write(async () => {
        const cur = listOf().find((p) => p.id === id);
        if (!cur) return fail(null);
        try {
          const v = await updateProvider(token(), id, build(cur));
          put(v);
          return { ok: true, data: v };
        } catch (e) {
          return fail(e);
        }
      });
    },

    create(input: CreateProviderInput): Promise<Outcome<ProviderView>> {
      return write(async () => {
        try {
          const v = await createProvider(token(), input);
          set({ phase: "ready", list: [...listOf(), v] });
          return { ok: true, data: v };
        } catch (e) {
          return fail(e);
        }
      });
    },

    /** 自定义端点：删掉。内置供应商：清掉元枢里保存的配置，它仍在服务端，回到未配置，所以重新读一遍。 */
    remove(id: string): Promise<Outcome<null>> {
      return write(async () => {
        try {
          const wasCustom = listOf().find((p) => p.id === id)?.custom;
          await deleteProvider(token(), id);
          if (wasCustom)
            set({ phase: "ready", list: listOf().filter((p) => p.id !== id) });
          else await store.load();
          return { ok: true, data: null };
        } catch (e) {
          return fail(e);
        }
      });
    },

    /** 退出订阅登录：服务端把方式改回 API Key 并返回最新视图。 */
    logout(id: string): Promise<Outcome<ProviderView>> {
      return write(async () => {
        try {
          const v = await logoutProvider(token(), id);
          put(v);
          return { ok: true, data: v };
        } catch (e) {
          return fail(e);
        }
      });
    },

    /** 只取端点上的模型 id；不是保存操作，不动页头状态。 */
    async probe(id: string): Promise<Outcome<string[]>> {
      try {
        return { ok: true, data: (await probeModels(token(), id)).ids };
      } catch (e) {
        return fail(e);
      }
    },

    /** 目录里的模型规格（只读）；取不到就当没有，不挡「从端点获取」。 */
    async catalog(id: string): Promise<ModelSpec[]> {
      try {
        return await catalogModels(token(), id);
      } catch {
        return [];
      }
    },

    async test(id: string, model?: string): Promise<Outcome<TestResult>> {
      try {
        const data = await testProvider(token(), id, model);
        // 服务端已写入 lastTest 并重算状态，静默刷新拿最新视图
        await store.load();
        return { ok: true, data };
      } catch (e) {
        return fail(e);
      }
    },
  };
  return store;
}

export type ProvidersStore = ReturnType<typeof createProvidersStore>;
