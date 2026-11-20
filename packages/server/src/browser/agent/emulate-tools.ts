// 开发调试类工具 browser_emulate：模拟页面的运行环境（弱网 / 离线、CPU 变慢、深色模式与减少动效、
// 换 UA、换语言与时区、关缓存）。什么都不给就是只读当前状态。
// 写的时候走动作骨架（租约 → 高敏感站点确认 → 做事 → 审计与回放），摘要只列项名。不带 intent、不经任何模型。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EmulationPatch } from "../engine/types.js";
import { guarded, pageIdArg, stringArg, text, UNTRUSTED } from "./args.js";
import type { BrowserToolsDeps } from "./deps.js";
import { renderEmulation } from "./emulate-view.js";
import type { Kit } from "./kit.js";

const UA_MAX = 1_000;
const LOCALE_MAX = 35;
const TIMEZONE_MAX = 64;
const COLOR_SCHEMES = ["light", "dark", "no-preference"] as const;
const REDUCED_MOTIONS = ["reduce", "no-preference"] as const;

/** 撤销全部模拟的那一份 patch：每一项都写回默认值。 */
const RESET: EmulationPatch = {
  offline: false,
  throttle: null,
  cpuSlowdown: null,
  colorScheme: null,
  reducedMotion: null,
  userAgent: null,
  locale: null,
  timezone: null,
  cacheDisabled: false,
};

/** 可选布尔参数：不传返回 undefined。 */
function boolArg(v: unknown, name: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Error(`${name} 必须是布尔值`);
  return v;
}

/** 可选数字参数：不传返回 undefined；传了必须是 ≥ min 的有限数。 */
function numberArg(
  v: unknown,
  name: string,
  min: number,
  hint: string,
): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min)
    throw new Error(`${name} 必须是 ≥ ${min} 的数：${hint}`);
  return v;
}

/** 可选枚举参数：不传返回 undefined。 */
function enumArg<T extends string>(
  v: unknown,
  name: string,
  values: readonly T[],
): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && (values as readonly string[]).includes(v))
    return v as T;
  throw new Error(`${name} 只能是 ${values.join("、")}`);
}

/** 可选字符串参数：不传返回 undefined；传了必须非空且不超过上限。 */
function limitedArg(
  v: unknown,
  name: string,
  max: number,
  hint: string,
): string | undefined {
  if (v === undefined) return undefined;
  const s = stringArg(v, name, hint);
  if (s === "") throw new Error(`${name} 不能是空串：${hint}`);
  if (s.length > max)
    throw new Error(`${name} 最长 ${max} 个字符，现在 ${s.length} 个`);
  return s;
}

