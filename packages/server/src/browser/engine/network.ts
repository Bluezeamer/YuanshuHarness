// 网络请求的环形缓冲。纯数据结构：不碰 Playwright（接线在 net-watch.ts）。
// 与 console.ts 的 ConsoleBuffer 同一个写法：容量固定、挤出最旧的、list() 给拷贝。
import type { NetworkEntry } from "./types.js";

/** 写入缓冲的原料：id 与响应相关的几项都由后续事件回填。 */
export type NetworkInput = Pick<
  NetworkEntry,
  "ts" | "method" | "url" | "type" | "frame"
>;

const NEW_ENTRY = {
  status: null,
  mime: "",
  size: null,
  ms: null,
  failure: null,
} as const;

export class NetworkBuffer {
  private readonly max: number;
  // 按开始时间排序：id 单调递增，所以顺序就是入缓冲的顺序。
  private items: NetworkEntry[] = [];
  private nextId = 1;
  private dropped = 0;

  constructor(max = 500) {
    this.max = Math.max(1, max);
  }

  /** 入缓冲；被挤出的旧条目编号经返回值告诉调用方（调用方据此清掉它的 Request 映射）。 */
  push(input: NetworkInput): { entry: NetworkEntry; evicted: number | null } {
    const entry: NetworkEntry = { ...input, id: this.nextId++, ...NEW_ENTRY };
    this.items.push(entry);
    let evicted: number | null = null;
    if (this.items.length > this.max) {
      evicted = this.items.shift()?.id ?? null;
      if (evicted !== null) this.dropped += 1;
    }
    return { entry: { ...entry }, evicted };
  }

  /** 回填响应 / 结束 / 失败；编号已被挤出就忽略（响应比挤出晚到是正常的）。 */
  update(
    id: number,
    patch: Partial<
      Pick<NetworkEntry, "status" | "mime" | "size" | "ms" | "failure">
    >,
  ): void {
    const hit = this.items.find((e) => e.id === id);
    if (!hit) return;
    Object.assign(hit, patch);
  }

  // 返回拷贝，调用方随便改不影响缓冲。
  list(): NetworkEntry[] {
    return this.items.map((e) => ({ ...e }));
  }

  /** 累计被挤出的条数。 */
  evicted(): number {
    return this.dropped;
  }
}
