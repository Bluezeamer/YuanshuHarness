import { expect, test } from "vitest";
import type { Policy, ToolPolicy, ToolRow } from "../../../../api/toolRules";
import {
  bulkSet,
  changed,
  isModified,
  type Rules,
  rulesOf,
  sectionsOf,
} from "./model";

const both = (p: Policy): ToolPolicy => ({ inside: p, outside: p });
const row = (
  name: string,
  group: ToolRow["group"]["key"],
  factory: ToolPolicy | null,
  rule: ToolPolicy | null = factory,
): ToolRow => ({
  name,
  description: "",
  readOnly: false,
  server: false,
  group: { key: group, name: group },
  kind: factory ? "flat" : "fixed",
  framework: false,
  note: null,
  factory,
  rule,
  modified: false,
});

const tools = [
  row("a", "files", { inside: "allow", outside: "ask" }),
  row("b", "dirs", both("ask")),
  row("c", "files", both("allow")),
  row("fixed", "dirs", null),
];

test("分组按服务端给的顺序，同组相邻；固定规则的工具不进规则表", () => {
  expect(
    sectionsOf(tools).map((s) => [s.key, s.tools.map((t) => t.name)]),
  ).toEqual([
    ["files", ["a", "c"]],
    ["dirs", ["b", "fixed"]],
  ]);
  expect(Object.keys(rulesOf(tools))).toEqual(["a", "b", "c"]);
});

test("批量：全部放行 / 审批两格一起变，固定规则的不动；恢复出厂回到出厂值", () => {
  const saved = rulesOf(tools);
  expect(bulkSet(saved, tools, "allow")).toEqual({
    a: both("allow"),
    b: both("allow"),
    c: both("allow"),
  });
  const edited = bulkSet(saved, tools, "ask");
  expect(edited.a).toEqual(both("ask"));
  expect(bulkSet(edited, tools, "factory")).toEqual(saved);
});

test("只发与已保存值不同的项；与出厂值不同才算已修改", () => {
  const saved = rulesOf(tools);
  const draft: Rules = { ...saved, a: both("allow") };
  expect(changed(draft, saved)).toEqual({ a: both("allow") });
  expect(isModified(tools[0] as ToolRow, draft)).toBe(true);
  expect(isModified(tools[1] as ToolRow, draft)).toBe(false);
});
