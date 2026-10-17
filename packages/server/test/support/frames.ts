export interface Frame {
  session: string;
  seq: number;
  ts: string;
  type: string;
  data: Record<string, any>;
}

export async function waitFor(
  cond: () => boolean,
  what = "条件",
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// 收集一个订阅者收到的帧。
export function collector(onFrame?: (f: Frame) => void) {
  const frames: Frame[] = [];
  return {
    frames,
    send(raw: string) {
      const f = JSON.parse(raw) as Frame;
      frames.push(f);
      onFrame?.(f);
    },
    types: () => frames.map((f) => f.type),
  };
}

// 检查序号：第一帧是快照，其后严格 +1。
export function expectContiguous(frames: Frame[]): void {
  const [first, ...rest] = frames;
  if (first?.type !== "snapshot") throw new Error("第一帧必须是 snapshot");
  let prev = first.seq;
  for (const f of rest) {
    if (f.seq !== prev + 1)
      throw new Error(`序号不连续：${prev} 之后是 ${f.seq}（${f.type}）`);
    prev = f.seq;
  }
}
