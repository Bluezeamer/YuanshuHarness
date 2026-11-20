import { expect, test } from "vitest";
import type { VersionEntry } from "../../../../api/canvas";
import {
  boardChanges,
  isUnchanged,
  nodeLabel,
  sourceLabel,
  summaryOf,
} from "./versions";

const entry = (
  source: VersionEntry["source"],
  summary: string,
): VersionEntry => ({ sha: "abc1234", ts: 1, source, summary });

test("来源：你 / agent / 恢复 / 撤销 / 外部改动", () => {
  expect(
    (["user", "agent", "restore", "undo", "external"] as const).map((s) =>
      sourceLabel(entry(s, "")),
    ),
  ).toEqual(["你", "agent", "恢复", "撤销", "外部改动"]);
});

test("摘要：服务端的英文动词换成中文、路径去掉 .canvas / .md、「and N more」换成「等 N+1 项」", () => {
  expect(summaryOf(entry("user", "save 想法.canvas"))).toBe("保存 想法");
  expect(summaryOf(entry("user", "create 产品/访谈.md"))).toBe(
    "新建 产品/访谈",
  );
  expect(summaryOf(entry("user", "save a.canvas and 2 more"))).toBe(
    "保存 a 等 3 项",
  );
  expect(summaryOf(entry("user", "move 产品/"))).toBe("挪动 产品/");
  expect(summaryOf(entry("restore", "restore 想法.canvas"))).toBe("恢复 想法");
  // 认不出的动词、没有摘要的情况照原样 / 给兜底
  expect(summaryOf(entry("user", "whatever x"))).toBe("whatever x");
  expect(summaryOf(entry("user", ""))).toBe("");
  expect(summaryOf(entry("external", ""))).toBe("文件在界面之外被改动");
});

test("agent 的摘要是它自己写的一句话，原样给；撤销带上被撤销那次的摘要", () => {
  expect(summaryOf(entry("agent", "create_card 风险 (+1)"))).toBe(
    "create_card 风险 (+1)",
  );
  expect(summaryOf(entry("agent", ""))).toBe("agent 改了画布");
  expect(summaryOf(entry("undo", "create_card 风险"))).toBe(
    "撤销了：create_card 风险",
  );
  expect(summaryOf(entry("undo", ""))).toBe("撤销了 agent 的上一次修改");
});

test("节点的名字：文件取文件名（无后缀）、文字取第一行、链接取地址、分组取标题", () => {
  expect(nodeLabel({ file: "想法.cards/风险.md" })).toBe("风险");
  expect(nodeLabel({ type: "text", text: "\n  第一行\n第二行" })).toBe(
    "第一行",
  );
  expect(nodeLabel({ type: "link", url: "https://x.dev" })).toBe(
    "https://x.dev",
  );
  expect(nodeLabel({ type: "group", label: "一组" })).toBe("一组");
  expect(nodeLabel({})).toBe("（未命名）");
});

const doc = (nodes: object[], edges: object[] = []) =>
  JSON.stringify({ nodes, edges });
const n = (id: string, file: string, x = 0, y = 0) => ({
  id,
  type: "file",
  file,
  x,
  y,
  width: 100,
  height: 50,
});

test("画布两个版本的差别：回来的、消失的、位置变了的、连线", () => {
  const current = doc(
    [
      n("a", "x.cards/甲.md"),
      n("b", "x.cards/乙.md", 10, 10),
      n("c", "x.cards/丙.md"),
    ],
    [{ id: "e1" }, { id: "e2" }],
  );
  const older = doc(
    [
      n("a", "x.cards/甲.md", 5, 5),
      n("b", "x.cards/乙.md", 10, 10),
      n("d", "x.cards/丁.md"),
    ],
    [{ id: "e1" }, { id: "e3" }],
  );
  expect(boardChanges(current, older)).toEqual({
    back: ["丁"],
    gone: ["丙"],
    moved: 1,
    edgesBack: 1,
    edgesGone: 1,
  });
  expect(isUnchanged(boardChanges(current, current) as never)).toBe(true);
});

test("文档解析不了：返回 null，不抛错", () => {
  expect(boardChanges("{oops", "{}")).toBeNull();
  expect(boardChanges("{}", "null")).toBeNull();
  expect(boardChanges("{}", "{}")).toEqual({
    back: [],
    gone: [],
    moved: 0,
    edgesBack: 0,
    edgesGone: 0,
  });
});
