import { expect, test } from "vitest";
import { parseInput } from "./commands";

const GOAL_HINT = "在 /goal 后写目标，或 pause / resume / clear / edit <目标>";

test.each([
  ["/goal 把测试补齐", { kind: "goal", text: "把测试补齐" }],
  ["  /goal   首尾有空白  ", { kind: "goal", text: "首尾有空白" }],
  ["/goal 第一行\n第二行", { kind: "goal", text: "第一行\n第二行" }],
  ["/GOAL 大小写不敏感", { kind: "goal", text: "大小写不敏感" }],
  ["/goal", { kind: "error", message: GOAL_HINT }],
  ["/goal   ", { kind: "error", message: GOAL_HINT }],
  // pause / resume / clear 独占整行才是控制词；edit 后面跟新的目标
  ["/goal pause", { kind: "goal-control", action: "pause" }],
  ["/goal  Resume ", { kind: "goal-control", action: "resume" }],
  ["/goal clear", { kind: "goal-control", action: "clear" }],
  ["/goal pause 到下午", { kind: "goal", text: "pause 到下午" }],
  ["/goal clear the cache", { kind: "goal", text: "clear the cache" }],
  ["/goal edit 改成补测试", { kind: "goal-edit", text: "改成补测试" }],
  ["/goal edit", { kind: "error", message: "在 /goal edit 后写新的目标" }],
  ["/compact", { kind: "compact" }],
  ["  /compact  ", { kind: "compact" }],
  ["/compact 保留重点", { kind: "error", message: "/compact 不接受参数" }],
  // 其余 /xxx 都是普通消息，原文发给模型
  ["/plan 重构登录", { kind: "message", text: "/plan 重构登录" }],
  ["/review", { kind: "message", text: "/review" }],
  ["/my-skill 参数", { kind: "message", text: "/my-skill 参数" }],
  ["/etc/hosts 是什么", { kind: "message", text: "/etc/hosts 是什么" }],
  // 前缀相同但不是同一个命令
  ["/goals 复数", { kind: "message", text: "/goals 复数" }],
  ["/compaction", { kind: "message", text: "/compaction" }],
  ["/", { kind: "message", text: "/" }],
  // 普通文本与首尾空白
  ["  你好  ", { kind: "message", text: "你好" }],
  ["问：/goal 是什么", { kind: "message", text: "问：/goal 是什么" }],
  ["", { kind: "message", text: "" }],
])("parseInput(%j)", (input, want) => {
  expect(parseInput(input)).toEqual(want);
});
