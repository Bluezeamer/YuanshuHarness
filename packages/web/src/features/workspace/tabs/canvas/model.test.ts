import { expect, test } from "vitest";
import type { CanvasDocJson, CanvasNodeJson } from "../../../../api/canvas";
import {
  absOfRef,
  buildClip,
  cardTitle,
  freeSpot,
  fromFlow,
  hostOfNode,
  infoOf,
  isAssetPath,
  isAutoTitle,
  isLargeAsset,
  isNewFile,
  isNotePath,
  isUnsaved,
  kindOfNode,
  linkNode,
  mergeDocs,
  nearestSide,
  newFile,
  nodeAt,
  noteTitle,
  pastedName,
  pasteInto,
  refFileOf,
  refKeyOf,
  refKindOf,
  refLabel,
  refPath,
  sameInfo,
  sizeForRatio,
  toFlow,
  urlsIn,
} from "./model";

const node = (
  id: string,
  extra: Partial<CanvasNodeJson> = {},
): CanvasNodeJson => ({
  id,
  type: "file",
  file: `boards/板.cards/${id}.md`,
  x: 0,
  y: 0,
  width: 260,
  height: 160,
  ...extra,
});
const doc = (
  nodes: CanvasNodeJson[],
  edges: CanvasDocJson["edges"] = [],
): CanvasDocJson => ({ nodes, edges });

test("节点种类：灵感卡 / 项目文件引用 / 分组 / 其余", () => {
  expect(kindOfNode(node("a"))).toBe("card");
  expect(kindOfNode(node("b", { file: "../docs/x.md" }))).toBe("ref");
  expect(kindOfNode({ ...node("c"), type: "group" })).toBe("group");
  expect(kindOfNode({ ...node("d"), type: "text", file: undefined })).toBe(
    "other",
  );
});

test("显示名：灵感卡取文件名去扩展名，引用路径去掉开头的 ../", () => {
  expect(cardTitle("boards/板.cards/风险与布局.md")).toBe("风险与布局");
  expect(refPath("../docs/design.md")).toBe("docs/design.md");
});

test("拖入的文件只有在目录之内才能成为引用", () => {
  expect(refFileOf("/p", "/p/docs/a.md")).toBe("../docs/a.md");
  expect(refFileOf("/p", "/p")).toBeNull();
  expect(refFileOf("/p", "/other/a.md")).toBeNull();
  expect(refFileOf("/p", "/p2/a.md")).toBeNull();
  expect(absOfRef("/p/", "../docs/a.md")).toBe("/p/docs/a.md");
  expect(absOfRef("/p", "boards/板.cards/a.md")).toBeNull();
});

test("文档 → 画布组件 → 文档：只改位置与大小，不认识的字段与节点原样保留", () => {
  const src: CanvasDocJson = {
    nodes: [
      node("a", { color: "3" }),
      {
        id: "g",
        type: "group",
        label: "风险",
        x: -20,
        y: -20,
        width: 600,
        height: 400,
      },
      {
        id: "t",
        type: "text",
        text: "随手",
        x: 400,
        y: 0,
        width: 200,
        height: 80,
      },
    ],
    edges: [
      {
        id: "e1",
        fromNode: "a",
        toNode: "t",
        fromSide: "right",
        label: "依赖",
        toEnd: "arrow",
      },
    ],
    metadata: { by: "obsidian" },
  };
  const { nodes, edges } = toFlow(src, {});
  expect(nodes[0]?.type).toBe("group");
  const moved = nodes.map((n) =>
    n.id === "a" ? { ...n, position: { x: 12.4, y: 99.6 } } : n,
  );
  const out = fromFlow(src, moved, edges);
  expect(out.nodes.find((n) => n.id === "a")).toMatchObject({
    x: 12,
    y: 100,
    color: "3",
  });
  expect(out.nodes.find((n) => n.id === "t")).toMatchObject({
    type: "text",
    text: "随手",
  });
  expect(out.edges[0]).toMatchObject({
    label: "依赖",
    toEnd: "arrow",
    fromSide: "right",
  });
  expect(out.metadata).toEqual({ by: "obsidian" });
});

