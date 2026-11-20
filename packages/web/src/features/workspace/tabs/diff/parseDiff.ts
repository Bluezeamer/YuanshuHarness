// 把 unified diff 切成「带行列号的行」，供 diff 标签渲染。
// 只处理 @@ 与 +/-/空格；行号按 hunk 头推算，二进制/异常格式退化成纯文本行。
export interface DiffRow {
  /** 旧/新两侧行号；该侧没有这一行时为 null */
  a: number | null;
  b: number | null;
  kind: "same" | "add" | "del" | "hunk" | "meta";
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(text: string): DiffRow[] {
  const out: DiffRow[] = [];
  // 正常 diff 一定以 @@ 开头；万一没有（手拼的内容），就按从 1 起算
  let a = 1;
  let b = 1;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      out.push({ a: null, b: null, kind: "meta", text: line });
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      a = Number(hunk[1]);
      b = Number(hunk[2]);
      out.push({ a: null, b: null, kind: "hunk", text: line });
      continue;
    }
    const head = line[0];
    const body = line.slice(1);
    if (head === "+") {
      out.push({ a: null, b: b++, kind: "add", text: body });
      continue;
    }
    if (head === "-") {
      out.push({ a: a++, b: null, kind: "del", text: body });
      continue;
    }
    // 空格开头是上下文行；其它（\ No newline 等）按原样显示、不占行号
    if (head === " ") {
      out.push({ a: a++, b: b++, kind: "same", text: body });
      continue;
    }
    out.push({ a: null, b: null, kind: "meta", text: line });
  }
  return out;
}
