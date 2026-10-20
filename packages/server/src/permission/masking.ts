// 输出回显遮罩（ADR-0053）：已登记变量的真值出现在输出里，就精确替换成占位符 `@name`。
// 只做确定性精确匹配：短于 MASK_MIN 的值不参与，编码后的回显匹配不到（ADR-0007 已知局限）。
import { StringDecoder } from "node:string_decoder";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { MASK_MIN } from "../store/secrets.js";

export interface MaskVar {
  name: string;
  value: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Masker {
  // 长值在前：同一位置多个值都匹配时取最长的。
  private readonly vars: MaskVar[];
  private readonly re: RegExp | null;
  private readonly firstChars: Set<string>;
  readonly maxLen: number;

  constructor(vars: readonly MaskVar[]) {
    this.vars = vars
      .filter((v) => v.value.length >= MASK_MIN)
      .sort((a, b) => b.value.length - a.value.length);
    this.re = this.vars.length
      ? new RegExp(this.vars.map((v) => escapeRe(v.value)).join("|"), "g")
      : null;
    this.firstChars = new Set(this.vars.map((v) => v.value[0] as string));
    this.maxLen = this.vars[0]?.value.length ?? 0;
  }

  get empty(): boolean {
    return this.re === null;
  }

  private nameOf(value: string): string {
    return (this.vars.find((v) => v.value === value) as MaskVar).name;
  }

  /** 整段文本一次性遮罩。 */
  mask(text: string): string {
    if (!this.re) return text;
    return text.replace(this.re, (m) => `@${this.nameOf(m)}`);
  }

  /** 递归遮罩 JSON 值里的所有字符串（含对象键以外的叶子）。 */
  maskDeep<T>(v: T): T {
    if (!this.re) return v;
    if (typeof v === "string") return this.mask(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.maskDeep(x)) as T;
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, this.maskDeep(x)]),
      ) as T;
    return v;
  }

  /**
   * 在 buf 里找最早的 p，使 buf.slice(p) 是某个值的真前缀（可能是还没收完的值）。
   * 只会在末尾 maxLen-1 个字符里找，且首字符必须是某个值的首字符。
   */
  private partialStart(buf: string, from: number): number {
    for (
      let p = Math.max(from, buf.length - this.maxLen + 1);
      p < buf.length;
      p++
    ) {
      if (!this.firstChars.has(buf[p] as string)) continue;
      const tail = buf.slice(p);
      if (
        this.vars.some(
          (v) => v.value.length > tail.length && v.value.startsWith(tail),
        )
      )
        return p;
    }
    return -1;
  }

  /**
   * 对 pending+chunk 做遮罩，返回可以放行的部分与需要滞留到下一块的尾部。
   * 滞留的是「可能是某个值开头」的后缀；一个已完整的值若同时是更长值的前缀，也会滞留。
   */
  step(buf: string): { out: string; rest: string } {
    if (!this.re) return { out: buf, rest: "" };
    let out = "";
    let pos = 0;
    for (;;) {
      this.re.lastIndex = pos;
      const m = this.re.exec(buf);
      const p = this.partialStart(buf, pos);
      if (p >= 0 && (!m || p <= m.index))
        return { out: out + buf.slice(pos, p), rest: buf.slice(p) };
      if (!m) return { out: out + buf.slice(pos), rest: "" };
      out += `${buf.slice(pos, m.index)}@${this.nameOf(m[0])}`;
      pos = m.index + m[0].length;
    }
  }
}

/**
 * 流式遮罩：按块喂入 Buffer，吐出已遮罩的 Buffer。值被切在两块之间时，前半块滞留到下一块再判断；
 * 多字节字符被切开同样滞留。结束时必须 end() 冲出剩余部分。
 */
export class StreamMasker {
  private readonly dec = new StringDecoder("utf8");
  private pending = "";

  constructor(private readonly masker: Masker) {}

  push(data: Buffer): Buffer {
    if (this.masker.empty) return data;
    const { out, rest } = this.masker.step(this.pending + this.dec.write(data));
    this.pending = rest;
    return Buffer.from(out, "utf8");
  }

  end(): Buffer {
    if (this.masker.empty) return Buffer.alloc(0);
    const text = this.pending + this.dec.end();
    this.pending = "";
    return Buffer.from(this.masker.mask(text), "utf8");
  }
}

/** bash 的输出在进入 SDK 之前就遮罩：流式更新、截断落盘的全文、错误文本因此都不含真值。 */
export function maskBashOperations(
  ops: BashOperations,
  masker: Masker,
): BashOperations {
  if (masker.empty) return ops;
  return {
    exec: async (command, cwd, o) => {
      const s = new StreamMasker(masker);
      const emit = (b: Buffer) => {
        if (b.length > 0) o.onData(b);
      };
      try {
        return await ops.exec(command, cwd, {
          ...o,
          onData: (d) => emit(s.push(d)),
        });
      } finally {
        emit(s.end());
      }
    },
  };
}