test("用户新连的线带端点方向；删掉的节点与线不再出现", () => {
  const src = doc([node("a"), node("b")]);
  const { nodes } = toFlow(src, {});
  const out = fromFlow(
    src,
    nodes.filter((n) => n.id !== "b"),
    [
      {
        id: "n1",
        source: "a",
        target: "b",
        sourceHandle: "right",
        targetHandle: "left",
      },
    ],
  );
  expect(out.nodes.map((n) => n.id)).toEqual(["a"]);
  expect(out.edges[0]).toMatchObject({
    fromNode: "a",
    toNode: "b",
    fromSide: "right",
    toSide: "left",
  });
});

test("合并：我在拖动，agent 同时加了卡片 → 两边的改动都在", () => {
  const base = doc([node("a")]);
  const mine = doc([node("a", { x: 50, y: 60 })]);
  const theirs = doc([node("a"), node("n", { x: 300 })]);
  const m = mergeDocs(base, mine, theirs);
  expect(m.nodes.map((n) => n.id)).toEqual(["a", "n"]);
  expect(m.nodes[0]).toMatchObject({ x: 50, y: 60 });
});

test("合并：我没动的字段取对方改的（agent 改了卡片文件名），我动的位置不被覆盖", () => {
  const base = doc([node("a")]);
  const mine = doc([node("a", { x: 7 })]);
  const theirs = doc([node("a", { file: "boards/板.cards/新名.md" })]);
  expect(mergeDocs(base, mine, theirs).nodes[0]).toMatchObject({
    x: 7,
    file: "boards/板.cards/新名.md",
  });
});

test("合并：对方删了我刚挪过的节点 → 删除生效，连到它的线一起去掉", () => {
  const base = doc(
    [node("a"), node("b")],
    [{ id: "e", fromNode: "a", toNode: "b" }],
  );
  const mine = doc([node("a"), node("b", { x: 9 })], base.edges);
  const theirs = doc([node("a")], base.edges);
  const m = mergeDocs(base, mine, theirs);
  expect(m.nodes.map((n) => n.id)).toEqual(["a"]);
  expect(m.edges).toEqual([]);
});

test("合并：我删了节点，对方没动 → 删除生效；对方改过 → 保留对方的版本", () => {
  const base = doc([node("a"), node("b")]);
  const mine = doc([node("a")]);
  expect(mergeDocs(base, mine, base).nodes.map((n) => n.id)).toEqual(["a"]);
  const edited = doc([node("a"), node("b", { y: 500 })]);
  expect(mergeDocs(base, mine, edited).nodes.map((n) => n.id)).toEqual([
    "a",
    "b",
  ]);
});

test("合并：用户新增的节点与连线保留；未知的顶层字段取对方的", () => {
  const base = doc([node("a")]);
  const mine = doc(
    [node("a"), node("u")],
    [{ id: "e", fromNode: "a", toNode: "u" }],
  );
  const theirs = { ...doc([node("a")]), metadata: { v: 2 } };
  const m = mergeDocs(base, mine, theirs);
  expect(m.nodes.map((n) => n.id)).toEqual(["a", "u"]);
  expect(m.edges).toHaveLength(1);
  expect(m.metadata).toEqual({ v: 2 });
});

test("落在节点里的线按离落点最近的一条边存：四个角各偏向一边，正中取上", () => {
  const size = { width: 260, height: 160 };
  expect(nearestSide({ x: 130, y: 10 }, size)).toBe("top");
  expect(nearestSide({ x: 250, y: 80 }, size)).toBe("right");
  expect(nearestSide({ x: 130, y: 150 }, size)).toBe("bottom");
  expect(nearestSide({ x: 10, y: 80 }, size)).toBe("left");
  // 离上边 20、离左边 30：取更近的上边
  expect(nearestSide({ x: 30, y: 20 }, size)).toBe("top");
  // 正中：距离全不相等时取最小；平局取上
  expect(nearestSide({ x: 130, y: 80 }, { width: 260, height: 160 })).toBe(
    "top",
  );
});

