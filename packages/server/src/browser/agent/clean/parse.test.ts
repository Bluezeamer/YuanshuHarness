import { describe, expect, test } from "vitest";
import {
  fieldValue,
  nodeName,
  nodeText,
  parseSnapshot,
  type SnapNode,
} from "./parse.js";

// 真实取样（`page.ariaSnapshot({ mode: "ai" })`）。
const REAL = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - heading "站点标题" [level=1] [ref=e3]
    - navigation [ref=e4]:
      - link "首页" [ref=e5] [cursor=pointer]:
        - /url: /a
  - main [ref=e8]:
    - textbox "用户名" [ref=e12]
    - checkbox "记住我" [checked] [ref=e16]
    - button "不可用按钮" [disabled] [ref=e19]
    - paragraph [ref=e20]: 第 1 段正文。`;

// iframe 里的编号、属性行、名字里带引号与冒号。
const IFRAME = `- main [ref=e2]:
  - button "带\\"引号\\"的名字" [ref=e3]: x
  - iframe [ref=f1]:
    - generic [ref=f1e1]:
      - textbox "框内输入" [ref=f1e2]
      - link "框内链接" [ref=f1e3] [cursor=pointer]:
        - /url: /inner
  - radio "单选" [checked] [ref=e25]`;

/** 展平成文档顺序的节点列表，方便断言。 */
const flat = (nodes: SnapNode[]): SnapNode[] =>
  nodes.flatMap((n) => [n, ...flat(n.children)]);

describe("parseSnapshot", () => {
  test("逐行无损：节点的原始行与输入一一对应", () => {
    for (const raw of [REAL, IFRAME])
      expect(flat(parseSnapshot(raw)).map((n) => n.text)).toEqual(
        raw
          .split("\n")
          .map((l) => l.trim().replace(/^- /, ""))
          .filter(Boolean),
      );
  });

  test("属性行并到所属元素下当子节点", () => {
    const [link] = parseSnapshot(`- link "首页" [ref=e5]:\n  - /url: /a`);
    expect(link?.children.map((c) => c.text)).toEqual(["/url: /a"]);
  });

  test("编号、角色、标记、名字与文字", () => {
    const [root] = parseSnapshot(IFRAME);
    expect(root?.ref).toBe("e2");
    expect(root?.role).toBe("main");
    const quoted = root?.children.find((c) => c.role === "button");
    expect(quoted && nodeName(quoted)).toBe('带\\"引号\\"的名字');
    expect(quoted && nodeText(quoted)).toBe("x");
    const frames = root?.children.find((c) => c.role === "iframe");
    expect(frames?.ref).toBe("f1");
    expect(frames?.children[0]?.children.map((c) => c.ref)).toEqual([
      "f1e2",
      "f1e3",
    ]);
    const radio = root?.children.find((c) => c.role === "radio");
    expect([...(radio?.flags ?? [])]).toEqual(["checked"]);
  });

  test("认不得的行不抛错，原样保留", () => {
    const weird = [
      "- ???  任意 行 内容",
      "- /url: /x",
      "   - text: 只有文字",
      "\t- 制表符缩进",
      '- button "名字后还有内容" [ref=e1]',
    ].join("\n");
    const nodes = parseSnapshot(weird);
    expect(nodes.length).toBeGreaterThan(0);
    expect(flat(nodes).map((n) => n.text)).toContain("???  任意 行 内容");
  });

  test("空白行忽略；空输入得空数组", () => {
    expect(parseSnapshot("")).toEqual([]);
    expect(parseSnapshot("\n\n  \n")).toEqual([]);
  });
});

describe("标记只认头部", () => {
  const one = (line: string) => parseSnapshot(line)[0] as SnapNode;

  test("正文与值里写着标记字样：不进 flags，不当编号与位置", () => {
    const p = one("paragraph: 说明 [hidden] 和 [ref=e99] 与 [box=0,9000,1,1]");
    expect(p.flags.has("hidden")).toBe(false);
    expect(p.ref).toBeNull();
    expect(nodeText(p)).toBe("说明 [hidden] 和 [ref=e99] 与 [box=0,9000,1,1]");
  });

  test("值以方括号开头也能拆出来：头部标记不被它污染", () => {
    const t = one(`textbox "备注" [disabled] [ref=e2]: [checked] 内容`);
    expect([...t.flags]).toEqual(["disabled"]);
    expect(t.ref).toBe("e2");
    expect(nodeText(t)).toBe("[checked] 内容");
  });

  test("名字里的方括号不是标记", () => {
    const l = one(`link "阅读 [hidden] 条款" [ref=e3]`);
    expect(l.flags.has("hidden")).toBe(false);
    expect(nodeName(l)).toBe("阅读 [hidden] 条款");
  });
});

describe("fieldValue", () => {
  test("像数字的值被引擎写成引号串，读成值时去掉引号", () => {
    expect(fieldValue('"2"')).toBe("2");
    expect(fieldValue('"带\\"引号\\"和\\n换行"')).toBe('带"引号"和\n换行');
  });

  test("普通值原样；不成对的引号、解不了的转义不动", () => {
    expect(fieldValue("abc")).toBe("abc");
    expect(fieldValue("123")).toBe("123");
    expect(fieldValue("null")).toBe("null");
    expect(fieldValue('"开头有引号')).toBe('"开头有引号');
    expect(fieldValue('"a" b "c"')).toBe('"a" b "c"');
    expect(fieldValue('"\\x01"')).toBe('"\\x01"');
    expect(fieldValue("")).toBe("");
  });
});
