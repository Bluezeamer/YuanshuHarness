// 任务名称缓存：标签注册表的 title(tab) 是同步函数，取不到异步数据，
// 所以开标签时与任务标签拿到任务后各记一份，标签标题从这里读（同 exec/names.ts）。

import type { JobSnapshot } from "../../../api";
import { titlesChanged } from "../../workspace/tabs/registry";

const names = new Map<string, string>();

export const rememberJob = (job: Pick<JobSnapshot, "id" | "label">): void => {
  if (names.get(job.id) === job.label) return;
  names.set(job.id, job.label);
  titlesChanged();
};

export const jobName = (id: string | undefined): string | undefined =>
  id === undefined ? undefined : names.get(id);

/** 测试用：清空缓存 */
export const forgetJobs = (): void => names.clear();