test("nodeAt：连线松手的点落在哪个节点上——卡片范围内都算，起点节点除外，重叠取最上面的，分组垫底", () => {
  const box = (id: string, x: number, y: number, extra = {}) => ({
    id,
    x,
    y,
    width: 100,
    height: 60,
    ...extra,
  });
  const boxes = [
    box("g", -50, -50, { width: 600, height: 400, group: true }),
    box("a", 0, 0),
    box("b", 80, 20),
  ];
  expect(nodeAt({ x: 10, y: 10 }, boxes, "x")).toBe("a");
  // 范围内靠角落也算（不必对准连接点）
  expect(nodeAt({ x: 70, y: 59 }, boxes, "x")).toBe("a");
  // 重叠处取靠后（画在上面）的
  expect(nodeAt({ x: 90, y: 30 }, boxes, "x")).toBe("b");
  // 起点节点不算：落在它身上不连自己，下面的也不会漏出来
  expect(nodeAt({ x: 10, y: 10 }, boxes, "a")).toBe("g");
  expect(nodeAt({ x: 90, y: 30 }, boxes, "b")).toBe("a");
  // 不在任何节点上
  expect(nodeAt({ x: 900, y: 900 }, boxes, "x")).toBeNull();
  // 只在分组里：连到分组
  expect(nodeAt({ x: 400, y: 300 }, boxes, "x")).toBe("g");
});

test("随手记的时间名不显示，用户改过名才显示", () => {
  expect(isAutoTitle("20261110-065652")).toBe(true);
  expect(isAutoTitle("20261110-065652 (2)")).toBe(true);
  expect(isAutoTitle("产品想法")).toBe(false);
  expect(isAutoTitle("20261110")).toBe(false);
  expect(isAutoTitle("20261110-065652-草稿")).toBe(false);
});

test("引用的呈现种类按扩展名分：图片 / markdown / 其余", () => {
  expect(refKindOf("../a/b.PNG")).toBe("image");
  expect(refKindOf("../x.svg")).toBe("image");
  expect(refKindOf("../x.gif")).toBe("image");
  expect(refKindOf("../docs/a.md")).toBe("markdown");
  expect(refKindOf("../src/main.py")).toBe("file");
  expect(refKindOf("../Makefile")).toBe("file");
});

test("引用卡上方的标注是 主机:绝对路径，拆成目录与文件名两段（放不下省略目录、文件名完整）", () => {
  expect(refLabel("本机", "/home/u/proj/", "../docs/design.md")).toEqual({
    head: "本机:/home/u/proj/docs/",
    name: "design.md",
  });
  expect(refLabel("dev-01", "/p", "../a.png")).toEqual({
    head: "dev-01:/p/",
    name: "a.png",
  });
});

test("文件信息比较：预览、大小、时间任一变了才算变", () => {
  const a = {
    exists: true,
    kind: "card" as const,
    size: 3,
    mtimeMs: 1,
    preview: "x",
  };
  expect(sameInfo(a, { ...a })).toBe(true);
  expect(sameInfo(a, { ...a, preview: "y" })).toBe(false);
  expect(sameInfo(a, { ...a, mtimeMs: 2 })).toBe(false);
  expect(sameInfo(null, null)).toBe(true);
  expect(sameInfo(a, null)).toBe(false);
});

test("freeSpot：想要的位置空着就用它；被占了往右挪一格，一行三格，满了换下一行", () => {
  const box = (x: number, y: number) => ({ x, y, width: 260, height: 160 });
  expect(freeSpot({ x: 0, y: 0 }, [])).toEqual({ x: 0, y: 0 });
  expect(freeSpot({ x: 0, y: 0 }, [box(500, 500)])).toEqual({ x: 0, y: 0 });
  expect(freeSpot({ x: 0, y: 0 }, [box(0, 0)])).toEqual({ x: 300, y: 0 });
  // 压着一点点也算占了
  expect(freeSpot({ x: 0, y: 0 }, [box(200, 100)])).toEqual({ x: 600, y: 0 });
  expect(
    freeSpot({ x: 0, y: 0 }, [box(0, 0), box(300, 0), box(600, 0)]),
  ).toEqual({ x: 0, y: 200 });
  // 贴着边但不重叠算空
  expect(freeSpot({ x: 0, y: 0 }, [box(-260, 0)])).toEqual({ x: 0, y: 0 });
});

