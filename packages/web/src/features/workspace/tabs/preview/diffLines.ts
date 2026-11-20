// 逐行差异：冲突时给用户看「磁盘上是什么、我改了什么」。
// 用最朴素的 LCS 比对——文件都是文本、行数有限，够用且没有依赖。
export interface DiffLine {
  /** same = 两边都有；del = 只在旧内容里；add = 只在当前内容里 */
  kind: "same" | "del" | "add";
  text: string;
  /** 旧/新两边的行号（从 1 起，缺的一边为 null） */
  a: number | null;
  b: number | null;
}

const MAX_LINES = 4000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // 太大就退化成长度提示，别在浏览器里跑几千万次比较
  if (a.length > MAX_LINES || b.length > MAX_LINES)
    return [
      { kind: "del", text: before, a: 1, b: null },
      { kind: "add", text: after, a: null, b: 1 },
    ];

  // LCS 表：只为了求最长公共子序列，行数受上面限制，内存可控
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  const at = (i: number, j: number): number => table[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i];
      if (!row) continue;
      row[j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "", a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: "del", text: a[i] ?? "", a: i + 1, b: null });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] ?? "", a: null, b: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i] ?? "", a: ++i, b: null });
  while (j < m) out.push({ kind: "add", text: b[j] ?? "", a: null, b: ++j });
  return out;
}

/** 只保留改动附近的几行，长文件里不至于淹没在相同行中。 */
export function trimDiff(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = i - context; k <= i + context; k++) keep.add(k);
  });
  const out: DiffLine[] = [];
  let gap = false;
  lines.forEach((l, i) => {
    if (keep.has(i)) {
      // 中间跳过了一段就插一行省略标记（开头被跳过也插，表明上面还有内容）
      if (gap) out.push({ kind: "same", text: "⋯", a: null, b: null });
      out.push(l);
      gap = false;
    } else gap = true;
  });
  // 末尾还有被省掉的行，补一个省略标记，免得看起来「就改到这里为止」
  if (gap) out.push({ kind: "same", text: "⋯", a: null, b: null });
  return out;
}
