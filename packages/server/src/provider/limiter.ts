// 供应商的并发请求数（subagent.md §6）：同一个供应商同时在途的模型请求不超过上限，超了在服务端排队，不拒绝。
// 阻塞在工具调用里的父会话不占请求（它在等子代理，没有请求在飞），所以排队不会因此死锁。
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type StreamFn = AgentSession["agent"]["streamFunction"];

/** 缺省上限；本地部署的模型按它自己的上限填（如 2） */
export const DEFAULT_MAX_CONCURRENT = 50;
export const MAX_CONCURRENT_RANGE = { min: 1, max: 1000 } as const;

interface Waiter {
  grant: () => void;
}

export class RequestLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();

  /** limitOf 每次都现取：设置里改了上限，之后的放行就按新的来 */
  constructor(private readonly limitOf: (provider: string) => number) {}

  private full(provider: string): boolean {
    return (this.active.get(provider) ?? 0) >= this.limitOf(provider);
  }

  // 占一个名额，返回释放函数（只有第一次调用有效）
  private take(provider: string): () => void {
    this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.active.get(provider) ?? 1) - 1;
      if (n > 0) this.active.set(provider, n);
      else this.active.delete(provider);
      this.pump(provider);
    };
  }

  // 空出名额后，按先来后到放行排队的请求；放行时由这里替它占名额，同一轮不会放出超过上限的人数
  private pump(provider: string): void {
    const q = this.queues.get(provider);
    while (q?.length && !this.full(provider)) (q.shift() as Waiter).grant();
    if (q && q.length === 0) this.queues.delete(provider);
  }

  /** 拿一个名额；满了就排队等。排队时被中止就放弃。 */
  acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (!this.queues.get(provider)?.length && !this.full(provider))
      return Promise.resolve(this.take(provider));
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(provider) ?? [];
      this.queues.set(provider, queue);
      const onAbort = () => {
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
        reject(new Error("aborted"));
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(this.take(provider));
        },
      };
      queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      // 上限被调高后队里本来就有等待的请求：新来的这一下顺便把能放的放掉
      this.pump(provider);
    });
  }

  /** 包一层流函数：请求开始前排队，流结束（完成、出错、被中止）时释放 */
  wrap(inner: StreamFn): StreamFn {
    return async (model, context, options) => {
      const release = await this.acquire(model.provider, options?.signal);
      try {
        const stream = await inner(model, context, options);
        // result() 在 done / error 事件时落定，被中止时同样落定
        stream.result().then(release, release);
        return stream;
      } catch (err) {
        release();
        throw err;
      }
    };
  }
}

/** 给会话的流函数套上并发限制；没有限制器就原样。会话工厂与审核会话共用。 */
export function limitRequests(
  session: AgentSession,
  limiter: RequestLimiter | undefined,
): void {
  if (limiter)
    session.agent.streamFunction = limiter.wrap(session.agent.streamFunction);
}