test("新卡片的占位名：toFlow 把它当卡片、标成没保存，预览取攒着的正文（没有就是空）", () => {
  const ph = newFile("n1");
  expect(isNewFile(ph)).toBe(true);
  expect(isNewFile("boards/板.cards/a.md")).toBe(false);
  const doc: CanvasDocJson = { nodes: [node("n1", { file: ph })], edges: [] };
  const empty = toFlow(doc, {}).nodes[0];
  expect(empty?.type).toBe("card");
  expect(empty?.data).toMatchObject({ draft: true, dirty: true });
  expect(empty?.data.info?.preview).toBe("");
  const typed = toFlow(doc, {}, { [ph]: "写了字" }).nodes[0];
  expect(typed?.data.info?.preview).toBe("写了字");
});

test("infoOf：攒着的正文盖在服务端的预览上；isUnsaved：新卡片或改过正文", () => {
  const a = "boards/板.cards/a.md";
  const files = {
    [a]: { exists: true, kind: "card" as const, preview: "旧", size: 9 },
  };
  expect(infoOf(a, files, {})?.preview).toBe("旧");
  const over = infoOf(a, files, { [a]: "新" });
  expect(over).toMatchObject({ preview: "新", size: 9, exists: true });
  expect(infoOf("boards/板.cards/没有.md", files, {})).toBeNull();
  expect(isUnsaved(a, {})).toBe(false);
  expect(isUnsaved(a, { [a]: "新" })).toBe(true);
  expect(isUnsaved(newFile("n"), {})).toBe(true);
});

test("refKindOf：图片、视频、音频、markdown 与其余；不看大小写", () => {
  for (const f of [
    "../a.png",
    "../a.JPG",
    "../a.jpeg",
    "../a.gif",
    "../a.webp",
    "../a.svg",
  ])
    expect(refKindOf(f)).toBe("image");
  for (const f of [
    "../v.mp4",
    "../v.WEBM",
    "../v.mov",
    "../v.mkv",
    "../v.ogv",
    "../v.m4v",
  ])
    expect(refKindOf(f)).toBe("video");
  for (const f of [
    "../a.mp3",
    "../a.wav",
    "../a.M4A",
    "../a.flac",
    "../a.ogg",
    "../a.opus",
  ])
    expect(refKindOf(f)).toBe("audio");
  expect(refKindOf("../README.md")).toBe("markdown");
  expect(refKindOf("../a.zip")).toBe("file");
  expect(refKindOf("../mp4")).toBe("file");
});

test("画布自己的资源：算引用节点（不是灵感卡）；标注只有文件名，双击在预览里打开 .canvas 里的那个文件；_large 里的认得出来", () => {
  const f = "boards/想法.assets/_large/clip.mp4";
  expect(isAssetPath("boards/想法.assets/p.png")).toBe(true);
  expect(isAssetPath(f)).toBe(true);
  expect(isAssetPath("boards/想法.cards/a.md")).toBe(false);
  expect(isAssetPath("boards/想法.assets/")).toBe(false);
  // 画布在 .canvas/ 根或别的子目录时；项目文件引用（../ 开头）即使路径形似也不算
  expect(isAssetPath("想法.assets/p.png")).toBe(true);
  expect(isAssetPath("产品/想法.assets/p.png")).toBe(true);
  expect(isAssetPath("../docs/x.assets/p.png")).toBe(false);
  expect(isLargeAsset(f)).toBe(true);
  expect(isLargeAsset("boards/想法.assets/p.png")).toBe(false);
  expect(
    kindOfNode({
      id: "a",
      type: "file",
      file: f,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }),
  ).toBe("ref");
  expect(refLabel("本机", "/p", f)).toEqual({ head: "", name: "clip.mp4" });
  expect(absOfRef("/p/", f)).toBe(`/p/.canvas/${f}`);
  expect(absOfRef("/p", "../docs/a.md")).toBe("/p/docs/a.md");
  expect(absOfRef("/p", "boards/想法.cards/a.md")).toBeNull();
});

test("pastedName：剪贴板里的 image.png 与没名字的换成带时间的名字；有自己名字的不动", () => {
  const at = new Date(2026, 10, 10, 9, 5, 3);
  expect(pastedName({ name: "image.png", type: "image/png" }, at)).toBe(
    "粘贴-20261110-090503.png",
  );
  expect(pastedName({ name: "", type: "image/jpeg" }, at)).toBe(
    "粘贴-20261110-090503.jpeg",
  );
  expect(pastedName({ name: "image.PNG", type: "" }, at)).toBe(
    "粘贴-20261110-090503.png",
  );
  expect(pastedName({ name: "方案.pdf", type: "application/pdf" }, at)).toBe(
    "方案.pdf",
  );
  expect(pastedName({ name: "", type: "" }, at)).toBe(
    "粘贴-20261110-090503.bin",
  );
});

