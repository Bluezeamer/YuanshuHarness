import { expect, test } from "vitest";
import type { GoalNotice } from "../../../api";
import { goalCard } from "./goalNotice";

const notice = (over: Partial<GoalNotice>): GoalNotice => ({
  event: "set",
  goalId: "g1",
  revision: 1,
  by: "user",
  text: "按规格书实现",
  ...over,
});

test("设目标：带附件时卡片注明文件名；没有附件不出备注", () => {
  const withFiles = goalCard(notice({ files: ["spec.pdf", "a.png"] }), "");
  expect(withFiles.note).toBe("附件 spec.pdf、a.png");
  expect(goalCard(notice({}), "").note).toBeUndefined();
});

test("改目标：附件被改才有备注，空数组写「附件已清空」，与轮数上限的备注并列", () => {
  const edited = (over: Partial<GoalNotice>) =>
    goalCard(notice({ event: "edited", revision: 2, ...over }), "").note;
  expect(edited({})).toBeUndefined();
  expect(edited({ files: [] })).toBe("附件已清空");
  expect(edited({ files: ["b.txt"], maxRounds: 20 })).toBe(
    "轮数上限改为 20 · 附件 b.txt",
  );
});
