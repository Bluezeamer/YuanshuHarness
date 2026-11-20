import { describe, expect, test } from "vitest";
import { borrowName, buildTree, type DNode } from "./diff-tree.js";
import { parseSnapshot, type SnapNode } from "./parse.js";

const raw = (...lines: string[]): string => lines.join("\n");
const node = (text: string): SnapNode => parseSnapshot(text)[0] as SnapNode;
const only = (text: string): DNode => buildTree(text)[0] as DNode;

/** 前序条目 key 序列（用来核对子树里的东西都在）。 */
const keys = (ns: DNode[]): string[] =>
  ns.flatMap((n) => [...(n.item ? [n.item.key] : []), ...keys(n.children)]);

describe("buildTree：剪枝", () => {
  test("没有条目的空壳不建", () => {
    const roots = buildTree(
      raw(`- main [ref=e1]:`, `  - generic [ref=e2]:`, `  - text: hi`),
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]?.role).toBe("main");
    // generic 里什么都没有，整棵不建；main 底下只剩那条 text
    expect(roots[0]?.children.map((n) => n.role)).toEqual(["text"]);
    expect(roots[0]?.elements).toBe(1);
  });

  test("整棵都没有条目：空树", () => {
    expect(buildTree(raw(`- main [ref=e1]:`, `  - generic [ref=e2]:`))).toEqual(
      [],
    );
    expect(buildTree("")).toEqual([]);
  });

  test("可点元素的子节点也建（链接卡片里的标题、段落）", () => {
    const link = only(
      raw(
        `- link "标题" [ref=e1]:`,
        `  - paragraph [ref=e2]:`,
        `    - text: 正文`,
        `  - /url: /a/1`,
      ),
    );
    // /url 子行不建（地址并进元素行）
    expect(link.children.map((n) => n.role)).toEqual(["paragraph"]);
    expect(link.item?.url).toBe("/a/1");
    expect(keys([link])).toEqual(["link|标题|/a/1", "text|正文"]);
  });

  test("跳过的 /url 与 /src 也不再出现在子树里", () => {
    const img = only(raw(`- img "图 3" [ref=e9]:`, `  - /src: /a/3.jpg`));
    expect(img.children).toEqual([]);
    expect(img.item?.url).toBe("/a/3.jpg");
  });
});

describe("buildTree：签名与计数", () => {
  test("有条目的节点用自己的 key 当签名", () => {
    expect(only(`- button "删除" [ref=e1]`).sig).toBe("button|删除|");
  });

  test("纯容器取子树里前序前两个条目的 key", () => {
    const item = only(
      raw(
        `- listitem [ref=e1]:`,
        `  - heading "标题" [ref=e2]`,
        `  - paragraph [ref=e3]: 正文`,
        `  - button "更多" [ref=e4]`,
      ),
    );
    expect(item.sig).toBe("listitem|heading|标题 ¦ paragraph|正文");
    // 自己没条目，签名只看后代
    expect(item.item).toBeNull();
  });

  test("签名里每个后代 key 截到 80 字符", () => {
    const long = "x".repeat(200);
    const item = only(
      raw(`- listitem [ref=e1]:`, `  - paragraph [ref=e2]: ${long}`),
    );
    expect(item.sig).toBe(`listitem|paragraph|${"x".repeat(70)}`);
  });

  test("elements 是子树里的条目个数（含自己）", () => {
    const feed = only(
      raw(
        `- main [ref=e1]:`,
        `  - list [ref=e2]:`,
        `    - listitem [ref=e3]:`,
        `      - heading "回答 1" [ref=e4]`,
        `      - paragraph [ref=e5]: 正文`,
      ),
    );
    expect(feed.elements).toBe(2);
    expect(feed.children[0]?.elements).toBe(2);
    expect(feed.children[0]?.children[0]?.elements).toBe(2);
  });
});

describe("borrowName：无名控件的名字", () => {
  test("预序里第一个有名字的子孙", () => {
    const n = node(
      raw(
        `- link [ref=e5]:`,
        `  - text: 正文文字`,
        `  - img "图片的名字" [ref=e6]`,
      ),
    );
    expect(borrowName(n)).toBe("图片的名字");
  });

  test("都没有名字就退到第一段文字", () => {
    const n = node(
      raw(
        `- link [ref=e5]:`,
        `  - generic [ref=e6]:`,
        `    - text: Hello world`,
      ),
    );
    expect(borrowName(n)).toBe("Hello world");
  });

  test("既没名字也没文字：空串", () => {
    expect(borrowName(node(`- link [ref=e5]`))).toBe("");
  });

  test("借用的是名字不是自己的编号", () => {
    const n = node(
      raw(
        `- link [ref=e5]:`,
        `  - paragraph [ref=e6]:`,
        `    - text: How Not to Build a Music Player`,
        `  - /url: /s/x`,
      ),
    );
    expect(borrowName(n)).toBe("How Not to Build a Music Player");
  });
});
