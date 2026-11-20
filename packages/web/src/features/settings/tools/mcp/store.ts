import { loadToken } from "../../../../api/http";
import {
  batchMcp,
  checkAllMcp,
  checkMcp,
  createMcp,
  deleteMcp,
  listMcp,
  type McpBatchAction,
  type McpBatchItem,
  type McpCheck,
  type McpVersions,
  type McpView,
  mcpVersions,
  type PinSuccess,
  patchMcp,
  tryPinMcp,
  updateMcp,
  validateMcp,
} from "../../../../api/mcpLibrary";
import type { Policy } from "../../../../api/toolRules";
import { fail, type Outcome } from "../common/errors";
import { createSignal } from "../common/signal";

export type McpState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      servers: McpView[];
      /** 正在跑的行级操作，值是行上显示的文案。 */
      busy: Readonly<Record<string, string>>;
      /** 本次会话里每个服务最近一次检测的三步结果（展开区显示）。 */
      checks: Readonly<Record<string, McpCheck>>;
    };

export type McpReady = Extract<McpState, { phase: "ready" }>;
type Ready = McpReady;

export interface StoreDeps {
  token?: () => string | null;
}

export interface CheckSummary {
  total: number;
  ready: number;
  /** 没通过的服务及原因。 */
  failed: { name: string; message: string }[];
}

