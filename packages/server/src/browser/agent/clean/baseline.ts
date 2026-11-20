// 每个（会话，页面）存一份「agent 最近一次看到的页面状态」：diff 与换页判定都拿它比。
// 两个会话共用同一个页面时各看各的；页面关闭时整页丢掉。

export interface Baseline {
  raw: string;
  url: string;
}

export interface BaselineStore {
  get(sessionId: string, pageId: string): Baseline | undefined;
  set(sessionId: string, pageId: string, value: Baseline): void;
  delete(sessionId: string, pageId: string): void;
  /** 页面被关掉：这个页面上所有会话的基线都丢掉 */
  deletePage(pageId: string): void;
}

const SEP = "\u0000";

const key = (sessionId: string, pageId: string): string =>
  `${sessionId}${SEP}${pageId}`;

export function createBaselines(): BaselineStore {
  const map = new Map<string, Baseline>();
  return {
    get: (sessionId, pageId) => map.get(key(sessionId, pageId)),
    set: (sessionId, pageId, value) =>
      void map.set(key(sessionId, pageId), value),
    delete: (sessionId, pageId) => void map.delete(key(sessionId, pageId)),
    deletePage(pageId) {
      const suffix = `${SEP}${pageId}`;
      for (const k of [...map.keys()]) if (k.endsWith(suffix)) map.delete(k);
    },
  };
}
