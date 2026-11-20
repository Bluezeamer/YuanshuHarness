import { expect, test } from "vitest";
import { splitHighlightedLines } from "./codeHighlight";

test("整段高亮 HTML 按换行切成逐行片段", () => {
  const html =
    '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;\n' +
    "console.log(a);";
  expect(splitHighlightedLines(html)).toEqual([
    '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;',
    "console.log(a);",
  ]);
});

test("跨行标签在行尾闭合、下一行重新打开", () => {
  const html = '<span class="hljs-comment">line1\nline2</span>\ntail';
  expect(splitHighlightedLines(html)).toEqual([
    '<span class="hljs-comment">line1</span>',
    '<span class="hljs-comment">line2</span>',
    "tail",
  ]);
});

test("文本里的 HTML 特殊字符会被转义", () => {
  expect(splitHighlightedLines("a &lt; b &amp;&amp; c &gt; d")).toEqual([
    "a &lt; b &amp;&amp; c &gt; d",
  ]);
});
