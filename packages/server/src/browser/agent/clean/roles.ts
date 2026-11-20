// 按角色分的几个集合，机械层、元素级 diff、展开投影共用。

/** 能带编号被点 / 被打字的角色。 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
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
]);

/** 带「当前值」的表单控件：行尾文字是它的值，不是标签。 */
export const FIELD_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "slider",
  "spinbutton",
]);
