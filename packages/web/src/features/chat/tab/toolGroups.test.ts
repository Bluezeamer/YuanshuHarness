import { expect, test } from "vitest";
import { groupMeta, groupTools, previewOf } from "./toolGroups";
import type { ToolRow } from "./toolRows";
import { rowMeta } from "./toolRows";

const row = (name: string, over: Partial<ToolRow> = {}): ToolRow => ({
  id: `${name}-${Math.random()}`,
  name,
  status: "ok",
  ...over,
});

test("相邻同类折成一组，中间隔了别的类就另起一组", () => {
  const gs = groupTools([
    row("read"),
    row("read"),
    row("bash"),
    row("read"),
    row("grep"),
    row("find"),
  ]);
  expect(gs.map((g) => g.label)).toEqual([
    "读取了 2 个文件",
    "运行了 1 条命令",
    "读取了 1 个文件",
    "搜索了 2 次",
  ]);
});

test("edit 与 write 算一类；其他工具按名字分", () => {
  const gs = groupTools([
    row("edit"),
    row("write"),
    row("todo_write"),
    row("team_status"),
    row("team_status"),
    row("spawn_subagent"),
  ]);
  expect(gs.map((g) => g.label)).toEqual([
    "编辑了 2 个文件",
    "调用了 todo_write",
    "调用了 team_status 2 次",
    "派发了 1 个子代理",
  ]);
});

test("有失败 / 运行中的行，组上带标记；耗时只在每行都有时才合计", () => {
  const [g] = groupTools([
    row("bash", { durationMs: 100 }),
    row("bash", { status: "error", durationMs: 3300 }),
    row("bash", { status: "running" }),
  ]);
  expect(g?.failed).toBe(true);
  expect(g?.running).toBe(true);
  expect(g?.ms).toBeNull();
  const [h] = groupTools([
    row("read", { durationMs: 400 }),
    row("read", { durationMs: 800 }),
  ]);
  expect(groupMeta(h as NonNullable<typeof h>)).toBe("1.2s");
});

test("组 id 取第一行的 id，组长出新行时不变", () => {
  const a = row("read", { id: "r1" });
  const [g1] = groupTools([a]);
  const [g2] = groupTools([a, row("read", { id: "r2" })]);
  expect(g1?.id).toBe("r1");
  expect(g2?.id).toBe("r1");
});

test("行右侧：read 给行数，edit 给增删，write 给行数，其余给耗时", () => {
  expect(rowMeta(row("read", { output: "a\nb\nc" }))).toEqual({
    delta: null,
    text: "3 行",
  });
  expect(
    rowMeta(row("edit", { args: { oldText: "a", newText: "b\nc" } })),
  ).toEqual({ delta: { add: 2, del: 1 }, text: "" });
  expect(
    rowMeta(row("write", { args: JSON.stringify({ content: "x\ny" }) })).text,
  ).toBe("2 行");
  expect(rowMeta(row("bash", { durationMs: 2500 })).text).toBe("2.5s");
});

test("组头预览：第一行的命令 / 路径 / 检索词，组里还有别的补 +N，没有可看的就空", () => {
  const preview = (...rows: ToolRow[]) =>
    previewOf(groupTools(rows)[0] as never);
  expect(
    preview(row("bash", { args: { command: "ls -al | grep foo | wc -l" } })),
  ).toBe("ls -al | grep foo | wc -l");
  // 多行命令只取第一行
  expect(
    preview(row("bash", { args: { command: "set -e\nmake build" } })),
  ).toBe("set -e");
  expect(
    preview(
      row("read", { args: { path: "src/a.ts" } }),
      row("read", { args: { path: "src/b.ts" } }),
      row("read", { args: { path: "src/c.ts" } }),
    ),
  ).toBe("src/a.ts  +2");
  expect(preview(row("grep", { args: { pattern: "foo", path: "src" } }))).toBe(
    "foo in src",
  );
  expect(preview(row("bash"))).toBe("");
});
