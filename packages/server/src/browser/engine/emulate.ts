// 环境模拟（browser_emulate 的下层）：持有当前覆盖，改一项落地一条 CDP 命令。
// 覆盖跟着 PageCdp 的会话走：会话一断就失效，所以会话由 PageCdp 长存（页面关闭才丢）。
import type { Page } from "playwright-core";
import type { PageCdp } from "./cdp.js";
import type { EmulationPatch, EmulationState } from "./types.js";

/** 初始状态：什么都没覆盖。 */
const EMPTY: EmulationState = {
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

const copy = (s: EmulationState): EmulationState => ({
  ...s,
  throttle: s.throttle === null ? null : { ...s.throttle },
});

/** kbit/s 换成字节每秒；没限（-1）原样。 */
const bytesPerSecond = (kbps: number): number =>
  kbps < 0 ? -1 : (kbps * 1024) / 8;

/** 限速参数里的一项：没给写 -1（不限）。 */
function rate(v: number | undefined, name: string): number {
  if (v === undefined) return -1;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error(`${name} 必须是 ≥ 0 的有限数（毫秒或 kbit/s）`);
  return v;
}

/** apply 前的校验：值不对就抛中文错误，一条命令都不发。 */
function validate(patch: EmulationPatch): void {
  if (patch.throttle !== undefined && patch.throttle !== null) {
    rate(patch.throttle.latencyMs, "latencyMs");
    rate(patch.throttle.downloadKbps, "downloadKbps");
    rate(patch.throttle.uploadKbps, "uploadKbps");
  }
  if (
    patch.cpuSlowdown !== undefined &&
    patch.cpuSlowdown !== null &&
    !(typeof patch.cpuSlowdown === "number" && patch.cpuSlowdown >= 1)
  )
    throw new Error("cpuSlowdown 必须 ≥ 1");
}

export class Emulation {
  private current: EmulationState = { ...EMPTY };
  /** 第一次覆盖 UA 之前读到的原始 UA：撤销时发回它。 */
  private originalUa: string | null = null;

  constructor(
    private readonly page: Page,
    private readonly cdp: PageCdp,
  ) {}

  /** 当前状态（拷贝）。 */
  state(): EmulationState {
    return copy(this.current);
  }

  /** 按 patch 改：只动给了的项；某项失败时之前成功的项保留，失败项不记入状态。 */
  async apply(patch: EmulationPatch): Promise<EmulationState> {
    validate(patch);
    const next = copy(this.current);
    // 逐项落地、逐项记状态：后面某项失败时，前面成功的项已经写进状态。
    this.current = next;

    if (patch.offline !== undefined || patch.throttle !== undefined) {
      const offline = patch.offline ?? next.offline;
      const throttle =
        patch.throttle === undefined
          ? next.throttle
          : patch.throttle === null
            ? null
            : {
                latencyMs: rate(patch.throttle.latencyMs, "latencyMs"),
                downloadKbps: rate(patch.throttle.downloadKbps, "downloadKbps"),
                uploadKbps: rate(patch.throttle.uploadKbps, "uploadKbps"),
              };
      await this.cdp.send("Network.enable");
      // 离线与限速是同一条命令：两项任一变了都要带上另一项的当前值。
      await this.cdp.send("Network.emulateNetworkConditions", {
        offline,
        latency: throttle === null ? 0 : Math.max(0, throttle.latencyMs),
        downloadThroughput:
          throttle === null ? -1 : bytesPerSecond(throttle.downloadKbps),
        uploadThroughput:
          throttle === null ? -1 : bytesPerSecond(throttle.uploadKbps),
      });
      next.offline = offline;
      next.throttle = throttle;
    }

    if (patch.cpuSlowdown !== undefined) {
      const value = patch.cpuSlowdown ?? 1;
      const applied = value === 1 ? null : value;
      await this.cdp.send("Emulation.setCPUThrottlingRate", {
        rate: applied ?? 1,
      });
      next.cpuSlowdown = applied;
    }

    if (patch.colorScheme !== undefined || patch.reducedMotion !== undefined) {
      const colorScheme =
        (patch.colorScheme === undefined
          ? next.colorScheme
          : patch.colorScheme) ?? null;
      const reducedMotion =
        (patch.reducedMotion === undefined
          ? next.reducedMotion
          : patch.reducedMotion) ?? null;
      // emulateMedia 没给的项会被重置成默认，所以两项都带上当前值。
      await this.page.emulateMedia({ colorScheme, reducedMotion });
      next.colorScheme = colorScheme;
      next.reducedMotion = reducedMotion;
    }

    const uaTouched = patch.userAgent !== undefined;
    const localeTouched = patch.locale !== undefined;
    if (uaTouched || localeTouched) {
      // 原始 UA 要在第一次覆盖之前读：之后再读到的就是覆盖后的值了。
      const original = await this.readOriginalUa();
      const userAgent = (uaTouched ? patch.userAgent : next.userAgent) ?? null;
      const locale = (localeTouched ? patch.locale : next.locale) ?? null;
      // setUserAgentOverride 必须带 UA：两项都没覆盖时发回原始 UA。
      await this.cdp.send("Emulation.setUserAgentOverride", {
        userAgent: userAgent ?? original,
        acceptLanguage: locale ?? "",
      });
      next.userAgent = userAgent;
      if (localeTouched) {
        // navigator.language 靠这一条；null 时不传 locale 字段就是撤销。
        await this.cdp.send(
          "Emulation.setLocaleOverride",
          locale === null ? {} : { locale },
        );
        next.locale = locale;
      }
    }

    if (patch.timezone !== undefined) {
      await this.cdp.send("Emulation.setTimezoneOverride", {
        timezoneId: patch.timezone ?? "",
      });
      next.timezone = patch.timezone ?? null;
    }

    if (patch.cacheDisabled !== undefined) {
      await this.cdp.send("Network.enable");
      await this.cdp.send("Network.setCacheDisabled", {
        cacheDisabled: patch.cacheDisabled,
      });
      next.cacheDisabled = patch.cacheDisabled;
    }

    this.current = next;
    return copy(next);
  }

  /** 原始 UA 只读一次；页面里的读取失败不缓存（下次再试）。 */
  private async readOriginalUa(): Promise<string> {
    if (this.originalUa === null)
      this.originalUa = await this.page.evaluate(() => navigator.userAgent);
    return this.originalUa;
  }
}
