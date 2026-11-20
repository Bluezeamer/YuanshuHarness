// 回前台恢复：后台期间连接可能「看着开着其实已死」（页面被冻结、省电断网），浏览器脚本看不到协议层心跳。
// 回前台（可见、从缓存恢复、网络恢复）时由各条推送流自己确认一次；会话、列表、浏览器三条流共用这一处。

// 同一次回前台常连发几个信号：窗口内只算一次。
const MERGE_MS = 300;
/** 探针发出后多久没有任何回音，就当连接已死。 */
export const PROBE_MS = 3000;

const subs = new Set<() => void>();
let wired = false;
let last = -Infinity;

const fire = () => {
  const now = Date.now();
  if (now - last < MERGE_MS) return;
  last = now;
  for (const cb of [...subs]) cb();
};

function wire() {
  wired = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fire();
  });
  window.addEventListener("pageshow", fire);
  window.addEventListener("online", fire);
}

/** 订阅回前台信号；返回取消订阅。 */
export function onForeground(cb: () => void): () => void {
  if (!wired) wire();
  subs.add(cb);
  return () => {
    subs.delete(cb);
    if (subs.size === 0) last = -Infinity;
  };
}

export interface Probe {
  /** 发探针并开始计时；已有一个在途就不重复发。 */
  start(): void;
  /** 连接上来了任何消息：探针作废。 */
  settle(): void;
  /** 取消（连接被换掉或释放时）。 */
  cancel(): void;
}

/** 探活：`ping` 发不出去（连接已不可写）或期限内没有回音，都算死，调 `onDead`。 */
export function createProbe(
  ping: () => boolean,
  onDead: () => void,
  ms = PROBE_MS,
): Probe {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    start() {
      if (timer !== undefined) return;
      if (!ping()) return onDead();
      timer = setTimeout(() => {
        timer = undefined;
        onDead();
      }, ms);
    },
    settle: cancel,
    cancel,
  };
}
