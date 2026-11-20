import { describe, expect, test } from "vitest";
import type { CanvasNode } from "./format.js";
import {
  type IndexFile,
  type IndexInput,
  type IndexNote,
  renderIndex,
} from "./index-md.js";

const node = (
  id: string,
  file: string,
  over: Partial<CanvasNode> = {},
): CanvasNode => ({
  id,
  type: "file",
  file,
  x: 0,
  y: 0,
  width: 260,
  height: 160,
  ...over,
});

const other = (
  id: string,
  type: string,
  over: Record<string, unknown>,
): CanvasNode => ({ id, type, x: 0, y: 0, width: 100, height: 100, ...over });

const edge = (from: string, to: string, label?: string) => ({
  id: `${from}-${to}`,
  fromNode: from,
  toNode: to,
  ...(label === undefined ? {} : { label }),
});

const note = (path: string, text: string | null, size?: number): IndexNote => ({
  path,
  text,
  size: size ?? (text === null ? null : Buffer.byteLength(text)),
});

const empty = (): IndexInput => ({ boards: [], notes: [] });

const file = (text: string | null, size?: number): IndexFile => ({
  exists: true,
  text,
  ...(size === undefined ? {} : { size }),
});

describe("renderIndex", () => {
  test("什么都没有：三段骨架都在，空的写 (none)", () => {
    expect(renderIndex(empty())).toBe(
      [
        "# index",
        "",
        "generated - do not edit",
        "",
        "## tree",
        "",
        "(none)",
        "",
        "## boards",
        "",
        "(none)",
        "",
        "## notes",
        "",
        "(none)",
        "",
      ].join("\n"),
    );
  });

  test("两层拓扑：目录树 → 每块画布的节点与连线 → 每篇笔记在哪些画布上、链到谁", () => {
    const card = "# 风险与布局\n正文";
    const md = renderIndex({
      boards: [
        {
          name: "想法",
          doc: {
            nodes: [
              node("a3f7c2d1aaaaaaaa", "想法.cards/风险.md"),
              node("b1e490faaaaaaaaa", "设计原则.md"),
              node("c20d8b31aaaaaaaa", "../docs/design.md"),
              node("d0000001aaaaaaaa", "/data/logo.png", { host: "local" }),
              other("e0000001aaaaaaaa", "link", { url: "https://x.dev" }),
              other("f0000001aaaaaaaa", "group", { label: "风险" }),
            ],
            edges: [
              edge("a3f7c2d1aaaaaaaa", "b1e490faaaaaaaaa", "依赖"),
              edge("a3f7c2d1aaaaaaaa", "c20d8b31aaaaaaaa"),
            ],
          },
          files: new Map([
            ["想法.cards/风险.md", file(card)],
            ["../docs/design.md", file(null, 1500)],
          ]),
        },
        {
          name: "产品/时间线",
          doc: {
            nodes: [node("d04f1a92aaaaaaaa", "设计原则.md")],
            edges: [],
          },
          files: new Map(),
        },
      ],
      notes: [
        note(
          "设计原则.md",
          "# 设计原则\n参见 [[产品/用户研究]]、[[不存在]]",
          2048,
        ),
        note(
          "产品/用户研究.md",
          "用户访谈记录\n见 [[想法.canvas]] 和 [[设计原则]]",
        ),
      ],
    });
    expect(md).toBe(
      [
        "# index",
        "",
        "generated - do not edit",
        "",
        "## tree",
        "",
        "想法.canvas",
        "设计原则.md",
        "产品/",
        "  时间线.canvas",
        "  用户研究.md",
        "",
        "## boards",
        "",
        'b1  产品/时间线.canvas  "时间线"',
        "  linked-from: (none)",
        "  nodes",
        '    d04f1a92  note  设计原则.md  "设计原则"  2 kB',
        "  edges",
        "    (none)",
        "",
        'b2  想法.canvas  "想法"',
        "  linked-from: no1",
        "  nodes",
        '    a3f7c2d1  card  想法.cards/风险.md  "风险与布局"  24 B',
        '    b1e490fa  note  设计原则.md  "设计原则"  2 kB',
        '    c20d8b31  ref  ../docs/design.md  "design"  2 kB',
        '    d0000001  ref  local:/data/logo.png  "logo"',
        "    e0000001  link  https://x.dev",
        '    f0000001  group  "风险"',
        "  edges",
        '    a3f7c2d1 -> b1e490fa  "依赖"',
        "    a3f7c2d1 -> c20d8b31",
        "",
        "## notes",
        "",
        'no1  产品/用户研究.md  "用户访谈记录"  61 B',
        "  appears-in: (none)",
        "  links-to: [[想法.canvas]] [[设计原则.md]]",
        "  linked-from: no2",
        "",
        'no2  设计原则.md  "设计原则"  2 kB',
        "  appears-in: b1 b2",
        "  links-to: [[产品/用户研究.md]] [[不存在]](missing)",
        "  linked-from: no1",
        "",
      ].join("\n"),
    );
  });

  test("缺失的文件标 missing（灵感卡、笔记、项目文件一样）", () => {
    const md = renderIndex({
      boards: [
        {
          name: "b",
          doc: {
            nodes: [
              node("a1", "b.cards/gone.md"),
              node("a2", "没有.md"),
              node("a3", "../gone.txt"),
            ],
            edges: [],
          },
          files: new Map<string, IndexFile>([
            ["b.cards/gone.md", { exists: false, text: null }],
            ["../gone.txt", { exists: false, text: null }],
          ]),
        },
      ],
      notes: [],
    });
    expect(md).toContain("    a1  card  b.cards/gone.md  missing\n");
    expect(md).toContain("    a2  note  没有.md  missing\n");
    expect(md).toContain("    a3  ref  ../gone.txt  missing\n");
  });

  test("标题：跳过 frontmatter、去掉 # 记号、折成一行、双引号换成单引号、超过 40 字截断；没有正文用文件名", () => {
    const long = "长".repeat(50);
    const md = renderIndex({
      ...empty(),
      notes: [
        note("a.md", '---\ntags: [x]\n---\n\n## 带 "引号" 的  标题 ##\n正文'),
        note("b.md", long),
        note("c.md", ""),
        note("d.md", null, 5000000),
      ],
    });
    expect(md).toContain("no1  a.md  \"带 '引号' 的 标题\"  ");
    expect(md).toContain(`no2  b.md  "${"长".repeat(40)}..."  150 B`);
    expect(md).toContain('no3  c.md  "c"  0 B');
    expect(md).toContain('no4  d.md  "d"  5000 kB');
  });

  test("别的主机上的引用：写成「主机名:绝对路径」，不查存在；同名路径在不同主机上各一行", () => {
    const md = renderIndex({
      boards: [
        {
          name: "b",
          doc: {
            nodes: [
              node("a1", "/srv/x.md", { host: "env-1" }),
              node("a2", "/srv/x.md", { host: "env-2" }),
            ],
            edges: [],
          },
          files: new Map(),
        },
      ],
      notes: [],
      hostLabel: (id) => (id === "env-1" ? "dev-01" : id),
    });
    expect(md).toContain('    a1  ref  dev-01:/srv/x.md  "x"\n');
    expect(md).toContain('    a2  ref  env-2:/srv/x.md  "x"\n');
  });

  test("文本节点与连到非文件节点的连线也在；断了的连线照写前 8 位", () => {
    const md = renderIndex({
      boards: [
        {
          name: "b",
          doc: {
            nodes: [
              other("t1234567890", "text", { text: "\n\n第一行\n第二行" }),
              other("g1234567890", "group", {}),
            ],
            edges: [edge("t1234567890", "zzzzzzzzzzzz")],
          },
          files: new Map(),
        },
      ],
      notes: [],
    });
    expect(md).toContain('    t1234567  text  "第一行"\n');
    expect(md).toContain('    g1234567  group  ""\n');
    expect(md).toContain("    t1234567 -> zzzzzzzz\n");
  });

  test("笔记链到自己不算被谁引用；代码块里的 [[…]] 不算链接", () => {
    const md = renderIndex({
      ...empty(),
      notes: [
        note("a.md", "[[a]]\n```\n[[b]]\n```\n`[[c]]`"),
        note("b.md", "x"),
      ],
    });
    expect(md).toContain("no1  a.md");
    expect(md).toContain("  links-to: [[a.md]]\n");
    expect(md).toContain("  linked-from: (none)\n\nno2  b.md");
  });

  test("同输入同输出，输入顺序不影响结果", () => {
    const a = {
      ...empty(),
      notes: [note("a.md", "x"), note("b.md", "y")],
    };
    const b = { ...empty(), notes: [...a.notes].reverse() };
    expect(renderIndex(a)).toBe(renderIndex(b));
    expect(renderIndex(a)).toBe(renderIndex(a));
  });
});
