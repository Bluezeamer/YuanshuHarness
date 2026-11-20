import type { JobHandle } from "./manager.js";

export interface BlockedResult {
  text: string;
  isError?: boolean;
}

/**
 * 阻塞的工具调用（subagent.md §3）：等 done；到了提醒时间，或调用被中止（用户停了调用方），
 * 这次调用先返回，任务改成后台继续（完成时回调）。提醒时间是 0 以外的正数。
 */
export function blockOrDetach(o: {
  handle: JobHandle;
  done: Promise<BlockedResult>;
  remindMs: number;
  signal: AbortSignal | undefined;
  stillRunning: (ranMs: number) => string;
  interrupted: () => string;
}): Promise<BlockedResult> {
  const started = Date.now();
  return new Promise<BlockedResult>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      o.handle.inline(false);
      resolve({ text: o.stillRunning(Date.now() - started) });
    }, o.remindMs);
    const onAbort = () => {
      cleanup();
      o.handle.inline(false);
      resolve({ text: o.interrupted(), isError: true });
    };
    const cleanup = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    void o.done.then((r) => {
      cleanup();
      resolve(r);
    });
  });
}
