// 快照元素编号：格式校验与「已失效」的说法。page.ts 与 dom.ts 共用这一份。
const REF_PATTERN = /^(f\d+)?e\d+$/;

export const STALE = "该编号已失效（页面可能变了），请先重新获取快照。";

/** 元素编号格式校验：`e12`，iframe 里是 `f1e2`。 */
export function isRef(ref: string): boolean {
  return REF_PATTERN.test(ref);
}

export function needRef(ref: string): void {
  if (!isRef(ref))
    throw new Error(
      `编号格式不对（${ref}），请用 browser_snapshot 给出的编号。`,
    );
}
