// 极小的外部 store 底座（配合 useSyncExternalStore）：三个页签的 store 共用。
export function createSignal<S>(initial: S) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: (): S => state,
    set(next: S): void {
      state = next;
      for (const f of subs) f();
    },
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
export type Signal<S> = ReturnType<typeof createSignal<S>>;
