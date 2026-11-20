import type { PushResult, SkillView } from "../../../../api/skillLibrary";
import { type Hosts, hostLabel, pushTargets } from "./model";
import type { SkillsStore } from "./store";

// 同步 / 分发里没成功的环境，逐个点名原因。
export function pushProblems(results: readonly PushResult[], hosts: Hosts) {
  const bad = results.filter(
    (r) => r.status === "failed" || r.status === "conflict",
  );
  return bad.length
    ? bad
        .map((r) => `${hostLabel(hosts, r.hostId)}：${r.message ?? r.status}`)
        .join("；")
    : null;
}

/** 以下操作成功返回 null，失败返回要给人看的一句话。 */
export async function update(
  store: SkillsStore,
  s: SkillView,
): Promise<string | null> {
  const r = await store.update(s.name);
  return r.ok ? null : r.message;
}

/**
 * 补齐：落后的环境补到库里现有版本（锁定时即锁定版，绝不联网换版本），没有副本的环境分发。
 * 给 only 就只处理这几个环境。
 */
export async function fill(
  store: SkillsStore,
  hosts: Hosts,
  s: SkillView,
  only?: readonly string[],
): Promise<string | null> {
  const todo = pushTargets(s).filter((d) => !only || only.includes(d.hostId));
  const ids = (state: "behind" | "missing") =>
    todo.filter((d) => d.state === state).map((d) => d.hostId);
  const problems: string[] = [];
  const behind = ids("behind");
  const missing = ids("missing");
  if (behind.length > 0) {
    const r = await store.sync(s.name, behind);
    if (!r.ok) return r.message;
    const p = pushProblems(r.data.results, hosts);
    if (p) problems.push(p);
  }
  if (missing.length > 0) {
    const r = await store.distribute(s.name, missing);
    if (!r.ok) return r.message;
    const p = pushProblems(r.data.results, hosts);
    if (p) problems.push(p);
  }
  return problems.length > 0 ? problems.join("；") : null;
}

export async function toggleEnabled(
  store: SkillsStore,
  s: SkillView,
): Promise<string | null> {
  const r = await store.batch([s.name], s.enabled ? "disable" : "enable");
  if (!r.ok) return r.message;
  const item = r.data[0];
  return item && !item.ok
    ? (item.message ?? item.error ?? "操作没有成功")
    : null;
}
