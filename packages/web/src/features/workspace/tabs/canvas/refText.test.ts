import { expect, test } from "vitest";
import type { FileDragItem } from "../files/verdict";
import {
  fileDirOf,
  projectRefsOf,
  relativePath,
  wikiRefOf,
  wikiRefsOf,
} from "./refText";

// 一项的快捷写法：只给路径（名字取末段）；要多项就给 paths
const item = (
  over: Partial<Omit<FileDragItem, "entries">> & {
    path?: string;
    name?: string;
    paths?: string[];
  },
): FileDragItem => {
  const { path = "/p/docs/a.md", name, paths, ...rest } = over;
  return {
    host: "server",
    env: "local",
    hostName: "本机",
    entries: (paths ?? [path]).map((p) => ({
      path: p,
      name: paths ? (p.split("/").pop() as string) : (name ?? "a.md"),
      isDir: false,
      size: 1,
    })),
    sessionId: null,
    tabId: "t1",
    ...rest,
  };
};

test("树里拖来的笔记 / 画布：笔记去掉 .md、画布保留 .canvas；多个一行一条", () => {
  expect(wikiRefOf("产品/用户研究.md")).toBe("[[产品/用户研究]]");
  expect(wikiRefOf("想法.canvas")).toBe("[[想法.canvas]]");
  expect(wikiRefOf("a.MD")).toBe("[[a]]");
  expect(wikiRefsOf(["a.md", "b/c.canvas"])).toBe("[[a]]\n[[b/c.canvas]]");
});

test("relativePath：从当前文件所在的目录到目标；同级、往上、往下、跨分支都对", () => {
  expect(relativePath("/p/.canvas", "/p/docs/a.md")).toBe("../docs/a.md");
  expect(relativePath("/p/.canvas/产品", "/p/docs/a.md")).toBe(
    "../../docs/a.md",
  );
  expect(relativePath("/p/.canvas/产品", "/p/.canvas/产品/x.md")).toBe("x.md");
  expect(relativePath("/p/.canvas", "/p/.canvas/产品/x.md")).toBe("产品/x.md");
  expect(relativePath("/p/a/b", "/p/c/d/e.png")).toBe("../../c/d/e.png");
  expect(relativePath("/p", "/p/a.md")).toBe("a.md");
});

test("项目文件 → 相对路径的标准链接；图片带 !；名字里的方括号转义，路径里的空格与括号编码；中文保持原样", () => {
  const ctx = { fileDir: "/p/.canvas/产品", env: "local", projectDir: "/p" };
  expect(projectRefsOf(item({}), ctx)).toBe("[a.md](../../docs/a.md)");
  expect(
    projectRefsOf(
      item({ path: "/p/docs/图 1(终).png", name: "图 1(终).png" }),
      ctx,
    ),
  ).toBe("![图 1(终).png](../../docs/图%201%28终%29.png)");
  expect(
    projectRefsOf(item({ path: "/p/docs/[草稿].md", name: "[草稿].md" }), ctx),
  ).toBe("[\\[草稿\\].md](../../docs/[草稿].md)");
});

test("多选一行一条；别的主机上的文件写 file:主机:绝对路径（不用相对路径）", () => {
  const ctx = { fileDir: "/p/.canvas", env: "local", projectDir: "/p" };
  expect(
    projectRefsOf(item({ paths: ["/p/docs/a.md", "/p/docs/b.png"] }), ctx),
  ).toBe("[a.md](../docs/a.md)\n![b.png](../docs/b.png)");
  expect(
    projectRefsOf(
      item({ env: "gpu", host: "gpu", path: "/srv/x y.md", name: "x y.md" }),
      ctx,
    ),
  ).toBe("[x y.md](file:gpu:/srv/x%20y.md)");
});

test("dropTextOf：不是我们认的拖拽返回 null；dragover 时认得就返回空串（放行）；drop 时树里的出 wikilink、文件管理器的出项目链接", async () => {
  const { dropTextOf, TREE_DRAG_TYPE } = await import("./refText");
  const ctx = (file: FileDragItem | null) => ({
    fileDir: "/p/.canvas",
    env: "local",
    projectDir: "/p",
    getFileDrag: () => file,
  });
  const dt = (types: string[], data: Record<string, string> = {}) =>
    ({
      types,
      getData: (k: string) => data[k] ?? "",
    }) as unknown as DataTransfer;
  const ev = (type: string, d: DataTransfer | null) =>
    ({ type, dataTransfer: d }) as Pick<DragEvent, "type" | "dataTransfer">;

  expect(dropTextOf(ev("drop", dt(["text/plain"])), ctx(null))).toBeNull();
  expect(dropTextOf(ev("dragover", dt([TREE_DRAG_TYPE])), ctx(null))).toBe("");
  expect(
    dropTextOf(
      ev(
        "drop",
        dt([TREE_DRAG_TYPE], {
          [TREE_DRAG_TYPE]: '["产品/调研.md","想法.canvas"]',
        }),
      ),
      ctx(null),
    ),
  ).toBe("[[产品/调研]]\n[[想法.canvas]]");
  expect(
    dropTextOf(
      ev("drop", dt([TREE_DRAG_TYPE], { [TREE_DRAG_TYPE]: "{坏的" })),
      ctx(null),
    ),
  ).toBeNull();
  expect(
    dropTextOf(
      ev("drop", dt([TREE_DRAG_TYPE], { [TREE_DRAG_TYPE]: "[]" })),
      ctx(null),
    ),
  ).toBeNull();
  // 文件管理器的单例优先；dragover 同样放行
  const f = item({});
  expect(dropTextOf(ev("dragover", dt([])), ctx(f))).toBe("");
  expect(dropTextOf(ev("drop", dt([])), ctx(f))).toBe("[a.md](../docs/a.md)");
});

test("fileDirOf：笔记在它所在的文件夹、灵感卡在画布的 .cards 里、根上的笔记与新卡片在 .canvas 本身；目录末尾的斜杠不影响", () => {
  expect(fileDirOf("/p", "产品/调研.md")).toBe("/p/.canvas/产品");
  expect(fileDirOf("/p/", "产品/调研.md")).toBe("/p/.canvas/产品");
  expect(fileDirOf("/p", "想法.cards/风险.md")).toBe("/p/.canvas/想法.cards");
  expect(fileDirOf("/p", "总览.md")).toBe("/p/.canvas");
  expect(fileDirOf("/p", "::new:abc")).toBe("/p/.canvas");
});

test("目录之外的文件（同一台主机上、不在画布所在目录里）不写相对路径，写 file:主机:绝对路径；目录本身与目录前缀相近的兄弟目录要分清", () => {
  const ctx = { fileDir: "/p/.canvas", env: "local", projectDir: "/p" };
  expect(projectRefsOf(item({ path: "/other/x.md", name: "x.md" }), ctx)).toBe(
    "[x.md](file:server:/other/x.md)",
  );
  // /p2 不在 /p 里
  expect(projectRefsOf(item({ path: "/p2/x.md", name: "x.md" }), ctx)).toBe(
    "[x.md](file:server:/p2/x.md)",
  );
  expect(projectRefsOf(item({ path: "/p/x.md", name: "x.md" }), ctx)).toBe(
    "[x.md](../x.md)",
  );
  // 目录末尾带斜杠也一样
  expect(
    projectRefsOf(item({ path: "/p/x.md", name: "x.md" }), {
      ...ctx,
      projectDir: "/p/",
    }),
  ).toBe("[x.md](../x.md)");
});