/** 开发调试类工具：browser_emulate。 */
export function registerEmulateTools(
  pi: Parameters<ExtensionFactory>[0],
  kit: Kit,
): void {
  const { confirmAction, acted } = kit;
  const deps: BrowserToolsDeps = kit.deps;
  const sessionId = kit.sessionId;

  pi.registerTool({
    name: "browser_emulate",
    label: "模拟页面运行环境",
    description: `模拟这个页面的运行环境，用来测页面在弱网 / 离线、CPU 变慢、深色模式与减少动效、换了 UA、换了语言与时区、关了缓存时的表现。只改给了的项，其余不动；reset: true 先撤销全部模拟再应用同一次调用里的其它项；什么都不给就是看当前状态（不确认、不记审计）。撤销某一项：给 cpuSlowdown: 1、colorScheme: "no-preference"、reducedMotion: "no-preference"，或者直接用 reset。视口固定 1280×800，这里不能改设备尺寸：要模拟设备尺寸用 browser_cdp 发 Emulation.setDeviceMetricsOverride，但那会让截图坐标与点击坐标错位，用完要撤销。覆盖只在这个页面存活：页面关闭、或休眠之后被唤醒就没了。${UNTRUSTED}`,
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", minLength: 1 },
        offline: { type: "boolean", description: "true 断网，false 恢复" },
        latencyMs: {
          type: "number",
          description: "弱网的网络延迟（毫秒，≥ 0）；给了任一项就按这组限速",
        },
        downloadKbps: {
          type: "number",
          description: "弱网的下载带宽（kbit/s，≥ 0）；没给的方向不限",
        },
        uploadKbps: {
          type: "number",
          description: "弱网的上传带宽（kbit/s，≥ 0）；没给的方向不限",
        },
        cpuSlowdown: {
          type: "number",
          description: "CPU 变慢的倍数（≥ 1，1 等于不限）",
        },
        colorScheme: {
          type: "string",
          enum: [...COLOR_SCHEMES],
          description: "浅色 / 深色模式；no-preference 撤销",
        },
        reducedMotion: {
          type: "string",
          enum: [...REDUCED_MOTIONS],
          description: "减少动效；no-preference 撤销",
        },
        userAgent: {
          type: "string",
          maxLength: UA_MAX,
          description: "换 UA（最长 1000 字符）",
        },
        locale: {
          type: "string",
          maxLength: LOCALE_MAX,
          description:
            "语言，BCP 47 如 ja-JP（最长 35 字符）；同时影响 navigator.language 与 Accept-Language",
        },
        timezone: {
          type: "string",
          maxLength: TIMEZONE_MAX,
          description: "IANA 时区，如 Asia/Tokyo（最长 64 字符）",
        },
        cacheDisabled: {
          type: "boolean",
          description: "true 关掉浏览器 HTTP 缓存",
        },
        reset: {
          type: "boolean",
          description: "true：先撤销全部模拟，再应用同一次调用里的其它项",
        },
      },
      required: ["pageId"],
    } as never,
    async execute(_id, params) {
      const p = params as Record<string, unknown> & { pageId?: unknown };
      const pageId = pageIdArg(p.pageId);
      if (p.reset !== undefined && p.reset !== true)
        throw new Error(
          "reset 只能是 true：要撤销全部模拟就给 reset: true，不给就是不动",
        );
      const offline = boolArg(p.offline, "offline");
      const cacheDisabled = boolArg(p.cacheDisabled, "cacheDisabled");
      const latencyMs = numberArg(
        p.latencyMs,
        "latencyMs",
        0,
        "弱网的网络延迟（毫秒），不加延迟就不要给",
      );
      const downloadKbps = numberArg(
        p.downloadKbps,
        "downloadKbps",
        0,
        "弱网的下载带宽（kbit/s），不限就不要给",
      );
      const uploadKbps = numberArg(
        p.uploadKbps,
        "uploadKbps",
        0,
        "弱网的上传带宽（kbit/s），不限就不要给",
      );
      const cpuSlowdown = numberArg(
        p.cpuSlowdown,
        "cpuSlowdown",
        1,
        "CPU 变慢的倍数，如 4；不限就给 1",
      );
      const colorScheme = enumArg(p.colorScheme, "colorScheme", COLOR_SCHEMES);
      const reducedMotion = enumArg(
        p.reducedMotion,
        "reducedMotion",
        REDUCED_MOTIONS,
      );
      const userAgent = limitedArg(
        p.userAgent,
        "userAgent",
        UA_MAX,
        "要换成的 UA 字符串",
      );
      const locale = limitedArg(
        p.locale,
        "locale",
        LOCALE_MAX,
        "BCP 47 语言标签，如 ja-JP",
      );
      const timezone = limitedArg(
        p.timezone,
        "timezone",
        TIMEZONE_MAX,
        "IANA 时区，如 Asia/Tokyo",
      );

      const throttle =
        latencyMs === undefined &&
        downloadKbps === undefined &&
        uploadKbps === undefined
          ? undefined
          : {
              ...(latencyMs === undefined ? {} : { latencyMs }),
              ...(downloadKbps === undefined ? {} : { downloadKbps }),
              ...(uploadKbps === undefined ? {} : { uploadKbps }),
            };
      const patch: EmulationPatch = {
        ...(offline === undefined ? {} : { offline }),
        ...(throttle === undefined ? {} : { throttle }),
        ...(cpuSlowdown === undefined ? {} : { cpuSlowdown }),
        ...(colorScheme === undefined ? {} : { colorScheme }),
        ...(reducedMotion === undefined ? {} : { reducedMotion }),
        ...(userAgent === undefined ? {} : { userAgent }),
        ...(locale === undefined ? {} : { locale }),
        ...(timezone === undefined ? {} : { timezone }),
        ...(cacheDisabled === undefined ? {} : { cacheDisabled }),
      };
      const reset = p.reset === true;
      const names = [
        ...(reset ? ["reset"] : []),
        ...(offline === undefined ? [] : ["offline"]),
        ...(throttle === undefined ? [] : ["throttle"]),
        ...(cpuSlowdown === undefined ? [] : ["cpuSlowdown"]),
        ...(colorScheme === undefined ? [] : ["colorScheme"]),
        ...(reducedMotion === undefined ? [] : ["reducedMotion"]),
        ...(userAgent === undefined ? [] : ["userAgent"]),
        ...(locale === undefined ? [] : ["locale"]),
        ...(timezone === undefined ? [] : ["timezone"]),
        ...(cacheDisabled === undefined ? [] : ["cacheDisabled"]),
      ];

      return guarded(async () => {
        // 什么都没给：只读当前状态，不确认、不记审计与回放。
        if (names.length === 0) {
          const handle = await deps.registry.use(pageId, sessionId, "observe");
          return text(
            renderEmulation(handle.emulation(), {
              title: (await handle.title()) || "（无标题）",
              url: handle.url(),
            }),
          );
        }
        const handle = await deps.registry.use(pageId, sessionId, "act");
        // 摘要只列项名：UA、语言这些值可能带个人信息。
        const summary = `环境模拟：${names.join("、")}`;
        await confirmAction(handle, "browser_emulate", summary);
        // reset 与新增项合成一次 patch：一次落地，状态不会中途两样。
        const state = await handle.emulate(
          reset ? { ...RESET, ...patch } : patch,
        );
        await acted("browser_emulate", pageId, summary);
        return text(
          renderEmulation(state, {
            title: (await handle.title()) || "（无标题）",
            url: handle.url(),
          }),
        );
      });
    },
  });
}
