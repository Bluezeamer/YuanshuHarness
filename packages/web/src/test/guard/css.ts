// 一个够用的 CSS 解析：选择器 + 声明 + 外层 at 规则。visual-rules 与 design.guard 共用。
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Block {
  file: string;
  selector: string;
  at: string[];
  decls: Array<[prop: string, value: string]>;
}

function splitDecls(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  const push = () => {
    const i = cur.indexOf(":");
    if (i > 0 && !cur.includes("{"))
      out.push([cur.slice(0, i).trim().toLowerCase(), cur.slice(i + 1).trim()]);
    cur = "";
  };
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return out;
}

export function parseCss(file: string, raw: string): Block[] {
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  const walk = (s: string, at: string[]) => {
    let i = 0;
    while (i < s.length) {
      const brace = s.indexOf("{", i);
      if (brace === -1) break;
      const semi = s.indexOf(";", i);
      if (
        semi !== -1 &&
        semi < brace &&
        s.slice(i, semi).trim().startsWith("@")
      ) {
        i = semi + 1;
        continue;
      }
      const head = s.slice(i, brace).trim();
      let depth = 1;
      let j = brace + 1;
      while (j < s.length && depth) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      const body = s.slice(brace + 1, j - 1);
      if (head.startsWith("@")) walk(body, [...at, head]);
      else
        out.push({
          file,
          selector: head.replace(/\s+/g, " "),
          at,
          decls: splitDecls(body),
        });
      i = j;
    }
  };
  walk(text, []);
  return out;
}

export function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith(".css") ? [full] : [];
  });
}
