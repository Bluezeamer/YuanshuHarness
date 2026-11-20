import { useEffect, useState, useSyncExternalStore } from "react";
import { InlineNotice } from "../../../ui";
import { createVariablesStore, type VariablesStore } from "./store";

/** 页面级 store：首次挂载时加载。`injected` 仅测试注入。 */
export function useVariables(injected?: VariablesStore) {
  const [store] = useState(() => injected ?? createVariablesStore());
  useEffect(() => {
    void store.load();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, state };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <InlineNotice tone="danger">{error}</InlineNotice> : null;
}
