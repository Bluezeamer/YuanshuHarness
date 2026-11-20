// dom-view.ts 的渲染规则：一行一个元素、缩进表示层级、根元素带 @ 计算值、超预算按整行截。
// 全部是手写的 DomCapture，不碰引擎。
import { describe, expect, test } from "vitest";
import type {
  DomCapture,
  DomElement,
  DomGroup,
  DomTarget,
} from "../engine/types.js";
import { renderDom } from "./dom-view.js";

const SHELL = [
  "DOM: 示例页 | https://example.com/a",
  'QUERY: selector "img"',
  "NORMALIZED: comments dropped; script/style bodies, svg internals and templates summarized; long attribute values and data: URLs shortened; open shadow roots expanded; iframe contents are not included in ref/document views; hidden elements are included",
];

const el = (tag: string, extra: Partial<DomElement> = {}): DomElement => ({
  tag,
  attrs: [],
  kids: [],
  ...extra,
});

const group = (
  roots: DomElement[],
  rest: Partial<DomGroup> = {},
): DomGroup => ({
  frame: { url: "https://example.com/a", main: true },
  total: roots.length,
  roots,
  ...rest,
});

const run = (
  capture: DomCapture,
  target: DomTarget = { selector: "img" },
): ReturnType<typeof renderDom> =>
  renderDom(capture, {
    title: "示例页",
    url: "https://example.com/a",
    target,
  });

const text = (capture: DomCapture, target: DomTarget = { selector: "img" }) =>
  run(capture, target).text;

