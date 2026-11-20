import { useSyncExternalStore } from "react";

export interface Subscribable<S> {
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => S;
}

export const useSnapshot = <S>(store: Subscribable<S>): S =>
  useSyncExternalStore(store.subscribe, store.getSnapshot);
