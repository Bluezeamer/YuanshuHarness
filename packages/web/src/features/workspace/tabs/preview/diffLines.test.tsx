// 逐行差异与冲突弹层：保存冲突时用户要靠它决定覆盖还是放弃。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ConflictDialog } from "./ConflictDialog";
import { diffLines, trimDiff } from "./diffLines";

afterEach(cleanup);

test("diffLines：标出增删与未变行，行号两边各自计数", () => {
  const out = diffLines("a\nb\nc", "a\nB\nc");
  expect(out.map((l) => l.kind)).toEqual(["same", "del", "add", "same"]);
  expect(out[1]).toMatchObject({ text: "b", a: 2, b: null });
  expect(out[2]).toMatchObject({ text: "B", a: null, b: 2 });
});

test("diffLines：纯新增与纯删除（空文件算一个空行）", () => {
  expect(diffLines("", "x").map((l) => l.kind)).toEqual(["del", "add"]);
  expect(diffLines("x", "").map((l) => l.kind)).toEqual(["del", "add"]);
});

test("trimDiff：只留改动附近的行，中间用省略行隔开", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const after = [...before];
  after[10] = "changed";
  const out = trimDiff(diffLines(before.join("\n"), after.join("\n")), 1);
  expect(out.length).toBeLessThan(8);
  expect(out.some((l) => l.text === "⋯")).toBe(true);
  expect(out.some((l) => l.text === "changed")).toBe(true);
});

test("冲突弹层：默认给差异视图，选择都在", () => {
  render(
    <ConflictDialog
      diskText={"a\nb"}
      mineText={"a\nB"}
      onOverwrite={() => {}}
      onKeepDisk={() => {}}
      onMerge={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByText("文件已被改动")).toBeTruthy();
  expect(screen.getByText(/−b/)).toBeTruthy();
  expect(screen.getByText(/\+B/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "覆盖磁盘内容" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃我的修改" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
});

// 合并模式：用 CodeMirror 的 unifiedMergeView（正文=我的内容，original=磁盘内容），
// 逐块采纳/保留；「全部采纳对方」等于整篇换成磁盘内容。
test("冲突弹层：合并模式给真实的合并视图，且能把对方内容整体采纳", async () => {
  const saved: string[] = [];
  render(
    <ConflictDialog
      path="/w/a.md"
      diskText={"第一行\n磁盘改的\n"}
      mineText={"第一行\n我改的\n"}
      onOverwrite={() => {}}
      onKeepDisk={() => {}}
      onMerge={(t) => saved.push(t)}
      onCancel={() => {}}
    />,
  );
  const mergeRadio = screen.getAllByRole("radio", { name: "合并" })[0];
  expect(mergeRadio).toBeTruthy();
  if (mergeRadio) fireEvent.click(mergeRadio);
  // 合并编辑器挂起来了：CodeMirror 在，正文是我的内容
  await waitFor(() =>
    expect(document.querySelector(".cm-editor")).toBeTruthy(),
  );
  expect(document.querySelector(".cm-content")?.textContent).toContain(
    "我改的",
  );
  // 磁盘改动以「对方」的块形式出现
  expect(
    document.querySelector(
      ".cm-changedLine, .cm-mergeChunk, .cm-deletedChunk, .cm-changedText",
    ),
  ).toBeTruthy();
  // 全部采纳对方 → 保存的是磁盘内容
  fireEvent.click(screen.getByRole("button", { name: "全部采纳对方" }));
  fireEvent.click(screen.getByRole("button", { name: "保存合并结果" }));
  expect(saved[0]).toContain("磁盘改的");
});
