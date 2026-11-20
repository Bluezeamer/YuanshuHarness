// 当前看哪个工作区：本页签的值放 sessionStorage，同时写一份 localStorage 当「上次用的」，新页签先继承它。
// 多窗口互不覆盖：只有新开页签才读 localStorage。

import type { Workspace } from "../../../api/workspaces";

export const CURRENT_KEY = "yuanshu.workspace";

export const loadCurrent = (): string | null =>
  sessionStorage.getItem(CURRENT_KEY) ?? localStorage.getItem(CURRENT_KEY);

export const saveCurrent = (id: string | null): void => {
  if (id === null) {
    sessionStorage.removeItem(CURRENT_KEY);
    localStorage.removeItem(CURRENT_KEY);
    return;
  }
  sessionStorage.setItem(CURRENT_KEY, id);
  localStorage.setItem(CURRENT_KEY, id);
};

/** 保存的还在就用它（归档的也算）；否则第一个未归档的；再否则第一个 */
export function resolveCurrent(
  saved: string | null,
  workspaces: readonly Workspace[],
): string | null {
  if (saved !== null && workspaces.some((w) => w.id === saved)) return saved;
  const active = workspaces.find((w) => !w.archived);
  return active?.id ?? workspaces[0]?.id ?? null;
}