test("sizeForRatio：宽度不变高度跟着变；太扁的高度取下限、宽度放大，比例不变", () => {
  expect(sizeForRatio(320, 1.5)).toEqual({ w: 320, h: 213 });
  expect(sizeForRatio(320, 1)).toEqual({ w: 320, h: 320 });
  expect(sizeForRatio(320, 0.5)).toEqual({ w: 320, h: 640 });
  // 10:1 的长条：320 宽只有 32 高，不到下限 72，改成 72 高、720 宽
  expect(sizeForRatio(320, 10)).toEqual({ w: 720, h: 72 });
});

test("链接节点：type 是 link 且有 url 才认；toFlow 带上地址；缺 url 的当其余节点", () => {
  const n = linkNode("https://a.com/x", { x: 10.4, y: 20.6 });
  expect(n).toMatchObject({
    type: "link",
    url: "https://a.com/x",
    x: 10,
    y: 21,
  });
  expect(kindOfNode(n)).toBe("link");
  expect(kindOfNode({ ...n, url: undefined })).toBe("other");
  const f = toFlow(doc([n]), {}).nodes[0];
  expect(f?.type).toBe("link");
  expect(f?.data.url).toBe("https://a.com/x");
});

test("urlsIn：每一行都是 http(s) 地址才算（最多 20 行），其余原样当文字", () => {
  expect(urlsIn("https://a.com/x?y=1#z")).toEqual(["https://a.com/x?y=1#z"]);
  expect(urlsIn("  http://a.com \n\n https://b.org/p  ")).toEqual([
    "http://a.com",
    "https://b.org/p",
  ]);
  for (const t of [
    "",
    "   ",
    "看这个 https://a.com",
    "https://a.com 和 https://b.org",
    "https://a.com\n随便一句",
    "https://a.com/a b",
    "javascript:alert(1)",
    "ftp://a.com/x",
    "a.com",
  ])
    expect(urlsIn(t)).toBeNull();
  expect(
    urlsIn(
      Array.from({ length: 21 }, (_, i) => `https://a.com/${i}`).join("\n"),
    ),
  ).toBeNull();
});

const FROM = { env: "local", dir: "/p", board: "板" };
const ids = (...v: string[]) => new Set(v);
const counter = () => {
  let i = 0;
  return () => `n${++i}`;
};

test("buildClip：只取选中的节点；连线只留两端都被选中的；灵感卡带正文", () => {
  const d = doc(
    [node("a"), node("b"), node("c", { file: "../x.md" })],
    [
      { id: "e1", fromNode: "a", toNode: "b" },
      { id: "e2", fromNode: "b", toNode: "c" },
    ],
  );
  const clip = buildClip(FROM, d, ids("a", "b"), { a: "甲", b: "乙" });
  expect(clip.nodes.map((c) => [c.node.id, c.text])).toEqual([
    ["a", "甲"],
    ["b", "乙"],
  ]);
  expect(clip.edges.map((e) => e.id)).toEqual(["e1"]);
  // 引用不带正文
  expect(buildClip(FROM, d, ids("c"), {}).nodes[0]).not.toHaveProperty("text");
});

test("pasteInto：中心落在指定点；灵感卡变成带正文的新卡片，连线跟着换，原样字段保留", () => {
  const d = doc(
    [
      node("a", { x: 0, y: 0, color: "3" }),
      node("b", { x: 400, y: 0, file: "../docs/x.md" }),
    ],
    [{ id: "e1", fromNode: "a", toNode: "b", label: "依赖" }],
  );
  const clip = buildClip(FROM, d, ids("a", "b"), { a: "正文" });
  const out = pasteInto(clip, FROM, { x: 1000, y: 500 }, counter());
  // 整体范围 x:0..660 y:0..160，中心 (330, 80) → 平移 (670, 420)，取整到 8 的倍数
  const [a, b] = out.nodes;
  expect(a).toMatchObject({
    id: "n1",
    x: 672,
    y: 424,
    color: "3",
    file: newFile("n1"),
  });
  expect(b).toMatchObject({ id: "n2", x: 1072, y: 424, file: "../docs/x.md" });
  expect(out.edits).toEqual({ [newFile("n1")]: "正文" });
  expect(out.edges).toEqual([
    { id: "n3", fromNode: "n1", toNode: "n2", label: "依赖" },
  ]);
  expect(out.skipped).toBe(0);
});

