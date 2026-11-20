// 执行体名称缓存：标签注册表的 title(tab) 是同步函数，取不到异步数据，
// 所以右栏与执行体标签每次拿到清单就记一份，标签标题从这里读。

import type { ExecutionBody } from "../../../api/flows";
import { titlesChanged } from "../../workspace/tabs/registry";

const names = new Map<string, string>();

export function rememberExecutions(
  list: readonly Pick<ExecutionBody, "id" | "name">[],
): void {
  let changed = false;
  for (const x of list) {
    if (names.get(x.id) === x.name) continue;
    names.set(x.id, x.name);
    changed = true;
  }
  if (changed) titlesChanged();
}

export const executionName = (id: string | undefined): string | undefined =>
  id === undefined ? undefined : names.get(id);

/** 测试用：清空缓存 */
export const forgetExecutions = (): void => names.clear();
