// 每个工作区一份的布局文档：窗口 → 窗格树 → 标签。
// 对接服务端 /workspaces/:id/layout：不透明 JSON + revision CAS，body ≤256KB。这里不写网络代码。
// 约定：load 返回 Result（版本太新会被拒绝）；修复复用 persist 的 parse（永不抛）。

import { usedIds } from "./l2";
import { MAX_DOC_BYTES, newIdPool, parseWindowState } from "./persist";
import type { Result, WindowState } from "./types";
import { fail, ok } from "./types";

/** 当前布局文档版本。旧的一体化文档（≤3）不搬运，读到即重建 */
export const LAYOUT_VERSION = 4;

export interface LayoutDoc {
  version: number;
  windows: WindowState;
}

/** 「还没有布局」：由 store 补默认窗口 */
export const emptyLayout = (): LayoutDoc => ({
  version: LAYOUT_VERSION,
  windows: { list: [], active: 0 },
});

export const hasWindows = (d: LayoutDoc): boolean => d.windows.list.length > 0;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 任意输入 → 合法布局文档，永不抛：
 * 没有文档 / 旧版本 / 结构损坏 → 空布局；版本比客户端新 → too-new（别覆盖新客户端写的）。
 */
export function loadLayout(raw: unknown): Result<LayoutDoc> {
  if (!isObj(raw)) return ok(emptyLayout());
  const v = raw.version;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > LAYOUT_VERSION) {
    return fail("too-new", `布局版本 ${v} 比当前客户端新`);
  }
  if (v !== LAYOUT_VERSION) return ok(emptyLayout());
  const windows = parseWindowState(raw.windows, undefined, newIdPool());
  return ok({
    version: LAYOUT_VERSION,
    windows: windows ?? { list: [], active: 0 },
  });
}

// ── 序列化 ──

export const serializeLayout = (d: LayoutDoc): string => JSON.stringify(d);

/** 序列化后的 UTF-8 字节数 */
export const layoutBytes = (d: LayoutDoc): number =>
  new TextEncoder().encode(serializeLayout(d)).length;

export const layoutWithinBudget = (
  d: LayoutDoc,
  max = MAX_DOC_BYTES,
): boolean => layoutBytes(d) <= max;

/** 窗口 / 窗格 / 标签 id，给发号器避让用 */
export const layoutIds = (d: LayoutDoc): string[] =>
  usedIds({ layout: d.windows });
