// 回放的纯逻辑：默认看哪个会话、步的序号换算、给人看的时间与名字。不依赖 React。
import type { ReplaySession } from "../../../../api/browser";

/** 默认看哪个会话：当前锚点会话有回放就看它，否则看最近有动作的（列表第一个）。 */
export function pickSession(
  sessions: readonly ReplaySession[],
  anchor: string | null,
): string | null {
  if (anchor !== null && sessions.some((s) => s.sessionId === anchor))
    return anchor;
  return sessions[0]?.sessionId ?? null;
}

/** 会话在下拉里的名字：标题，没有标题用编号前 8 位。 */
export const sessionName = (
  id: string,
  titles: ReadonlyMap<string, string>,
): string => titles.get(id) ?? id.slice(0, 8);

/** 步的时刻：本地时区 HH:mm:ss；解析失败给空串。 */
export function stepClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 刷新步列表后看哪一步：原来在最后一步就跟到新的最后一步（正在追进度），否则按步 id 找回原来那步，找不到停在最后。 */
export function indexAfterReload(
  prev: { ids: readonly number[]; index: number } | null,
  nextIds: readonly number[],
): number {
  const last = nextIds.length - 1;
  if (
    prev === null ||
    prev.ids.length === 0 ||
    prev.index >= prev.ids.length - 1
  )
    return last;
  const kept = nextIds.indexOf(prev.ids[prev.index] as number);
  return kept >= 0 ? kept : last;
}

/** 自动播放的下一步：到头了返回 null。 */
export const nextIndex = (index: number, count: number): number | null =>
  index + 1 < count ? index + 1 : null;
