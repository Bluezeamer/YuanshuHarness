import { describe, expect, test } from "vitest";
import {
  addFileNode,
  type CanvasDoc,
  CanvasFormatError,
  fileNodes,
  parseCanvas,
  placeNew,
  removeNodesByFile,
  renameFileRefs,
  renameFileRefsUnder,
  serializeCanvas,
} from "./format.js";

const doc = (): CanvasDoc => ({
  nodes: [],
  edges: [],
});

const fileNode = (id: string, file: string, x = 0, y = 0) => ({
  id,
  type: "file",
  file,
  x,
  y,
  width: 260,
  height: 160,
});

describe("parseCanvas / serializeCanvas", () => {
  test("空文件与缺字段当空数组，不报错", () => {
    expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas("  \n")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas('{"nodes":[]}')).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas('{"edges":[]}')).toEqual({ nodes: [], edges: [] });
  });

  test("坏节点只丢那一个，好节点与未知字段原样保留", () => {
    const text = JSON.stringify({
      nodes: [
        {
          id: "a",
          type: "file",
          file: "x.md",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          color: "3",
        },
        { id: "b", type: "file", x: "0", y: 0, width: 1, height: 1 },
        {
          id: "c",
          type: "group",
          label: "分组",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
        "not a node",
      ],
      edges: [
        { id: "e1", fromNode: "a", toNode: "c", label: "依赖", subpath: "#h" },
        { id: "e2", fromNode: "a" },
      ],
      unknown: { keep: true },
    });
    const parsed = parseCanvas(text);
    expect(parsed.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(parsed.nodes[0]?.color).toBe("3");
    expect(parsed.nodes[1]?.label).toBe("分组");
    expect(parsed.edges).toEqual([
      { id: "e1", fromNode: "a", toNode: "c", label: "依赖", subpath: "#h" },
    ]);
    expect(parsed.unknown).toEqual({ keep: true });
  });

  test("整体不是 JSON 抛 CanvasFormatError（中文消息）", () => {
    expect(() => parseCanvas("{oops")).toThrow(CanvasFormatError);
    expect(() => parseCanvas("[1,2]")).toThrow(CanvasFormatError);
    try {
      parseCanvas("{oops");
    } catch (err) {
      expect((err as Error).message).toMatch(/JSON/);
    }
  });

  test("序列化与 Obsidian 一致：制表符缩进 + 末尾换行", () => {
    const text = serializeCanvas({ nodes: [], edges: [] });
    expect(text).toBe('{\n\t"nodes": [],\n\t"edges": []\n}\n');
    expect(serializeCanvas(parseCanvas(text))).toBe(text);
  });
});

describe("placeNew / addFileNode", () => {
  test("空画布从 (0,0) 起，按行优先、每行 5 格", () => {
    expect(placeNew(doc())).toEqual({ x: 0, y: 0 });
    const d = doc();
    for (let i = 0; i < 5; i++)
      addFileNode(d, `a${i}.md`, { x: i * 300, y: 0 });
    expect(placeNew(d)).toEqual({ x: 0, y: 200 });
  });

  test("避开已有节点的包围盒", () => {
    const d = doc();
    d.nodes.push(fileNode("a", "a.md", 0, 0));
    d.nodes.push(fileNode("b", "b.md", 300, 0));
    expect(placeNew(d)).toEqual({ x: 600, y: 0 });
  });

  test("addFileNode 生成 16 位十六进制 id 并推入节点", () => {
    const d = doc();
    const n = addFileNode(d, "boards/想法.cards/a.md");
    expect(n.id).toMatch(/^[0-9a-f]{16}$/);
    expect(d.nodes).toHaveLength(1);
    expect(n).toMatchObject({
      type: "file",
      file: "boards/想法.cards/a.md",
      width: 260,
      height: 160,
    });
    const other = addFileNode(d, "b.md", { x: 900, y: 400 });
    expect(other).toMatchObject({ x: 900, y: 400 });
  });
});

describe("节点增删", () => {
  const base = (): CanvasDoc => ({
    nodes: [
      fileNode("a", "one.md", 0, 0),
      fileNode("b", "two.md", 300, 0),
      { id: "g", type: "group", x: 0, y: 0, width: 900, height: 400 },
    ],
    edges: [
      { id: "e1", fromNode: "a", toNode: "b" },
      { id: "e2", fromNode: "b", toNode: "g" },
    ],
  });

  test("fileNodes 只取 type=file 且有 file 的节点", () => {
    expect(fileNodes(base()).map((n) => n.id)).toEqual(["a", "b"]);
  });

  test("removeNodesByFile 连边一起删，返回节点数", () => {
    const d = base();
    expect(removeNodesByFile(d, "two.md")).toBe(1);
    expect(d.nodes.map((n) => n.id)).toEqual(["a", "g"]);
    expect(d.edges).toEqual([]);
    expect(removeNodesByFile(d, "two.md")).toBe(0);
  });

  test("renameFileRefs 只改精确匹配；renameFileRefsUnder 改前缀", () => {
    const d = base();
    d.nodes.push(fileNode("c", "boards/x.cards/a.md", 0, 600));
    d.nodes.push(fileNode("e", "boards/x.cards/b.md", 300, 600));
    expect(renameFileRefs(d, "one.md", "uno.md")).toBe(1);
    expect(renameFileRefsUnder(d, "boards/x.cards", "boards/y.cards")).toBe(2);
    expect(d.nodes.filter((n) => n.type === "file").map((n) => n.file)).toEqual(
      ["uno.md", "two.md", "boards/y.cards/a.md", "boards/y.cards/b.md"],
    );
  });
});
