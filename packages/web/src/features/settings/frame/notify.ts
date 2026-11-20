import { toast } from "../../../ui";

/** 操作的结果用右下角提示告知（X06）：有问题红色，否则绿色。 */
export const notify = (problem: string | null, done: string) =>
  toast(problem ?? done, { tone: problem ? "danger" : "ok" });
