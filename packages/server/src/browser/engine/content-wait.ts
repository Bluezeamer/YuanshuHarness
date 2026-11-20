// 滚动之后的有限等待：等「页面里新增了内容」或「新发出的请求跑完」，变化出现就在它停稳后返回。
// 只有这个文件与 page.ts 碰「页面里挂观察器」。
import type { Page } from "playwright-core";
import type { NetworkEntry } from "./types.js";

// 滚动之后先固定等这么久，让滚动事件跑完（沿用原来的值）。
export const SCROLL_SETTLE_MS = 300;
// 这段时间之内一个信号都没有，就当没有内容可加载。
export const PROBE_MS = 800;
// 有过信号也只等到这里。
export const CAP_MS = 2500;
// 最近一次新增之后安静这么久才算停稳。
export const QUIET_MS = 200;
export const POLL_MS = 100;

// 这些请求本来就不结束（长连接），不算「在飞」。
const LONG_LIVED = new Set(["websocket", "eventsource", "ping"]);

export interface ContentSignals {
  /** 滚动开始之后页面里新增的元素 / 文字的累计次数，与最近一次新增的时刻（Date.now() 毫秒，没有就是 0） */
  added(): Promise<{ count: number; lastAt: number }>;
  /** 滚动开始之后新发出、还没结束的请求个数 */
  pending(): number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type WaitEnd = "none" | "settled" | "cap";

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((done) => {
      // 不拖住进程：等待本身不该拦住退出。
      const timer = setTimeout(done, ms);
      timer.unref();
    }),
};

/**
 * 固定等待做完之后调用：按上面的规则有限等待，返回结束的原因。
 * `since` 是滚动开始前的时刻，所有时刻都从它算起。
 */
export async function waitForContent(
  since: number,
  signals: ContentSignals,
  clock: Clock = realClock,
): Promise<WaitEnd> {
  let seen = false;
  let lastAdded = 0;
  for (;;) {
    // 导航把页面上下文销毁、页面被关时读不到：当作没有新增。
    let added = { count: 0, lastAt: 0 };
    try {
      added = await signals.added();
    } catch {}
    if (added.count > 0) {
      seen = true;
      lastAdded = added.lastAt;
    }
    const pending = signals.pending();
    if (pending > 0) seen = true;
    const elapsed = clock.now() - since;
    if (elapsed >= CAP_MS) return "cap";
    if (!seen) {
      if (elapsed >= PROBE_MS) return "none";
    } else if (pending === 0 && clock.now() - lastAdded >= QUIET_MS) {
      // lastAdded 是 0（只有请求这一个信号）时这个差一定够大：视为「没有新增」也算满足。
      return "settled";
    }
    await clock.sleep(POLL_MS);
  }
}

/** 滚动开始之后新发出、还没结束的请求个数；长连接（WebSocket、EventSource、ping）本来就一直不结束，不算。 */
export function pendingSince(
  entries: readonly NetworkEntry[],
  since: number,
): number {
  let n = 0;
  for (const e of entries) {
    if (e.ts < since || e.ms !== null || e.failure !== null) continue;
    if (LONG_LIVED.has(e.type)) continue;
    n++;
  }
  return n;
}

// 浏览器里的 DOM 形状（server 的 tsconfig 不含 dom 库，只写用到的成员）。
interface DomNode {
  nodeType: number;
  textContent: string | null;
}
interface DomMutation {
  addedNodes: ArrayLike<DomNode | undefined>;
}
interface DomDocument {
  nodeType: number;
}
interface DomObserver {
  observe(
    target: DomDocument,
    options: { childList: boolean; subtree: boolean },
  ): void;
  disconnect(): void;
}
interface Additions {
  count: number;
  lastAt: number;
  observer: DomObserver;
}

// 下面三个函数会被序列化进浏览器执行，只能引用 globalThis（模块级常量读不到，键名就地写）：
// 状态挂在 globalThis 的一个 Symbol 键上，页面脚本枚举不到、也不会污染它的名字。

/** 挂上观察器：只数新增的元素节点与去掉空白后非空的文字节点，属性切换 / 改文字不算。 */
function startAdditions(): void {
  const g = globalThis as unknown as {
    document: DomDocument;
    MutationObserver: new (cb: (records: DomMutation[]) => void) => DomObserver;
  };
  const slot = globalThis as unknown as Record<symbol, Additions | undefined>;
  const key = Symbol.for("yuanshu.additions");
  // 上一次没摘掉（连着做动作）就先摘掉，不叠着观察。
  slot[key]?.observer.disconnect();
  const observer = new g.MutationObserver((records) => {
    const live = slot[key];
    if (live === undefined) return;
    let n = 0;
    for (const record of records) {
      for (let i = 0; i < record.addedNodes.length; i++) {
        const node = record.addedNodes[i];
        if (node === undefined) continue;
        const added =
          node.nodeType === 1 ||
          (node.nodeType === 3 && (node.textContent ?? "").trim() !== "");
        if (added) n++;
      }
    }
    if (n === 0) return;
    live.count += n;
    live.lastAt = Date.now();
  });
  observer.observe(g.document, { childList: true, subtree: true });
  slot[key] = { count: 0, lastAt: 0, observer };
}

/** 读累计次数与最近一次新增的时刻。 */
function readAdditions(): { count: number; lastAt: number } {
  const slot = globalThis as unknown as Record<symbol, Additions | undefined>;
  const live = slot[Symbol.for("yuanshu.additions")];
  return live === undefined
    ? { count: 0, lastAt: 0 }
    : { count: live.count, lastAt: live.lastAt };
}

/** 摘掉观察器并从 globalThis 上删掉状态。 */
function stopAdditions(): void {
  const slot = globalThis as unknown as Record<symbol, Additions | undefined>;
  const key = Symbol.for("yuanshu.additions");
  const live = slot[key];
  if (live === undefined) return;
  live.observer.disconnect();
  delete slot[key];
}

/** 在页面里挂上观察器；装不上（页面已关、上下文销毁）就当没有，之后读到的都是 0。 */
export async function watchAdditions(page: Page): Promise<{
  read(): Promise<{ count: number; lastAt: number }>;
  stop(): Promise<void>;
}> {
  try {
    await page.evaluate(startAdditions);
  } catch {}
  return {
    async read() {
      try {
        return await page.evaluate(readAdditions);
      } catch {
        return { count: 0, lastAt: 0 };
      }
    },
    async stop() {
      try {
        await page.evaluate(stopAdditions);
      } catch {
        // 上下文已销毁：观察器跟着页面走了，不用摘。
      }
    },
  };
}