test("笔记：.canvas 树里不在卡片 / 资源文件夹里的 .md；节点标注用不带 .md 的路径；点开、拖入都换算到 .canvas/ 里", () => {
  for (const f of ["设计原则.md", "产品/用户研究.md", "b/c.MD"])
    expect(isNotePath(f)).toBe(true);
  for (const f of [
    "b.cards/a.md",
    "产品/b.cards/a.md",
    "b.assets/a.md",
    "../docs/a.md",
    "a.png",
    "::new:n1",
  ])
    expect(isNotePath(f)).toBe(false);
  expect(noteTitle("产品/用户研究.md")).toBe("产品/用户研究");
  expect(kindOfNode(node("n", { file: "产品/用户研究.md" }))).toBe("note");
  expect(kindOfNode(node("n", { file: "b.cards/a.md" }))).toBe("card");
  expect(kindOfNode(node("n", { file: newFile("n") }))).toBe("card");
  // 别的主机上的 .md 仍是引用，不是笔记
  expect(kindOfNode(node("n", { file: "/srv/a.md", host: "h" } as never))).toBe(
    "ref",
  );
  expect(absOfRef("/p", "产品/用户研究.md")).toBe(
    "/p/.canvas/产品/用户研究.md",
  );
  expect(refFileOf("/p", "/p/.canvas/产品/用户研究.md")).toBe(
    "产品/用户研究.md",
  );
  // .canvas 里不是笔记的东西与隐藏目录、索引照旧当项目文件引用
  expect(refFileOf("/p", "/p/.canvas/b.cards/a.md")).toBe(
    "../.canvas/b.cards/a.md",
  );
  expect(refFileOf("/p", "/p/.canvas/index.md")).toBe("../.canvas/index.md");
  expect(refFileOf("/p", "/p/.canvas/.git/x.md")).toBe("../.canvas/.git/x.md");
});

test("笔记节点：显示信息按卡片那样取（带没保存的正文），粘贴只能回同一个目录、复制不带正文、粘出来仍指向同一个笔记", () => {
  const d = doc([node("a", { file: "n.md" })], []);
  const info = { exists: true, kind: "ref" as const, preview: "磁盘上的" };
  const flow = toFlow(d, { "n.md": info }, { "n.md": "改过的" });
  expect(flow.nodes[0]).toMatchObject({
    type: "note",
    data: { kind: "note", title: "n", dirty: true },
  });
  expect(flow.nodes[0]?.data.info?.preview).toBe("改过的");
  expect(toFlow(d, { "n.md": info }).nodes[0]?.data.info).toBe(info);

  const clip = buildClip(FROM, d, ids("a"), {});
  expect(clip.nodes[0]).not.toHaveProperty("text");
  const same = pasteInto(
    clip,
    { ...FROM, board: "别的" },
    { x: 0, y: 0 },
    counter(),
  );
  expect(same.skipped).toBe(0);
  expect(same.nodes[0]).toMatchObject({ file: "n.md" });
  expect(same.edits).toEqual({});
  const other = pasteInto(
    clip,
    { ...FROM, dir: "/q" },
    { x: 0, y: 0 },
    counter(),
  );
  expect(other.skipped).toBe(1);
  expect(other.nodes).toEqual([]);
});

test("pasteInto：空卡片不记正文；其余节点（链接、文字、分组）照搬", () => {
  const link = linkNode("https://a.com", { x: 0, y: 0 });
  const clip = buildClip(
    FROM,
    doc([
      node("a"),
      link,
      {
        id: "g",
        type: "group",
        label: "组",
        x: 0,
        y: 0,
        width: 50,
        height: 50,
      },
    ]),
    ids("a", link.id, "g"),
    {},
  );
  const out = pasteInto(clip, FROM, { x: 0, y: 0 }, counter());
  expect(out.edits).toEqual({});
  expect(out.nodes.map((n) => n.type)).toEqual(["file", "link", "group"]);
  expect(out.nodes[1]).toMatchObject({ url: "https://a.com" });
});

