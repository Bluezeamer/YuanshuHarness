// 对话流里目标卡片的文案：一次目标变化 = 一行系统回执，一次续跑 = 一行很淡的「目标 · 第 n 轮」。

import type { GoalNotice } from "../../../api";
import { reasonText, roundsText } from "../model/goal";
import { firstLine, fmtClock } from "./format";

export interface GoalCardView {
  /** 续跑线（淡的一行）还是回执（点 + 说明 + 时间 + 徽标） */
  line: "round" | "receipt";
  kind: string;
  badge: string;
  text: string;
  note?: string;
  time: string;
}

const BADGE: Record<Exclude<GoalNotice["event"], "round">, string> = {
  set: "/goal",
  edited: "/goal · 编辑",
  paused: "/goal · 暂停",
  resumed: "/goal · 恢复",
  cleared: "/goal · 删除",
  complete: "/goal · 完成",
  blocked: "/goal · 受阻",
};

const filesNote = (files: readonly string[]): string =>
  files.length ? `附件 ${files.join("、")}` : "附件已清空";

export function goalCard(n: GoalNotice, ts: string): GoalCardView {
  const time = fmtClock(ts);
  if (n.event === "round")
    return {
      line: "round",
      kind: "goal-round",
      badge: "",
      text: `目标 · 第 ${roundsText(n.round ?? 0, n.maxRounds ?? null)} 轮`,
      time,
    };
  const base = { line: "receipt" as const, kind: `goal-${n.event}`, time };
  const badge = BADGE[n.event];
  const detail = n.reason?.detail;
  switch (n.event) {
    case "set":
      return {
        ...base,
        badge,
        text: `${n.by === "model" ? "模型设了目标" : "长期目标已设定"}：${firstLine(n.text ?? "")}`,
        ...(n.files?.length ? { note: filesNote(n.files) } : {}),
      };
    case "edited": {
      const notes = [
        ...("maxRounds" in n
          ? [
              `轮数上限改为${n.maxRounds === null || n.maxRounds === undefined ? "不限" : ` ${n.maxRounds}`}`,
            ]
          : []),
        ...(n.files ? [filesNote(n.files)] : []),
      ];
      return {
        ...base,
        badge,
        text: n.by === "model" ? "模型修改了目标" : "目标已修改",
        ...(notes.length ? { note: notes.join(" · ") } : {}),
      };
    }
    case "paused":
      return {
        ...base,
        badge,
        text: n.reason ? `目标已暂停：${reasonText(n.reason)}` : "目标已暂停",
        ...(detail ? { note: detail } : {}),
      };
    case "resumed":
      return { ...base, badge, text: "目标已恢复" };
    case "cleared":
      return { ...base, badge, text: "目标已删除" };
    case "complete":
      return { ...base, badge, text: "目标已完成" };
    case "blocked":
      return {
        ...base,
        badge,
        text: n.reason ? `目标受阻：${reasonText(n.reason)}` : "目标受阻",
        ...(detail ? { note: detail } : {}),
      };
  }
}