export function createMcpStore(deps: StoreDeps = {}) {
  const token = deps.token ?? loadToken;
  const sig = createSignal<McpState>({ phase: "loading" });

  const ready = (): Ready | null => {
    const s = sig.get();
    return s.phase === "ready" ? s : null;
  };
  const patch = (fn: (s: Ready) => Ready) => {
    const s = ready();
    if (s) sig.set(fn(s));
  };
  const put = (v: McpView) =>
    patch((s) => ({
      ...s,
      servers: s.servers.some((k) => k.name === v.name)
        ? s.servers.map((k) => (k.name === v.name ? v : k))
        : [v, ...s.servers],
    }));
  const replaceAll = (servers: McpView[]) => patch((s) => ({ ...s, servers }));
  const drop = (name: string) =>
    patch((s) => ({ ...s, servers: s.servers.filter((k) => k.name !== name) }));
  const keepCheck = (c: McpCheck) =>
    patch((s) => ({ ...s, checks: { ...s.checks, [c.name]: c } }));

  const write = async <T>(
    job: () => Promise<T>,
    busy?: { names: readonly string[]; text: string },
  ): Promise<Outcome<T>> => {
    const mark = (on: boolean) =>
      patch((s) => {
        const next = { ...s.busy };
        for (const n of busy?.names ?? []) {
          if (on) next[n] = busy?.text ?? "";
          else delete next[n];
        }
        return { ...s, busy: next };
      });
    if (busy) mark(true);
    try {
      const data = await job();
      return { ok: true, data };
    } catch (e) {
      return fail(e);
    } finally {
      if (busy) mark(false);
    }
  };

  const summarize = (results: readonly McpCheck[]): CheckSummary => ({
    total: results.length,
    ready: results.filter((r) => r.ok).length,
    failed: results
      .filter((r) => !r.ok)
      .map((r) => ({
        name: r.name,
        message: r.handshake.error ?? "检测失败",
      })),
  });

  return {
    subscribe: sig.subscribe,
    getSnapshot: sig.get,

    async load(): Promise<void> {
      if (!ready()) sig.set({ phase: "loading" });
      try {
        const servers = await listMcp(token());
        const cur = ready();
        sig.set({
          phase: "ready",
          servers,
          busy: cur?.busy ?? {},
          checks: cur?.checks ?? {},
        });
      } catch (e) {
        if (!ready()) sig.set({ phase: "error", message: fail(e).message });
      }
    },

    /** 编辑器边输入边校验：不落库，不是保存操作。 */
    async validate(json: string, editing?: string) {
      try {
        return {
          ok: true as const,
          data: await validateMcp(token(), json, editing),
        };
      } catch (e) {
        return fail(e);
      }
    },

    create: (json: string) =>
      write(async () => {
        const v = await createMcp(token(), json);
        put(v);
        return v;
      }),

    /** 改名被引用时 409，error.body.references 列出引用位置。 */
    update: (name: string, json: string) =>
      write(async () => {
        const v = await updateMcp(token(), name, json);
        if (v.renamedFrom) drop(v.renamedFrom);
        put(v);
        return v;
      }),

    /** 详情页「设置」的一次保存：审批档与是否全局。 */
    setSettings: (name: string, s: { approval: Policy; global: boolean }) =>
      write(async () => {
        const v = await patchMcp(token(), name, s);
        put(v);
        return v;
      }),

    setEnabled: (name: string, enabled: boolean) =>
      write(async () => {
        const v = await patchMcp(token(), name, { enabled });
        put(v);
        return v;
      }),

    remove: (name: string) =>
      write(async () => {
        await deleteMcp(token(), name);
        drop(name);
      }),

    /** 启动 → 握手 → 列工具；失败也是成功返回，原因在结果里。 */
    check: (name: string) =>
      write(
        async () => {
          const r = await checkMcp(token(), name);
          put(r.server);
          keepCheck(r);
          return r;
        },
        { names: [name], text: "检测中" },
      ),

    /** 全部检测：只测已启用的，与批量条「检测」同一套汇总。 */
    checkAll: () =>
      write(
        async () => {
          const r = await checkAllMcp(token());
          replaceAll(r.servers);
          for (const c of r.results) keepCheck(c);
          return summarize(r.results);
        },
        {
          names: (ready()?.servers ?? [])
            .filter((m) => m.enabled)
            .map((m) => m.name),
          text: "检测中",
        },
      ),

    /** 试装并固定：成功才写回 pkg@版本；失败（error.body 带 message 与 steps）不写，仍标浮动。 */
    tryPin: (name: string, version?: string): Promise<Outcome<PinSuccess>> =>
      write(
        async () => {
          try {
            const r = await tryPinMcp(token(), name, version);
            put(r.server);
            keepCheck(r.check);
            return r;
          } catch (e) {
            // 失败响应里带着服务当前状态（没改），顺手对齐
            const server = (e as { body?: { server?: McpView | null } }).body
              ?.server;
            if (server) put(server);
            throw e;
          }
        },
        { names: [name], text: "试装中" },
      ),

    /** 候选版本：向包源联网查询，不是保存操作。 */
    async versions(name: string): Promise<Outcome<McpVersions>> {
      try {
        return { ok: true, data: await mcpVersions(token(), name) };
      } catch (e) {
        return fail(e);
      }
    },

    /** 向包源问一遍已固定服务的最新版；服务端会记下，行上据此标「可更新」。浮动的每次启动取最新，不查。 */
    async checkUpdates(): Promise<{
      checked: number;
      failed: { name: string; message: string }[];
    }> {
      const tracked = (ready()?.servers ?? []).filter((m) => m.pinned);
      const failed: { name: string; message: string }[] = [];
      let next = 0;
      // 包源是联网查询，限 3 路并发
      const worker = async () => {
        while (next < tracked.length) {
          const m = tracked[next++];
          if (!m) return;
          try {
            const { latest } = await mcpVersions(token(), m.name);
            patch((s) => ({
              ...s,
              servers: s.servers.map((k) =>
                k.name === m.name ? { ...k, latestVersion: latest } : k,
              ),
            }));
          } catch (e) {
            failed.push({ name: m.name, message: fail(e).message });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return { checked: tracked.length, failed };
    },

    /** 批量：逐项执行、部分失败不回滚；返回逐项结果，检测另带就绪汇总。 */
    batch: (names: string[], action: McpBatchAction) =>
      write(
        async (): Promise<{
          items: McpBatchItem[];
          summary: CheckSummary | null;
        }> => {
          const r = await batchMcp(token(), names, action);
          replaceAll(r.servers);
          const checks = r.results.flatMap((i) => {
            const d = (i as { detail?: McpCheck }).detail;
            return action === "check" && d?.handshake ? [d] : [];
          });
          for (const c of checks) keepCheck(c);
          return {
            items: r.results,
            summary: action === "check" ? summarize(checks) : null,
          };
        },
        action === "pin" || action === "check"
          ? { names, text: action === "pin" ? "试装中" : "检测中" }
          : undefined,
      ),
  };
}

export type McpStore = ReturnType<typeof createMcpStore>;
