// 控制台与失败请求的折叠缓冲，以及地址里的令牌打码。
// 用户管这个抽屉看的东西必须和 agent 读到的一致，所以两者读同一份缓冲。
import type { ConsoleEntry, ConsoleInput } from "./types.js";

const SECRET_PARAM = /token|key|secret|passw|auth|code|sig|session|jwt|bearer/i;
// 单条文字上限：只防内存（一句 console.log 能打出几十万字符）。
const MAX_TEXT = 10_000;

// URL 里的令牌类查询参数换成 ***；不是合法 URL 就原样返回。
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  let hit = false;
  for (const name of [...u.searchParams.keys()]) {
    if (!SECRET_PARAM.test(name)) continue;
    u.searchParams.set(name, "***");
    hit = true;
  }
  return hit ? u.toString() : raw;
}

// 文本里出现的 URL 也要打码（控制台里常把带令牌的地址整条打出来）。
export function redactText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, (m) => redactUrl(m));
}

// 控制台消息的来源位置：页面地址 + 行列号，地址同样打码。
export function locationUrl(
  url: string | undefined,
  line?: number,
): string | undefined {
  if (!url) return undefined;
  const clean = redactUrl(url);
  return line ? `${clean}:${line}` : clean;
}

// 行尾的位置 `url:line:col`（函数名可以是 `<anonymous>`，eval 帧还嵌一层括号）。
const POS = /([^()\s]+):(\d+):(\d+)\)?\s*$/;

/** 栈的第一帧：地址与行号（打码交给 locationUrl）；没有栈或解析不出就是 null。 */
export function firstFrame(
  stack: string | undefined,
): { url: string; line: number } | null {
  if (!stack) return null;
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const m = POS.exec(line);
    if (!m?.[1] || !m[2]) continue;
    return { url: m[1], line: Number(m[2]) };
  }
  return null;
}

/** 单条文字超上限就截断，末尾标出被截掉的字符数。 */
export function clipText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)} …(+${text.length - MAX_TEXT} chars)`;
}

/** 两个输入是不是同一组：四项完全一致（带数字变化的消息不合并，那会丢中间的值）。 */
function same(a: ConsoleEntry, b: ConsoleInput, text: string): boolean {
  return (
    a.kind === b.kind &&
    a.level === b.level &&
    a.text === text &&
    a.url === b.url
  );
}

export class ConsoleBuffer {
  private readonly max: number;
  // 按首次出现排序：排因果要看谁先出，根因通常是最早的那条。
  private items: ConsoleEntry[] = [];
  private nextId = 1;
  private dropped = 0;
  private readonly subs = new Set<(e: ConsoleEntry) => void>();

  constructor(max = 500) {
    this.max = Math.max(1, max);
  }

  push(input: ConsoleInput): void {
    const text = clipText(input.text);
    const hit = this.items.find((e) => same(e, input, text));
    if (hit) {
      // 同一组再出现：只记次数与最近的时刻，组编号与首次时刻不变（前端据此原地更新 ×n）。
      hit.count += 1;
      hit.ts = input.ts;
      this.emit(hit);
      return;
    }
    const entry: ConsoleEntry = {
      ...input,
      text,
      id: this.nextId++,
      count: 1,
      firstTs: input.ts,
    };
    this.items.push(entry);
    if (this.items.length > this.max) {
      // 容量按组算：挤掉最久没再出现的那一组（不是最早创建的）。
      let victim = 0;
      for (let i = 1; i < this.items.length; i++)
        if ((this.items[i]?.ts ?? 0) < (this.items[victim]?.ts ?? 0))
          victim = i;
      const [gone] = this.items.splice(victim, 1);
      this.dropped += gone?.count ?? 0;
    }
    this.emit(entry);
  }

  // 返回一份拷贝，调用方随便改不影响缓冲。
  list(): ConsoleEntry[] {
    return this.items.map((e) => ({ ...e }));
  }

  /** 累计被挤掉的**出现次数**（不是组数）。 */
  evicted(): number {
    return this.dropped;
  }

  subscribe(cb: (e: ConsoleEntry) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  private emit(entry: ConsoleEntry): void {
    for (const cb of [...this.subs]) cb({ ...entry });
  }
}
