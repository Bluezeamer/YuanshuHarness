import { describe, expect, test } from "vitest";
import { FIELD_ROLES, INTERACTIVE_ROLES } from "./roles.js";

describe("roles", () => {
  test("可交互角色与元素级 diff 原型的 INTER 一致", () => {
    const inter = [
      "link",
      "button",
      "textbox",
      "searchbox",
      "combobox",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "option",
      "slider",
      "spinbutton",
      "menuitemcheckbox",
      "menuitemradio",
      "treeitem",
    ];
    expect([...INTERACTIVE_ROLES].sort()).toEqual(inter.sort());
  });

  test("带当前值的表单控件是可交互角色的子集", () => {
    expect([...FIELD_ROLES]).toEqual([
      "textbox",
      "searchbox",
      "combobox",
      "slider",
      "spinbutton",
    ]);
    for (const role of FIELD_ROLES)
      expect(INTERACTIVE_ROLES.has(role)).toBe(true);
    expect(FIELD_ROLES.has("checkbox")).toBe(false);
  });
});
