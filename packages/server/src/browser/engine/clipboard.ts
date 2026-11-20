// 页面剪贴板的截获：注入脚本包住页面里的复制路径，把「最后一次复制」记在页面自己的变量里，
// Server 再按页面汇总各 frame 去读。不授权读浏览器剪贴板——它是整个浏览器进程共享的，
// 授权读等于让一个工作区的页面读走另一个工作区复制的内容。
import type { Page } from "playwright-core";

/**
 * 注入脚本（所有 frame）。四条复制路径都记：`navigator.clipboard.writeText` / `write`、
 * copy 事件里 `DataTransfer.setData` 改写过的、以及 copy 事件时选区的文字。
 * 原实现照旧调用，拒绝也被吞掉（页面以为复制成功，这正是它自己的行为）。
 */
export const CLIPBOARD_INIT = `(() => {
  try {
    const rec = (t) => {
      window.__ysClip = { text: String(t), ts: Date.now() };
    };
    const cb = navigator.clipboard;
    if (cb) {
      const w = cb.writeText?.bind(cb);
      if (w) cb.writeText = (t) => { try { rec(t) } catch {} return w(t).catch(() => {}) };
      const wr = cb.write?.bind(cb);
      if (wr) cb.write = (items) => {
        try {
          for (const it of items) {
            if (!it.types.includes("text/plain")) continue;
            void it.getType("text/plain").then((b) => b.text()).then(rec, () => {});
          }
        } catch {}
        return wr(items).catch(() => {});
      };
    }
    // copy 事件里 setData 写入的文字：只在分发期间记，事件结束后页面自己的 setData 不受影响。
    const sd = DataTransfer.prototype.setData;
    let inCopy = null;
    DataTransfer.prototype.setData = function (type, v) {
      if (inCopy !== null && type === "text/plain") inCopy = String(v);
      return sd.call(this, type, v);
    };
    // 捕获阶段先清、冒泡阶段最后读：页面自己的监听（两者之间）已经改写过 setData。
    document.addEventListener("copy", () => { inCopy = "" }, true);
    window.addEventListener("copy", () => {
      const sel = String(getSelection?.() ?? "");
      const t = inCopy || sel;
      if (t) rec(t);
      inCopy = null;
    });
  } catch {}
})();`;

/** 页面里记下的最后一次复制。 */
export interface Copied {
  text: string;
  ts: number;
}

/** 在页面里读一次 `__ysClip`；会被序列化进浏览器执行。 */
function readClip(): unknown {
  return (globalThis as unknown as { __ysClip?: unknown }).__ysClip;
}

// 页面可以改写这个变量，形状不对（或没有）就当作没有。
function shape(v: unknown): Copied | null {
  if (typeof v !== "object" || v === null) return null;
  const { text, ts } = v as Partial<Copied>;
  if (typeof text !== "string" || typeof ts !== "number") return null;
  return { text, ts };
}

/** 页面里最近一次复制：各 frame 里取 ts 最大的；frame 已分离或读失败当作没有。 */
export async function readCopied(page: Page): Promise<Copied | null> {
  let best: Copied | null = null;
  for (const frame of page.frames()) {
    const got = shape(await frame.evaluate(readClip).catch(() => null));
    if (got && (best === null || got.ts > best.ts)) best = got;
  }
  return best;
}
