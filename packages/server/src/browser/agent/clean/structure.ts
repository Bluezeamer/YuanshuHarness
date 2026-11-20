// 结构视图（设计稿 §8.3）：给大页面的骨架导览。确定性，不调模型。
// 标题整行保留；每个标题段（两个标题之间的连续非标题行）里只显示第一条 paragraph 行，其余写成声明行。
import { CLEAN_LIMITS } from "./limits.js";

const isHead = (l: string): boolean => /^\s*- heading /.test(l);
const isPara = (l: string): boolean => /^\s*- paragraph\b.*?: ./.test(l);

/** 视图里的一行；end 是它覆盖到的全页行号（声明行覆盖整段）。 */
interface Row {
  text: string;
  end: number;
}

/** 每行前面加行号：`    7| 内容`（行号右对齐到总行数的位数）；行号从 1 开始，与文件里的第 n 行一致 */
export function numberLines(text: string): string {
  // 末尾换行不算一行，否则行号的位数会比文件实际行数多一位。
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((l, i) => `${String(i + 1).padStart(width)}| ${l}`)
    .join("\n");
}

const row = (line: number, text: string): Row => {
  const max = CLEAN_LIMITS.structureLineChars;
  const shown =
    text.length > max ? `${text.slice(0, max)} …(+${text.length - max})` : text;
  return { text: `${String(line + 1).padStart(5)}| ${shown}`, end: line + 1 };
};

/**
 * 折叠成视图行：标题与每段第一条 paragraph 保留，其余行归到声明里。
 * keepPara=false 时连 paragraph 一起去掉，相邻声明合并成一条。
 */
function fold(lines: string[], keepPara: boolean): Row[] {
  const out: Row[] = [];
  let gapFrom = -1;
  /** 收掉累积的未列出行 [gapFrom, to)；合并相邻声明靠它。 */
  const gap = (to: number): void => {
    if (gapFrom < 0 || to <= gapFrom) return;
    out.push({
      text: `      … L${gapFrom + 1}–${to}（${to - gapFrom} 行未列出）`,
      end: to,
    });
    gapFrom = -1;
  };
  for (let i = 0; i < lines.length; ) {
    if (isHead(lines[i] as string)) {
      gap(i);
      out.push(row(i, lines[i] as string));
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !isHead(lines[j] as string)) j++;
    // [i, j) 是一段非标题行：只留第一条 paragraph 行。
    let p = -1;
    for (let n = i; n < j; n++) {
      if (isPara(lines[n] as string)) {
        p = n;
        break;
      }
    }
    if (gapFrom < 0) gapFrom = i;
    if (p >= 0 && keepPara) {
      gap(p);
      out.push(row(p, lines[p] as string));
      gapFrom = p + 1;
    }
    i = j;
  }
  gap(lines.length);
  return out;
}

const cut = (n: number): string =>
  `      … 结构视图在 L${n} 处截断（其余部分请用搜索）`;

/**
 * 结构视图（设计稿 §8.3）：标题整行保留；每个标题段（两个标题之间的连续非标题行）里只显示第一条
 * paragraph 行（截到 structureLineChars 字符，超出写 ` …(+N)`）；其余写成声明行
 * `      … L<起>–<止>（<n> 行未列出）`。行号是全页行号。mech 是 mechanical() 的输出。
 */
export function structureView(
  mech: string,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? CLEAN_LIMITS.singleCallMaxChars;
  const lines = mech.split("\n");
  const truncate = (rows: Row[]): string | null => {
    // 从尾部按整行截断，末尾追加一行截断声明（n 是最后保留行覆盖到的全页行号）。
    for (let n = rows.length; n > 0; n--) {
      const head = rows.slice(0, n).map((r) => r.text);
      const text = [...head, cut((rows[n - 1] as Row).end)].join("\n");
      if (text.length <= maxChars) return text;
    }
    return null;
  };
  const full = fold(lines, true);
  const fullText = full.map((r) => r.text).join("\n");
  if (fullText.length <= maxChars) return fullText;
  // 太宽：先去掉 paragraph 只留标题与声明；仍超限就按整行截断。
  const lean = fold(lines, false);
  const leanText = lean.map((r) => r.text).join("\n");
  if (leanText.length <= maxChars) return leanText;
  return truncate(lean) ?? cut(0);
}
