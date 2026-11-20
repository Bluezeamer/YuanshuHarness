// 目标给模型看的文字：附件标记行在 <goal> 块里、get_goal 结果列出附件行。
import { describe, expect, test } from "vitest";
import { createGoal } from "./goal.js";
import { goalText, roundMessage } from "./goal-messages.js";

const NOW = "2026-01-01T00:00:00.000Z";
const files = [
  {
    name: "a.png",
    mime: "image/png",
    sizeText: "1 B",
    path: "./2026-11-20/aaaaaaa1-a.png",
  },
];

describe("roundMessage", () => {
  test("没有附件时输出与不带附件的目标逐字相同", () => {
    const g = createGoal("目标", "user", 50, "g1", NOW);
    expect(roundMessage(g, 1)).toBe(
      roundMessage(createGoal("目标", "user", 50, "g1", NOW, []), 1),
    );
    expect(roundMessage(g, 1)).not.toContain("[attach_file]");
  });

  test("有附件时标记行在 <goal> 块里目标文本之后", () => {
    const g = createGoal("目标", "user", 50, "g1", NOW, files);
    const text = roundMessage(g, 2);
    expect(text).toContain(
      "<goal>\n目标\n\n[attach_file] attachment:/2026-11-20/aaaaaaa1-a.png (image/png, 1 B)\n</goal>",
    );
    // 标记行仍在 <goal> 里，不跑到框架文字后面
    expect(text.indexOf("[attach_file]")).toBeLessThan(text.indexOf("</goal>"));
  });
});

describe("goalText", () => {
  test("有附件时多几行 attachment: <name> (<path>)", () => {
    const g = createGoal("目标", "user", 50, "g1", NOW, files);
    expect(goalText(g)).toContain(
      "attachment: a.png (./2026-11-20/aaaaaaa1-a.png)",
    );
  });

  test("没有附件时没有 attachment 行", () => {
    expect(goalText(createGoal("目标", "user", 50, "g1", NOW))).not.toContain(
      "attachment:",
    );
  });
});
