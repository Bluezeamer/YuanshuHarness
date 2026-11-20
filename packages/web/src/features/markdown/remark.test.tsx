import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Markdown } from "../chat/tab/Markdown";
import { MarkdownView } from "../workspace/tabs/preview/MarkdownView";

afterEach(cleanup);

// 对话与预览（笔记、画布卡片也走预览）是两套渲染，单个换行必须一样地变成 <br>：
// 以前只有用户气泡里靠一条 CSS 补，列表、引用、表格里和别处都没有。
const DOC = [
  "第一行",
  "第二行",
  "",
  "- 列表项一",
  "  同一项的第二行",
  "",
  "> 引用一",
  "> 引用二",
  "",
  "| 列 |",
  "| --- |",
  "| 单元格 |",
  "",
  "`行内",
  "代码` 之后",
  "",
  "```",
  "围栏里",
  "照原样",
  "```",
].join("\n");

const brsIn = (root: ParentNode, selector: string) =>
  root.querySelector(selector)?.querySelectorAll("br").length;

for (const [name, view] of [
  ["对话", <Markdown key="chat" text={DOC} />],
  ["预览 / 笔记 / 画布卡片", <MarkdownView key="pv" text={DOC} />],
] as const) {
  test(`${name}：单个换行在段落、列表、引用里都渲染成 <br>，围栏与行内代码里不动`, () => {
    const { container } = render(view);
    expect(brsIn(container, "p")).toBe(1);
    expect(brsIn(container, "li")).toBe(1);
    expect(brsIn(container, "blockquote")).toBe(1);
    // 跨行的行内代码：换行在 mdast 里已经是代码内容，不会被换成 <br>
    const inline = container.querySelector("code:not(pre code)");
    expect(inline?.querySelectorAll("br").length).toBe(0);
    expect(inline?.textContent).toBe("行内 代码");
    expect(container.querySelector("pre")?.querySelectorAll("br").length).toBe(
      0,
    );
    expect(container.querySelector("pre")?.textContent).toContain(
      "围栏里\n照原样",
    );
  });
}

// 中文标点紧挨汉字时，CommonMark 认不出强调；自动识别的网址也会把后面的中文标点吞进去。
for (const [name, view] of [
  ["对话", (t: string) => <Markdown text={t} />],
  ["预览 / 笔记 / 画布卡片", (t: string) => <MarkdownView text={t} />],
] as const) {
  test(`${name}：加粗里的中文标点与汉字紧挨也生效`, () => {
    const { container } = render(
      view("**注意：**请先备份，这是**“重点”**内容，请看**（重要）**说明"),
    );
    expect(
      [...container.querySelectorAll("strong")].map((e) => e.textContent),
    ).toEqual(["注意：", "“重点”", "（重要）"]);
    expect(container.textContent).not.toContain("*");
  });

  test(`${name}：网址在中文标点处收尾，标点与后文留在链接外；网址里的汉字保留`, () => {
    const { container } = render(
      view(
        "见 https://example.com/a，然后；再看 https://zh.example.org/wiki/中文。完",
      ),
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual([
      "https://example.com/a",
      "https://zh.example.org/wiki/中文",
    ]);
    expect(container.textContent).toContain(
      "https://example.com/a，然后；再看",
    );
    expect(container.textContent).toContain("中文。完");
  });

  test(`${name}：写明文字的链接与尖括号链接不被截断`, () => {
    const { container } = render(
      view("[官网，首页](https://example.com/a) 与 <https://example.com/b>"),
    );
    expect(
      [...container.querySelectorAll("a")].map((a) => a.textContent),
    ).toEqual(["官网，首页", "https://example.com/b"]);
  });
}
