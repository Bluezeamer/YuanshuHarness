// 辅助模型回的 JSON 指针的容错解析（设计稿 §5）：模型会在 JSON 前后写说明、用 ``` 围栏、
// 少写字段、把类型写错。这里只做「取出 JSON + 按形状校验」，不截断长度、不判内容对错。
// 解析不了或顶层形状不对返回 null，由调用方决定重试还是回落。

export interface OverviewPointers {
  gist: string;
  parts: {
    caption: string;
    lines: [number, number];
    refs: string[];
    quote: [number, number][];
  }[];
}

export interface IntentPointers {
  groups: { refs: string[] }[];
  unresolved: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 字符串数组：非字符串的元素丢掉，不是数组就当场空。 */
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** 两个整数构成的区间，类型不对返回 null。 */
const intPair = (v: unknown): [number, number] | null =>
  Array.isArray(v) &&
  v.length === 2 &&
  Number.isInteger(v[0]) &&
  Number.isInteger(v[1])
    ? [v[0] as number, v[1] as number]
    : null;

/**
 * 取第一个括号配平且能解析成对象的 `{…}`：字符串里的括号与转义引号不算结构，
 * 前后的说明文字（以及 ``` 围栏）都自然被排除；说明里恰好写着 `{a}` 之类的会被跳过。
 */
function balancedObject(reply: string): Record<string, unknown> | null {
  for (
    let start = reply.indexOf("{");
    start >= 0;
    start = reply.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < reply.length; i++) {
      const c = reply[i] as string;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const v: unknown = JSON.parse(reply.slice(start, i + 1));
          if (isRecord(v)) return v;
        } catch {
          // 这一处不是合法 JSON，接着找下一个起点。
        }
        break;
      }
    }
  }
  return null;
}

/** overview 的指针：`{gist, parts:[{caption, lines, refs, quote}]}`。 */
export function parseOverview(reply: string): OverviewPointers | null {
  const obj = balancedObject(reply);
  if (!obj || !Array.isArray(obj.parts)) return null;
  const parts: OverviewPointers["parts"] = [];
  for (const raw of obj.parts) {
    if (!isRecord(raw)) continue;
    const lines = intPair(raw.lines);
    // 没有合法区间就没法取回，整条丢掉。
    if (!lines) continue;
    parts.push({
      caption: str(raw.caption),
      lines,
      refs: strList(raw.refs),
      quote: (Array.isArray(raw.quote) ? raw.quote : [])
        .map(intPair)
        .filter((q): q is [number, number] => q !== null),
    });
  }
  return { gist: str(obj.gist), parts };
}

/** intent 的指针：`{groups:[{refs:[…]}], unresolved}`。 */
export function parseIntent(reply: string): IntentPointers | null {
  const obj = balancedObject(reply);
  if (!obj || !Array.isArray(obj.groups)) return null;
  return {
    groups: obj.groups.filter(isRecord).map((g) => ({ refs: strList(g.refs) })),
    unresolved: str(obj.unresolved),
  };
}
