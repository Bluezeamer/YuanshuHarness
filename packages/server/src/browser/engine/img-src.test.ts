import { describe, expect, test } from "vitest";
import { describeSrc, imageRefs, injectImageSources } from "./img-src.js";

const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAE";

describe("imageRefs", () => {
  test("只认角色正好是 img、带编号的节点，按出现顺序", () => {
    const raw = `- main [ref=e1]:
  - img "甲" [ref=e2]
  - image "乙" [ref=e3]
  - imgx "丙" [ref=e4]
  - img "丁" [ref=e5] [cursor=pointer]
  - img "没有编号"`;
    expect(imageRefs(raw)).toEqual(["e2", "e5"]);
  });

  test("行内 / iframe 里的编号照样取", () => {
    expect(
      imageRefs(`- generic [ref=f1e1]:\n  - img "框内" [ref=f1e3]`),
    ).toEqual(["f1e3"]);
  });

  test("名字里恰好写着 [ref=…] 时不是这一行的编号", () => {
    expect(imageRefs(`- img "带[ref=e9]的名字" [ref=e5]`)).toEqual(["e5"]);
  });

  test("没有 img 节点时是空数组", () => {
    expect(imageRefs(`- link "Home" [ref=e1]:\n  - /url: /`)).toEqual([]);
  });
});

describe("describeSrc", () => {
  test("普通地址原样", () => {
    expect(describeSrc("https://a.test/a.png")).toBe("https://a.test/a.png");
    expect(describeSrc("/a.png")).toBe("/a.png");
  });

  test("data: 地址只写 mime 与原串长度（不写 base64）", () => {
    expect(describeSrc(GIF)).toBe(`data:image/gif (${GIF.length} chars)`);
    expect(describeSrc("data:image/svg+xml,<svg/>")).toBe(
      `data:image/svg+xml (${"data:image/svg+xml,<svg/>".length} chars)`,
    );
  });

  test("没有 mime 的 data: 地址", () => {
    expect(describeSrc("data:,x")).toBe("data: (7 chars)");
  });
});

describe("injectImageSources", () => {
  test("插在 img 行后、缩进深两格，行尾补冒号", () => {
    const raw = `- main [ref=e1]:
  - img "甲" [ref=e2]`;
    expect(injectImageSources(raw, new Map([["e2", "/a.png"]]))).toBe(
      `- main [ref=e1]:
  - img "甲" [ref=e2]:
    - /src: /a.png`,
    );
  });

  test("已有冒号与已有孩子的 img：地址行排在最前", () => {
    const raw = `- img "甲" [ref=e2]:\n  - text: 甲`;
    expect(injectImageSources(raw, new Map([["e2", "/a.png"]]))).toBe(
      `- img "甲" [ref=e2]:\n  - /src: /a.png\n  - text: 甲`,
    );
  });

  test("没有地址的节点原样不动（同一份快照里的其他 img 照写）", () => {
    const raw = `- img "甲" [ref=e2]\n- img "乙" [ref=e3]`;
    const srcs = new Map([
      ["e2", ""],
      ["e3", `data:image/gif (${GIF.length} chars)`],
    ]);
    expect(injectImageSources(raw, srcs)).toBe(
      `- img "甲" [ref=e2]\n- img "乙" [ref=e3]:\n  - /src: data:image/gif (${GIF.length} chars)`,
    );
  });

  test("多个 img 各自插一行；非 img 节点不受影响", () => {
    const raw = [
      `- generic [ref=e1]:`,
      `  - img "甲" [ref=e2]`,
      `  - link "乙" [ref=e3]:`,
      `    - /url: /b`,
      `  - img "丙" [ref=e4]`,
    ].join("\n");
    expect(
      injectImageSources(
        raw,
        new Map([
          ["e2", "/a.png"],
          ["e4", "/c.png"],
        ]),
      ),
    ).toBe(
      [
        `- generic [ref=e1]:`,
        `  - img "甲" [ref=e2]:`,
        `    - /src: /a.png`,
        `  - link "乙" [ref=e3]:`,
        `    - /url: /b`,
        `  - img "丙" [ref=e4]:`,
        `    - /src: /c.png`,
      ].join("\n"),
    );
  });
});
