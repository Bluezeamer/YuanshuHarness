import { listConnections } from "../../../../api/connections";
import { loadToken } from "../../../../api/http";
import {
  type BatchAction,
  type BatchItem,
  batchSkills,
  distributeSkill,
  getSkill,
  getSkillVersions,
  type InstallSource,
  installSkill,
  listSkills,
  lockSkill,
  patchSkillScope,
  readSkillFile,
  type SkillFile,
  type SkillScope,
  type SkillVersions,
  type SkillView,
  syncSkill,
  unlockSkill,
  updateSkill,
} from "../../../../api/skillLibrary";
import { fail, type Outcome } from "../common/errors";
import { createSignal } from "../common/signal";
import type { Hosts } from "./model";

export type SkillsState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      skills: SkillView[];
      /** 环境 id → 名称（读不到时是空表，页面退回显示 id）。 */
      hosts: Hosts;
      /** 正在跑的行级操作，值是行上显示的文案。 */
      busy: Readonly<Record<string, string>>;
    };

export interface StoreDeps {
  token?: () => string | null;
}

// 新装的排在最前。
const byNewest = (list: SkillView[]) =>
  list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.createdAt.localeCompare(a.s.createdAt) || a.i - b.i)
    .map((x) => x.s);

export function createSkillsStore(deps: StoreDeps = {}) {
  const token = deps.token ?? loadToken;
  const sig = createSignal<SkillsState>({ phase: "loading" });

  const ready = () => {
    const s = sig.get();
    return s.phase === "ready" ? s : null;
  };
  const patch = (
    fn: (s: Extract<SkillsState, { phase: "ready" }>) => SkillsState,
  ) => {
    const s = ready();
    if (s) sig.set(fn(s));
  };
  const put = (v: SkillView) =>
    patch((s) => ({
      ...s,
      skills: s.skills.some((k) => k.name === v.name)
        ? s.skills.map((k) => (k.name === v.name ? v : k))
        : byNewest([v, ...s.skills]),
    }));
  const drop = (names: readonly string[]) =>
    patch((s) => ({
      ...s,
      skills: s.skills.filter((k) => !names.includes(k.name)),
    }));

  // 写操作的统一出口：上报保存态；行级操作带 busy 文案。
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

  const store = {
    subscribe: sig.subscribe,
    getSnapshot: sig.get,

    async load(): Promise<void> {
      if (!ready()) sig.set({ phase: "loading" });
      try {
        const [skills, hosts] = await Promise.all([
          listSkills(token()),
          loadHosts(token()),
        ]);
        sig.set({
          phase: "ready",
          skills: byNewest(skills),
          hosts,
          busy: ready()?.busy ?? {},
        });
      } catch (e) {
        if (!ready()) sig.set({ phase: "error", message: fail(e).message });
      }
    },

    install: (source: InstallSource) =>
      write(async () => {
        const v = await installSkill(token(), source);
        put(v);
        return v;
      }),

    update: (name: string) =>
      write(
        async () => {
          const r = await updateSkill(token(), name);
          put(r.skill);
          return r;
        },
        { names: [name], text: "同步中" },
      ),

    /** 补齐只把库里现有版本（锁定时即锁定版）推到落后的环境，不联网、不换版本。 */
    sync: (name: string, hostIds?: string[]) =>
      write(
        async () => {
          const r = await syncSkill(token(), name, hostIds);
          put(r.skill);
          return r;
        },
        { names: [name], text: "同步中" },
      ),

    distribute: (name: string, hostIds: string[]) =>
      write(
        async () => {
          const r = await distributeSkill(token(), name, hostIds);
          put(r.skill);
          return r;
        },
        { names: [name], text: "分发中" },
      ),

    lock: (name: string, version: string) =>
      write(
        async () => {
          const v = await lockSkill(token(), name, version);
          put(v);
          return v;
        },
        { names: [name], text: "同步中" },
      ),

    unlock: (name: string) =>
      write(async () => {
        const v = await unlockSkill(token(), name);
        put(v);
        return v;
      }),

    /** 详情页「设置」的保存：是否全局。接口返回的视图不带分发状态，改完整体刷新一次。 */
    setScope: (name: string, scope: SkillScope) =>
      write(async () => {
        const v = await patchSkillScope(token(), name, scope);
        put(v);
        await store.load();
        return v;
      }),

    /** 候选版本；向来源联网查询，不是保存操作。 */
    async versions(name: string): Promise<Outcome<SkillVersions>> {
      try {
        return { ok: true, data: await getSkillVersions(token(), name) };
      } catch (e) {
        return fail(e);
      }
    },

    /** 批量：逐项执行、部分失败不回滚；结束后整体刷新拿最新状态与分发情况。 */
    batch: (names: string[], action: BatchAction) =>
      write(
        async (): Promise<BatchItem[]> => {
          const results = await batchSkills(token(), names, action);
          if (action === "uninstall")
            drop(results.filter((r) => r.ok).map((r) => r.name));
          else await store.load();
          return results;
        },
        action === "update" || action === "uninstall"
          ? { names, text: action === "update" ? "同步中" : "卸载中" }
          : undefined,
      ),

    /** 向各跟踪版本的来源问一遍最新版（只刷新「可更新」的依据，不改库）。 */
    async checkUpdates(): Promise<{
      checked: number;
      failed: { name: string; message: string }[];
    }> {
      const tracked = (ready()?.skills ?? []).filter(
        (k) => k.origin?.kind === "npm" || k.origin?.kind === "git",
      );
      const failed: { name: string; message: string }[] = [];
      let next = 0;
      // 来源是联网查询，限 3 路并发
      const worker = async () => {
        while (next < tracked.length) {
          const k = tracked[next++];
          if (!k) return;
          try {
            await getSkillVersions(token(), k.name);
          } catch (e) {
            failed.push({ name: k.name, message: fail(e).message });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      await store.load();
      return { checked: tracked.length, failed };
    },

    /** 详情弹窗：文件树与单个文件的内容，只读。 */
    async files(name: string): Promise<Outcome<SkillFile[]>> {
      try {
        return { ok: true, data: (await getSkill(token(), name)).files };
      } catch (e) {
        return fail(e);
      }
    },
    async readFile(name: string, path: string): Promise<Outcome<string>> {
      try {
        return {
          ok: true,
          data: (await readSkillFile(token(), name, path)).content,
        };
      } catch (e) {
        return fail(e);
      }
    },
  };
  return store;
}

export type SkillsStore = ReturnType<typeof createSkillsStore>;

// 环境名只用来给分发列表起名；读不到不影响技能表。
async function loadHosts(token: string | null): Promise<Hosts> {
  try {
    const { server, connections } = await listConnections(token);
    return {
      [server.environmentId]: server.label,
      ...Object.fromEntries(connections.map((c) => [c.id, c.label])),
    };
  } catch {
    return {};
  }
}
