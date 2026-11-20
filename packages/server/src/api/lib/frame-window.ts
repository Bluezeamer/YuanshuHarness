// 画面帧的发送窗口：发出去但客户端还没确认的字节有上限，窗口满了只留最新一帧，腾出空间再发它。
// 只看 Node 自己的发送队列（bufferedAmount）不够：慢链路上旧帧会先堆在内核缓冲里，画面陈旧到好几秒；
// 让客户端确认每一帧，在路上的数据才有端到端的上限。
export class FrameWindow {
  private readonly sizes: number[] = [];
  private bytes = 0;
  private latest: Buffer | null = null;

  constructor(
    private readonly send: (jpeg: Buffer) => void,
    private readonly maxBytes: number,
  ) {}

  /** 来了一帧：窗口里有空就发；没有就顶掉之前等着的那一帧（最后一帧永远不丢）。 */
  push(jpeg: Buffer): void {
    if (this.open()) this.emit(jpeg);
    else this.latest = jpeg;
  }

  /** 客户端确认收到了最早发出的那一帧。 */
  ack(): void {
    const size = this.sizes.shift();
    if (size === undefined) return;
    this.bytes -= size;
    const next = this.latest;
    if (next && this.open()) {
      this.latest = null;
      this.emit(next);
    }
  }

  // 什么都没在路上就一定放行：一帧比窗口还大也要发得出去。
  private open(): boolean {
    return this.sizes.length === 0 || this.bytes < this.maxBytes;
  }

  private emit(jpeg: Buffer): void {
    this.sizes.push(jpeg.length);
    this.bytes += jpeg.length;
    this.send(jpeg);
  }
}
