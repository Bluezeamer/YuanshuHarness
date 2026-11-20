// 对话流里卡片（后台任务回调、目标）的落点：历史接口给的是绝对序位（afterIndex），
// 本连接实时收到的只知道到达时窗口里已有几条消息（at），换算成绝对序位后合并成一份。
// 同一张卡（noticeKey 相同）两边都有时以历史的为准。

import { type NoticeAnchor, type NoticeBody, noticeKey } from "../../../api";
import type { LiveNotice } from "../model/conversation";

export type PlacedNotice = NoticeBody & {
  /** 绝对序位：卡片插在这么多条消息之后 */
  at: number;
  ts: string;
};

const sortId = (n: NoticeBody): string =>
  n.kind === "job" ? n.job.id : n.goal.goalId;

export function placeNotices(
  loaded: readonly NoticeAnchor[],
  live: readonly LiveNotice[],
  windowStart: number,
): PlacedNotice[] {
  const byKey = new Map<string, PlacedNotice>();
  for (const { at, ts, ...body } of live)
    byKey.set(noticeKey(body as NoticeBody), {
      ...(body as NoticeBody),
      at: windowStart + at,
      ts,
    });
  for (const { afterIndex, ts, ...body } of loaded)
    byKey.set(noticeKey(body as NoticeBody), {
      ...(body as NoticeBody),
      at: afterIndex,
      ts: ts ?? "",
    });
  return [...byKey.values()].sort(
    (a, b) =>
      a.at - b.at ||
      a.ts.localeCompare(b.ts) ||
      sortId(a).localeCompare(sortId(b)),
  );
}