describe("renderDom", () => {
  test("叶子：文字写在标签行里，属性照原样", () => {
    const out = text({
      groups: [
        group([
          el("img", {
            attrs: [
              { name: "alt", value: "猫", length: 1 },
              { name: "src", value: "/a.png", length: 6 },
            ],
            natural: { width: 20, height: 10 },
          }),
        ]),
      ],
      nodeCapHit: false,
    });
    expect(out.split("\n").slice(3)).toEqual([
      "FRAME main:",
      '[1] <img alt="猫" src="/a.png"> @natural=20x10',
    ]);
  });

  test("有文字的叶子写在同一行并闭合；empty 元素只写开始标签", () => {
    const out = text(
      {
        groups: [
          group([
            el("a", {
              attrs: [{ name: "download", value: "", length: 0 }],
              kids: [{ text: "报告.zip", length: 6 }],
            }),
            el("area", { attrs: [{ name: "href", value: "/hot", length: 4 }] }),
          ]),
        ],
        nodeCapHit: false,
      },
      null,
    );
    expect(out.split("\n").slice(3)).toEqual([
      "<a download>报告.zip</a>",
      '<area href="/hot">',
    ]);
  });

  test("summary 一行写完，不渲染孩子", () => {
    const out = text(
      {
        groups: [
          group([
            el("script", {
              summary: "inline script, 120 chars",
              kids: [{ text: "不该出现", length: 4 }],
            }),
          ]),
        ],
        nodeCapHit: false,
      },
      { ref: "e3" },
    );
    expect(out.split("\n").slice(1)).toEqual([
      "QUERY: ref e3",
      SHELL[2] as string,
      "<script> (inline script, 120 chars)",
    ]);
  });

  test("嵌套缩进两格，孩子里的文本节点单独一行", () => {
    const out = text(
      {
        groups: [
          group([
            el("form", {
              attrs: [
                { name: "action", value: "/submit", length: 7 },
                { name: "method", value: "post", length: 4 },
              ],
              kids: [
                { text: "说明文字", length: 4 },
                el("input", {
                  attrs: [{ name: "type", value: "text", length: 4 }],
                }),
              ],
            }),
          ]),
        ],
        nodeCapHit: false,
      },
      null,
    );
    expect(out.split("\n").slice(3)).toEqual([
      '<form action="/submit" method="post">',
      '  "说明文字"',
      '  <input type="text">',
    ]);
  });

  test("open shadow root 的内容放在 #shadow-root 行下面再缩进两格", () => {
    const out = text(
      {
        groups: [
          group([
            el("div", {
              attrs: [{ name: "id", value: "host", length: 4 }],
              kids: [],
              shadow: [
                el("video", {
                  attrs: [{ name: "src", value: "/v.mp4", length: 6 }],
                  currentSrc: "https://example.com/v.mp4",
                }),
              ],
            }),
          ]),
        ],
        nodeCapHit: false,
      },
      null,
    );
    expect(out.split("\n").slice(3)).toEqual([
      '<div id="host">',
      "  #shadow-root",
      '    <video src="/v.mp4"> @src=https://example.com/v.mp4',
    ]);
  });

  test("属性值里的引号转义；空值的属性只写名字", () => {
    const out = text(
      {
        groups: [
          group([
            el("a", {
              attrs: [
                { name: "title", value: '他说"你好"', length: 6 },
                { name: "download", value: "", length: 0 },
              ],
            }),
          ]),
        ],
        nodeCapHit: false,
      },
      null,
    );
    expect(out.split("\n")[3]).toBe('<a title="他说\\"你好\\"" download>');
  });

  test("长属性值按 300 截断并标出剩下的字符数；data: 地址写成说明", () => {
    const long = "x".repeat(4000);
    const data = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAA";
    const out = text(
      {
        groups: [
          group([
            el("img", {
              attrs: [
                { name: "long", value: long.slice(0, 4000), length: 4000 },
                { name: "src", value: data, length: data.length },
              ],
            }),
          ]),
        ],
        nodeCapHit: false,
      },
      null,
    );
    const line = out.split("\n")[3] ?? "";
    expect(line).toContain(`${"x".repeat(300)}…(+3700 chars)`);
    expect(line).toContain(`src="data:image/gif (${data.length} chars)"`);
  });

  test("文本超过 300 也截断并标出长度", () => {
    const out = text(
      {
        groups: [
          group([
            el("p", {
              kids: [{ text: "y".repeat(500), length: 500 }],
            }),
          ]),
        ],
        nodeCapHit: false,
      },
      null,
    );
    expect(out.split("\n")[3]).toBe(`<p>${"y".repeat(300)}…(+200 chars)</p>`);
  });

  test("根元素行末追加 @ 计算值，顺序是 box、natural、src；非根没有 @box", () => {
    const out = text({
      groups: [
        group([
          el("img", {
            attrs: [{ name: "src", value: "/placeholder.gif", length: 16 }],
            box: { x: 10, y: 20, width: 30, height: 40 },
            natural: { width: 1, height: 1 },
            currentSrc: "https://example.com/real.png",
            kids: [
              el("span", {
                // 后代即使带着 box 也不写 @box（只有被查询命中的根元素才有视口坐标）。
                box: { x: 1, y: 2, width: 3, height: 4 },
                natural: { width: 2, height: 3 },
                currentSrc: "https://example.com/inner.png",
              }),
            ],
          }),
          el("video", {
            box: { x: 0, y: 0, width: 640, height: 360 },
          }),
        ]),
      ],
      nodeCapHit: false,
    });
    expect(out.split("\n").slice(3)).toEqual([
      "FRAME main:",
      '[1] <img src="/placeholder.gif"> @box=10,20,30,40 @natural=1x1 @src=https://example.com/real.png',
      "  <span> @natural=2x3 @src=https://example.com/inner.png",
      "[2] <video> @box=0,0,640,360",
    ]);
  });

  test("selector 模式：每个 group 一段 FRAME 行，编号跨 group 连续", () => {
    const out = text({
      groups: [
        group([el("img"), el("img")]),
        group([el("img")], {
          frame: { url: "https://ads.example/x", main: false },
        }),
      ],
      nodeCapHit: false,
    });
    expect(out.split("\n").slice(3)).toEqual([
      "FRAME main:",
      "[1] <img>",
      "[2] <img>",
      "FRAME https://ads.example/x (positions are inside the frame):",
      "[3] <img>",
    ]);
  });

  test("ref / document 模式没有 FRAME 行与编号行首", () => {
    const out = text(
      { groups: [group([el("html")])], nodeCapHit: false },
      null,
    );
    expect(out.split("\n")).toEqual([
      "DOM: 示例页 | https://example.com/a",
      "QUERY: document",
      SHELL[2] as string,
      "<html>",
    ]);
  });

  test("命中数多于列出的：末尾声明还有多少没列", () => {
    const out = text({
      groups: [group([el("img"), el("img")], { total: 250 })],
      nodeCapHit: false,
    });
    expect(out.split("\n").slice(-1)).toEqual([
      "… 248 more matches not listed (narrow the selector)",
    ]);
  });

  test("节点上限触发：内容末尾加一行 TRUNCATED", () => {
    const out = text({ groups: [group([el("div")])], nodeCapHit: true });
    expect(out.split("\n").slice(-1)).toEqual([
      "TRUNCATED: node cap reached; the rest of the page was not read (narrow the selector or use ref)",
    ]);
  });

  test("没有 group：写 No elements matched.", () => {
    const out = text({ groups: [], nodeCapHit: false });
    expect(out.split("\n")).toEqual([...SHELL, "No elements matched."]);
  });

  test("刚好不超预算：elided 为 false，text 与 full 相同", () => {
    const alt = "a".repeat(280);
    const out = run({
      groups: [
        group([
          el("img", { attrs: [{ name: "alt", value: alt, length: 280 }] }),
        ]),
      ],
      nodeCapHit: false,
    });
    expect(out.elided).toBe(false);
    expect(out.text).toBe(out.full);
    expect(out.text.split("\n").slice(3)).toEqual([
      "FRAME main:",
      `[1] <img alt="${alt}">`,
    ]);
  });

  test("超预算：按整行留前缀 + 提示行，full 是完整文字", () => {
    // 300 个根元素、每个一行 69 字符：远超 12000。
    const alt = "z".repeat(50);
    const roots = Array.from({ length: 300 }, (_, i) =>
      el("img", {
        attrs: [
          {
            name: "alt",
            value: `${String(i).padStart(3, "0")}${alt}`,
            length: 53,
          },
        ],
      }),
    );
    const out = run({ groups: [group(roots)], nodeCapHit: false });
    expect(out.elided).toBe(true);
    expect(out.full.split("\n")).toHaveLength(3 + 1 + 300);
    expect(out.full.split("\n")[3]).toBe("FRAME main:");
    expect(out.full.split("\n")[4]).toBe(`[1] <img alt="000${alt}">`);
    const tail = out.text.split("\n");
    const kept = tail.slice(4, -1);
    // 外壳原样、内容按整行保留（每条都是完整的一行）、总长不超过 6000。
    expect(tail.slice(0, 4)).toEqual([...SHELL, "FRAME main:"]);
    expect(kept.join("\n").length).toBeLessThanOrEqual(6000);
    expect(kept.at(-1)).toBe(
      `[${kept.length}] <img alt="${String(kept.length - 1).padStart(3, "0")}${alt}">`,
    );
    // 301 行 = FRAME 行 + 300 个根元素；kept 不含 FRAME 行。
    expect(tail.at(-1)).toBe(
      `… ${301 - kept.length - 1} more lines (301 lines total); full text is saved as an attachment`,
    );
  });
});

describe("renderDom：叶子带计算值", () => {
  test("有文字的叶子：文字在标签内、计算值在行末", () => {
    const out = text(
      {
        groups: [
          group([
            el("a", {
              attrs: [{ name: "href", value: "/f", length: 2 }],
              box: { x: 8, y: 481, width: 64, height: 17 },
              kids: [{ text: "下载资料", length: 4 }],
            }),
          ]),
        ],
        nodeCapHit: false,
      },
      null,
    );
    expect(out.split("\n")[3]).toBe(
      '<a href="/f">下载资料</a> @box=8,481,64,17',
    );
  });
});
