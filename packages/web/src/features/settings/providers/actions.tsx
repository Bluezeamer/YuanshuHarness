import { useEffect, useState, useSyncExternalStore } from "react";
import type { TestResult } from "../../../api/providers";
import { notify } from "../frame/notify";
import { explainFailure, fmtMs } from "./diagnose";
import {
  createProvidersStore,
  type Outcome,
  type ProvidersStore,
} from "./store";

/** 页面级 store：首次挂载时加载列表。 */
export function useProviders(injected?: ProvidersStore) {
  const [store] = useState(() => injected ?? createProvidersStore());
  useEffect(() => {
    void store.load();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, state };
}

/** 立即执行的操作（退出登录、移除密钥、移除模型…）：结果用右下角提示告知（X06）。 */
export async function act<T>(
  job: Promise<Outcome<T>>,
  done: string,
): Promise<boolean> {
  const r = await job;
  notify(r.ok ? null : r.message, done);
  return r.ok;
}

/** 测试连接的结果提示：通过写首 token 与总耗时，失败写原因与建议。 */
export function testNotice(r: Outcome<TestResult>): {
  problem: string | null;
  done: string;
} {
  if (!r.ok) return { problem: r.message, done: "" };
  const t = r.data;
  if (t.ok)
    return {
      problem: null,
      done: `连接成功 · 首 token ${fmtMs(t.lastTest.ttft)} · 共 ${fmtMs(t.lastTest.total)}`,
    };
  const stage = t.failedStage ?? t.lastTest.stage;
  const e = explainFailure(stage, t.errorCode, t.stages[stage]?.error);
  return { problem: `${e.title}。${e.hint}`, done: "" };
}
