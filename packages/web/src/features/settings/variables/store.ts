import { listConnections } from "../../../api/connections";
import { loadToken } from "../../../api/http";
import {
  addVariable,
  dissolveVariableGroup,
  editVariable,
  fetchVariables,
  type NewVariable,
  type RevealedValue,
  removeVariable,
  renameVariableGroup,
  revealVariable,
  rotateVariable,
  setVariableWorkspaces,
  type VariablePatch,
  type VariableView,
} from "../../../api/variables";
import { listWorkspaces } from "../../../api/workspaces";
import { type ActionError, describeError } from "./errors";
import { DESC_ERROR, type Editable, sameJson } from "./model";

type Failed = { ok: false } & ActionError;
export type Outcome<T> = { ok: true; data: T } | Failed;

/** 工作区选择器里一行要用的东西。 */
export interface WorkspaceBrief {
  id: string;
  name: string;
  /** 主目录路径。 */
  path: string;
  archived: boolean;
}

export type PageState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      variables: VariableView[];
      workspaces: WorkspaceBrief[];
      /** 环境 id → 显示名（引用记录里的「在哪台主机上跑的」）。 */
      hosts: Record<string, string>;
    };

export interface StoreDeps {
  token?: () => string | null;
}

const fail = (e: unknown): Failed => ({ ok: false, ...describeError(e) });

/**
 * 隐私变量页的外部 store（配合 useSyncExternalStore）。
 * 设置（描述、变量组、策略、有效期、启用的工作区）走 `save`，由页面的草稿驱动；
 * 其余都是立即执行的操作。结果的提示（右下角）由调用方弹。
 */
export function createVariablesStore(deps: StoreDeps = {}) {
  const token = deps.token ?? loadToken;
  let state: PageState = { phase: "loading" };
  const subs = new Set<() => void>();

  const set = (next: PageState) => {
    state = next;
    for (const f of subs) f();
  };
  const ready = () => (state.phase === "ready" ? state : null);
  const patchReady = (
    change: Partial<Extract<PageState, { phase: "ready" }>>,
  ) => {
    const cur = ready();
    if (cur) set({ ...cur, ...change });
  };
  const put = (v: VariableView) =>
    patchReady({
      variables: (ready()?.variables ?? []).map((x) => (x.id === v.id ? v : x)),
    });

  const run = async <T>(job: () => Promise<T>): Promise<Outcome<T>> => {
    try {
      return { ok: true, data: await job() };
    } catch (e) {
      return fail(e);
    }
  };

  const store = {
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    getSnapshot: (): PageState => state,

    /** 首次加载显示 loading；已有数据时静默刷新。工作区与主机名读不到不挡住变量。 */
    async load(): Promise<void> {
      if (state.phase !== "ready") set({ phase: "loading" });
      const t = token();
      const [vars, spaces, conns] = await Promise.allSettled([
        fetchVariables(t),
        listWorkspaces(t),
        listConnections(t),
      ]);
      if (vars.status === "rejected") {
        if (state.phase !== "ready")
          set({ phase: "error", message: describeError(vars.reason).message });
        return;
      }
      set({
        phase: "ready",
        variables: vars.value,
        workspaces:
          spaces.status === "fulfilled"
            ? spaces.value.map((w) => ({
                id: w.id,
                name: w.name,
                path: w.directories[0]?.path ?? "",
                archived: w.archived,
              }))
            : [],
        hosts:
          conns.status === "fulfilled"
            ? {
                [conns.value.server.environmentId]: conns.value.server.label,
                ...Object.fromEntries(
                  conns.value.connections.map((c) => [c.id, c.label]),
                ),
              }
            : {},
      });
    },

    add(input: NewVariable): Promise<Outcome<VariableView>> {
      return run(async () => {
        const v = await addVariable(token(), input);
        patchReady({ variables: [...(ready()?.variables ?? []), v] });
        return v;
      });
    },

    /** 保存草稿：只发有变化的字段；基本信息与启用的工作区是两个请求，前一个失败就不发后一个。 */
    save(v: VariableView, draft: Editable): Promise<Outcome<VariableView>> {
      const desc = draft.desc.trim();
      if (desc === "")
        return Promise.resolve({
          ok: false,
          message: DESC_ERROR,
          code: "invalid_desc",
        });
      return run(async () => {
        const patch: VariablePatch = {};
        if (desc !== v.desc) patch.desc = desc;
        if (draft.group !== v.group) patch.group = draft.group;
        if (draft.policy !== v.policy) patch.policy = draft.policy;
        if (!sameJson(draft.expiry, v.expiry)) patch.expiry = draft.expiry;
        let cur = v;
        if (Object.keys(patch).length > 0) {
          cur = await editVariable(token(), v.id, patch);
          put(cur);
        }
        if (!sameJson([...draft.workspaces].sort(), [...v.workspaces].sort())) {
          cur = await setVariableWorkspaces(token(), v.id, draft.workspaces);
          put(cur);
        }
        return cur;
      });
    },

    /** 轮换：换新值；days 型的到期从此刻重新起算（服务端算）。 */
    rotate(
      id: string,
      body: { value: string; fileName?: string },
    ): Promise<Outcome<VariableView>> {
      return run(async () => {
        const v = await rotateVariable(token(), id, body);
        put(v);
        return v;
      });
    },

    /** 删除变量。历史引用记录保留。 */
    remove(id: string): Promise<Outcome<null>> {
      return run(async () => {
        await removeVariable(token(), id);
        patchReady({
          variables: (ready()?.variables ?? []).filter((x) => x.id !== id),
        });
        return null;
      });
    },

    /** 改组名（改到已有的组名就是合并）。 */
    renameGroup(from: string, to: string): Promise<Outcome<null>> {
      return run(async () => {
        await renameVariableGroup(token(), from, to);
        patchReady({
          variables: (ready()?.variables ?? []).map((x) =>
            x.group === from ? { ...x, group: to } : x,
          ),
        });
        return null;
      });
    },

    /** 解散组：成员回到「不分组」。 */
    dissolveGroup(name: string): Promise<Outcome<null>> {
      return run(async () => {
        await dissolveVariableGroup(token(), name);
        patchReady({
          variables: (ready()?.variables ?? []).map((x) =>
            x.group === name ? { ...x, group: null } : x,
          ),
        });
        return null;
      });
    },

    /** 看值是显式动作：服务端记审计，界面 8 秒后重新遮罩。 */
    async reveal(id: string): Promise<Outcome<RevealedValue>> {
      return run(() => revealVariable(token(), id));
    },
  };
  return store;
}

export type VariablesStore = ReturnType<typeof createVariablesStore>;
