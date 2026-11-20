// 工作区级的「展示给用户」广播：agent 做完活想让用户看一眼某个页面时的提示。
// 只投给此刻订阅着的界面，不留存、不重放（晚连上的界面收不到）。

/** 一次展示提示：发起它的会话、会话名、页面与 agent 写的一句说明。 */
export interface ShowRequest {
  sessionId: string;
  /** 会话名，提示里写「xxx 展示了一个页面」 */
  by: string;
  pageId: string;
  title: string;
  url: string;
  /** agent 写的一句说明，可为空串 */
  note: string;
}

/** 工作区级的「展示给用户」广播。 */
export interface ShowBus {
  subscribe(workspaceKey: string, cb: (s: ShowRequest) => void): () => void;
  /** 返回送达的订阅者个数（0 = 没有在线的界面） */
  publish(workspaceKey: string, s: ShowRequest): number;
}

export function createShowBus(): ShowBus {
  const byKey = new Map<string, Set<(s: ShowRequest) => void>>();
  return {
    subscribe(workspaceKey, cb) {
      const set = byKey.get(workspaceKey) ?? new Set();
      byKey.set(workspaceKey, set);
      set.add(cb);
      // 取消天然幂等：界面关连接时可能被调两次。
      return () => {
        set.delete(cb);
      };
    },
    publish(workspaceKey, s) {
      const set = byKey.get(workspaceKey);
      if (!set) return 0;
      let delivered = 0;
      // 一个订阅者的回调抛错不能影响其他订阅者，也不能把错误抛回工具层。
      for (const cb of [...set]) {
        delivered += 1;
        try {
          cb(s);
        } catch {}
      }
      return delivered;
    },
  };
}
