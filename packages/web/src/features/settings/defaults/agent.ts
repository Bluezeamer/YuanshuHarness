import type {
  AgentSettingsDefaults,
  AgentSettingsPatch,
} from "../../../api/agentSettings";
import type { DefaultsForm } from "./model";

export type Preset = "default" | "lean" | "detail";

export const PRESET_LABEL: Record<Preset, string> = {
  default: "pi 默认",
  lean: "节省上下文",
  detail: "保留更多细节",
};

export const PRESET_HINT: Record<Preset, string> = {
  default: "不覆盖，跟随 pi 自己的配置",
  lean: "更早压缩，只原样保留最近一小段，上下文小、请求更省",
  detail: "更晚压缩，原样保留更多近期内容，适合需要前后文细节的长任务",
};

// 两个数互相牵连（触发线 = 窗口 − 预留余量；压完要留得下「摘要 + 保留的原文」），所以只给成档；
// 按 128K 以上的窗口设计，更小的窗口请用 pi 默认或自己调数字。
const PRESETS = {
  lean: { reserve: 32768, keep: 10000 },
  detail: { reserve: 12288, keep: 40000 },
} as const;

export function presetFields(
  p: Preset,
  base: AgentSettingsDefaults,
): Pick<DefaultsForm, "compactReserve" | "compactKeep"> {
  const v =
    p === "default"
      ? {
          reserve: base.compaction.reserveTokens,
          keep: base.compaction.keepRecentTokens,
        }
      : PRESETS[p];
  return { compactReserve: String(v.reserve), compactKeep: String(v.keep) };
}

/** 两个数正好是哪一档；都不是 = null（自定义）。 */
export function presetOf(
  f: DefaultsForm,
  base: AgentSettingsDefaults,
): Preset | null {
  const same = (p: Preset) => {
    const x = presetFields(p, base);
    return (
      x.compactReserve === f.compactReserve.trim() &&
      x.compactKeep === f.compactKeep.trim()
    );
  };
  return (["default", "lean", "detail"] as const).find(same) ?? null;
}

// 与已保存值相同 = 不动（undefined）；改回 pi 的值 = 删掉这一项（null）；否则写新值。
const change = <T>(now: T, was: T, def: T): T | null | undefined =>
  now === was ? undefined : now === def ? null : now;

const touched = (o: object) => Object.values(o).some((v) => v !== undefined);

/** 压缩与重试要发给 /agent-settings 的补丁，没有改动返回空对象。调用前要先过 errorsOf。 */
export function agentPatchOf(
  d: DefaultsForm,
  s: DefaultsForm,
  base: AgentSettingsDefaults,
): AgentSettingsPatch {
  const compaction = {
    enabled: change(d.compactOn, s.compactOn, base.compaction.enabled),
    reserveTokens: change(
      Number(d.compactReserve),
      Number(s.compactReserve),
      base.compaction.reserveTokens,
    ),
    keepRecentTokens: change(
      Number(d.compactKeep),
      Number(s.compactKeep),
      base.compaction.keepRecentTokens,
    ),
  };
  const retry = {
    enabled: change(d.retryOn, s.retryOn, base.retry.enabled),
    maxRetries: change(
      Number(d.retryMax),
      Number(s.retryMax),
      base.retry.maxRetries,
    ),
  };
  return {
    ...(touched(compaction) ? { compaction } : {}),
    ...(touched(retry) ? { retry } : {}),
  };
}
