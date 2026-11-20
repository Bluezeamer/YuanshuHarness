// 环境模拟状态 → 给模型看的文字。纯函数：不碰工具与引擎，格式固定。
// 外壳是固定英文，UA 原样（过长就截断并标出剩下的字符数）。
import type { EmulationState } from "../engine/types.js";

/** UA 的显示上限。 */
const UA_MAX = 120;

export interface EmulationQuery {
  title: string;
  url: string;
}

/** 限速里的一个方向：-1 写 unlimited。 */
const rateText = (v: number): string => (v < 0 ? "unlimited" : `${v} kbps`);

/** 把当前生效的覆盖逐项写成一行里的几段；什么都没覆盖就是空数组。 */
function parts(s: EmulationState): string[] {
  const out: string[] = [];
  if (s.offline) out.push("offline");
  if (s.throttle !== null)
    out.push(
      `throttle latency ${s.throttle.latencyMs < 0 ? "unlimited" : `${s.throttle.latencyMs} ms`} / down ${rateText(s.throttle.downloadKbps)} / up ${rateText(s.throttle.uploadKbps)}`,
    );
  if (s.cpuSlowdown !== null) out.push(`cpu ×${s.cpuSlowdown}`);
  if (s.colorScheme !== null) out.push(`colorScheme=${s.colorScheme}`);
  if (s.reducedMotion !== null) out.push(`reducedMotion=${s.reducedMotion}`);
  if (s.userAgent !== null) {
    const ua =
      s.userAgent.length > UA_MAX
        ? `${s.userAgent.slice(0, UA_MAX)}…(+${s.userAgent.length - UA_MAX} chars)`
        : s.userAgent;
    out.push(`userAgent=${JSON.stringify(ua)}`);
  }
  if (s.locale !== null) out.push(`locale=${s.locale}`);
  if (s.timezone !== null) out.push(`timezone=${s.timezone}`);
  if (s.cacheDisabled) out.push("cacheDisabled");
  return out;
}

/** 两行：EMULATION 外壳 + 一行 ACTIVE。没有覆盖时写 ACTIVE: none。 */
export function renderEmulation(
  state: EmulationState,
  query: EmulationQuery,
): string {
  const active = parts(state);
  return [
    `EMULATION: ${query.title} | ${query.url}`,
    `ACTIVE: ${active.length === 0 ? "none" : active.join(", ")}`,
  ].join("\n");
}
