// 页面弹出的 JS 对话框（alert / confirm / prompt / beforeunload）：挂起不自动回答，等人答或超时取消。
// 有 dialog 监听时 Playwright 会把对话框挂着、页面主线程阻塞，直到有人 accept / dismiss；这是唯一碰它的地方。
import type { Dialog, Page } from "playwright-core";
import type { PageDialog } from "./types.js";

/** 没人回答就自动取消的等待时间。 */
export const DIALOG_TIMEOUT_MS = 120_000;

export interface DialogWatch {
  current(): PageDialog | null;
  answer(accept: boolean, text?: string): Promise<boolean>;
  onChange(cb: () => void): () => void;
  interrupted<T>(run: () => Promise<T>, fallback: T): Promise<T>;
}

const DIALOG_TYPES: Record<string, PageDialog["type"]> = {
  alert: "alert",
  confirm: "confirm",
  prompt: "prompt",
  beforeunload: "beforeunload",
};

const noop = () => {};

export function watchDialogs(
  page: Page,
  timeoutMs: number = DIALOG_TIMEOUT_MS,
): DialogWatch {
  const subs = new Set<() => void>();
  // 此刻挂着的对话框：Playwright 的对象与给上层的纯数据一起记。
  let pending: { dialog: Dialog; view: PageDialog } | null = null;
  let timer: NodeJS.Timeout | null = null;
  // 等「对话框出现」的唤醒函数：interrupted 靠它抢先返回（同时可能有多个动作在等）。
  const wakes = new Set<() => void>();

  const notify = () => {
    const fns = [...subs];
    for (const cb of fns) cb();
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  /** 清掉状态并通知（唤醒 interrupted 的等待者一起）。 */
  const settle = () => {
    clear();
    const waiting = [...wakes];
    wakes.clear();
    notify();
    for (const w of waiting) w();
  };

  const dismissQuietly = (dialog: Dialog) => {
    void dialog.dismiss().catch(noop);
  };

  page.on("dialog", (dialog) => {
    // 已经有挂着的：新来的直接关掉，不排队。
    if (pending) {
      dismissQuietly(dialog);
      return;
    }
    const type = DIALOG_TYPES[dialog.type()];
    if (type === undefined) {
      dismissQuietly(dialog);
      return;
    }
    pending = {
      dialog,
      view: {
        type,
        message: dialog.message(),
        defaultValue: type === "prompt" ? dialog.defaultValue() : "",
      },
    };
    timer = setTimeout(() => {
      const at = pending;
      if (!at) return;
      settle();
      dismissQuietly(at.dialog);
    }, timeoutMs);
    timer.unref();
    notify();
    // 对话框出现了：所有正在等的动作都各自拿 fallback 返回。
    const waiting = [...wakes];
    wakes.clear();
    for (const w of waiting) w();
  });

  page.on("close", () => {
    if (!pending && timer === null) return;
    // 页面没了就不用回答，清状态通知即可。
    settle();
  });

  return {
    current: () => pending?.view ?? null,
    async answer(accept, text) {
      const at = pending;
      if (!at) return false;
      settle();
      try {
        if (accept)
          await at.dialog.accept(
            at.view.type === "prompt"
              ? (text ?? at.view.defaultValue)
              : undefined,
          );
        else await at.dialog.dismiss();
      } catch {
        // 页面已关、已被别人回答：状态照样清掉了，当成功。
      }
      return true;
    },
    onChange(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    async interrupted(run, fallback) {
      // 开始时就有挂着的：动作一定卡住，不执行。
      if (pending) return fallback;
      let fire = noop;
      const appeared = new Promise<null>((ok) => {
        fire = () => ok(null);
      });
      wakes.add(fire);
      try {
        // 动作会在对话框被回答之后自己收尾，它的结果不要了：拒绝也要吞掉。
        const action = run();
        action.catch(noop);
        const first = await Promise.race([
          action.then((value) => ({ value })),
          appeared,
        ]);
        if (first !== null) return first.value;
        return fallback;
      } finally {
        wakes.delete(fire);
      }
    },
  };
}