test("pasteInto：项目文件引用只能回到同一个目录，画布自己的资源只能回到同一块画布，灵感卡哪里都行", () => {
  const d = doc([
    node("card"),
    node("ref", { file: "../a.md" }),
    node("img", { file: "boards/板.assets/p.png" }),
  ]);
  const clip = buildClip(FROM, d, ids("card", "ref", "img"), { card: "字" });
  const files = (p: ReturnType<typeof pasteInto>) => p.nodes.map((n) => n.file);
  // 同目录同画布：全放得下
  expect(pasteInto(clip, FROM, { x: 0, y: 0 }, counter()).skipped).toBe(0);
  // 同目录别的画布：资源放不了
  const other = pasteInto(
    clip,
    { ...FROM, board: "别的" },
    { x: 0, y: 0 },
    counter(),
  );
  expect(other.skipped).toBe(1);
  expect(files(other)).toEqual([newFile("n1"), "../a.md"]);
  // 别的目录：只剩灵感卡
  const far = pasteInto(
    clip,
    { ...FROM, dir: "/q" },
    { x: 0, y: 0 },
    counter(),
  );
  expect(far.skipped).toBe(2);
  expect(files(far)).toEqual([newFile("n1")]);
  // 全放不了：什么都不加
  const none = pasteInto(
    buildClip(FROM, doc([node("ref", { file: "../a.md" })]), ids("ref"), {}),
    { ...FROM, env: "dev" },
    { x: 0, y: 0 },
  );
  expect(none).toEqual({ nodes: [], edges: [], edits: {}, skipped: 1 });
});

test("别的主机上的引用：有 host 的文件节点是引用；信息表的键带主机，同一路径在不同主机上各是各的", () => {
  const abs = "/srv/notes.md";
  const a = node("a", { file: abs, host: "dev" });
  const b = node("b", { file: abs, host: "dev2" });
  const c = node("c", { file: abs });
  expect(kindOfNode(a)).toBe("ref");
  expect(hostOfNode(a)).toBe("dev");
  expect(hostOfNode(c)).toBe("");
  expect([refKeyOf(a), refKeyOf(b), refKeyOf(c)]).toEqual([
    "dev:/srv/notes.md",
    "dev2:/srv/notes.md",
    "/srv/notes.md",
  ]);
  const info = (preview: string) => ({
    exists: true,
    kind: "ref" as const,
    preview,
  });
  const { nodes } = toFlow(doc([a, b]), {
    "dev:/srv/notes.md": info("甲"),
    "dev2:/srv/notes.md": info("乙"),
  });
  expect(
    nodes.map((n) => [n.data.host, n.data.key, n.data.info?.preview]),
  ).toEqual([
    ["dev", "dev:/srv/notes.md", "甲"],
    ["dev2", "dev2:/srv/notes.md", "乙"],
  ]);
  // 往返：host 字段原样保留
  const out = fromFlow(doc([a]), toFlow(doc([a]), {}).nodes, []);
  expect(out.nodes[0]).toMatchObject({ file: abs, host: "dev" });
});

test("别的主机上的引用的标注：主机名 + 绝对路径（Windows 路径两种分隔符都认），文件名完整", () => {
  expect(refLabel("dev-01", "/p", "/srv/a/b.md", true)).toEqual({
    head: "dev-01:/srv/a/",
    name: "b.md",
  });
  expect(refLabel("win", "/p", "C:\\Users\\a\\x.png", true)).toEqual({
    head: "win:C:\\Users\\a\\",
    name: "x.png",
  });
  expect(cardTitle("/srv/a/b.md")).toBe("b");
});

test("pasteInto：别的主机上的引用哪里都能放（不受目录与画布限制）", () => {
  const remote = node("r", { file: "/srv/a.md", host: "dev" });
  const clip = buildClip(FROM, doc([remote]), ids("r"), {});
  const far = pasteInto(
    clip,
    { env: "other", dir: "/q", board: "别的" },
    { x: 0, y: 0 },
    counter(),
  );
  expect(far.skipped).toBe(0);
  expect(far.nodes[0]).toMatchObject({ file: "/srv/a.md", host: "dev" });
});
