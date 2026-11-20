// Emulation：每项落到哪条 CDP 命令、合并与联动规则、失败时状态不说谎、校验。
// 全部用替身：不装浏览器、不起进程。

import type { Page } from "playwright-core";
import { describe, expect, test } from "vitest";
import type { PageCdp } from "./cdp.js";
import { Emulation } from "./emulate.js";

interface Sent {
  method: string;
  params?: Record<string, unknown>;
}

/** 假 PageCdp：记下发出的命令，可让某条命令抛错。 */
function fakeCdp(fail?: string | ((method: string) => string | null)) {
  const sent: Sent[] = [];
  const cdp = {
    async send(method: string, params?: Record<string, unknown>) {
      sent.push({ method, ...(params === undefined ? {} : { params }) });
      const msg = typeof fail === "function" ? fail(method) : fail;
      if (msg) throw new Error(msg);
      return {};
    },
  };
  return { cdp: cdp as unknown as PageCdp, sent };
}

/** 假 Page：只提供 emulateMedia 与 evaluate（读 UA）。 */
function fakePage(ua = "原始 UA/1.0") {
  const media: Array<Record<string, unknown>> = [];
  let uaReads = 0;
  const page = {
    async emulateMedia(opts: Record<string, unknown>) {
      media.push(opts);
    },
    async evaluate(fn: () => string) {
      uaReads++;
      void fn;
      return ua;
    },
  };
  return { page: page as unknown as Page, media, reads: () => uaReads };
}

const make = (
  ua?: string,
  fail?: string | ((method: string) => string | null),
) => {
  const { page, media, reads } = fakePage(ua);
  const { cdp, sent } = fakeCdp(fail);
  return { emu: new Emulation(page, cdp), sent, media, reads };
};

describe("Emulation", () => {
  test("初始什么都不覆盖；没给的项不动", async () => {
    const { emu, sent } = make();
    expect(emu.state()).toEqual({
      offline: false,
      throttle: null,
      cpuSlowdown: null,
      colorScheme: null,
      reducedMotion: null,
      userAgent: null,
      locale: null,
      timezone: null,
      cacheDisabled: false,
    });
    // 空 patch：一条命令都不发。
    expect(await emu.apply({})).toEqual(emu.state());
    expect(sent).toEqual([]);
  });

  test("offline 与 throttle 合并成一次（kbps 换成字节每秒，没限的写 -1）", async () => {
    const { emu, sent } = make();
    await emu.apply({
      offline: true,
      throttle: { latencyMs: 300, downloadKbps: 500, uploadKbps: 200 },
    });
    expect(sent).toEqual([
      { method: "Network.enable" },
      {
        method: "Network.emulateNetworkConditions",
        params: {
          offline: true,
          latency: 300,
          // 500 kbit/s = 64000 B/s，200 kbit/s = 25600 B/s
          downloadThroughput: 64_000,
          uploadThroughput: 25_600,
        },
      },
    ]);
    expect(emu.state()).toMatchObject({
      offline: true,
      throttle: { latencyMs: 300, downloadKbps: 500, uploadKbps: 200 },
    });

    // 只改 offline：限速那组参数原样带上。
    sent.length = 0;
    await emu.apply({ offline: false });
    expect(sent.at(-1)).toEqual({
      method: "Network.emulateNetworkConditions",
      params: {
        offline: false,
        latency: 300,
        downloadThroughput: 64_000,
        uploadThroughput: 25_600,
      },
    });

    // 只改限速：断网的当前值原样带上。
    await emu.apply({ offline: true });
    sent.length = 0;
    await emu.apply({ throttle: { latencyMs: 100 } });
    expect(sent.at(-1)).toMatchObject({
      params: { offline: true, latency: 100 },
    });
    await emu.apply({
      offline: false,
      throttle: { latencyMs: 300, downloadKbps: 500, uploadKbps: 200 },
    });

    // 撤销限速（不影响 offline）
    sent.length = 0;
    await emu.apply({ throttle: null });
    expect(sent.at(-1)).toEqual({
      method: "Network.emulateNetworkConditions",
      params: {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      },
    });
    expect(emu.state()).toMatchObject({ offline: false, throttle: null });
  });

  test("限速里没给的方向写 -1；只给 latency 时两个方向都不限", async () => {
    const { emu, sent } = make();
    await emu.apply({ throttle: { latencyMs: 400 } });
    expect(sent.at(-1)).toEqual({
      method: "Network.emulateNetworkConditions",
      params: {
        offline: false,
        latency: 400,
        downloadThroughput: -1,
        uploadThroughput: -1,
      },
    });
    expect(emu.state().throttle).toEqual({
      latencyMs: 400,
      downloadKbps: -1,
      uploadKbps: -1,
    });
  });

  test("cpuSlowdown：倍数原样，1 与 null 都是不限", async () => {
    const { emu, sent } = make();
    await emu.apply({ cpuSlowdown: 4 });
    expect(sent.at(-1)).toEqual({
      method: "Emulation.setCPUThrottlingRate",
      params: { rate: 4 },
    });
    expect(emu.state().cpuSlowdown).toBe(4);
    await emu.apply({ cpuSlowdown: 1 });
    expect(sent.at(-1)).toEqual({
      method: "Emulation.setCPUThrottlingRate",
      params: { rate: 1 },
    });
    expect(emu.state().cpuSlowdown).toBeNull();
    await emu.apply({ cpuSlowdown: 4 });
    await emu.apply({ cpuSlowdown: null });
    expect(emu.state().cpuSlowdown).toBeNull();
  });

  test("colorScheme / reducedMotion 走 emulateMedia，且两项都带当前值", async () => {
    const { emu, media } = make();
    await emu.apply({ colorScheme: "dark" });
    expect(media).toEqual([{ colorScheme: "dark", reducedMotion: null }]);
    await emu.apply({ reducedMotion: "reduce" });
    expect(media.at(-1)).toEqual({
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await emu.apply({ colorScheme: null });
    expect(media.at(-1)).toEqual({
      colorScheme: null,
      reducedMotion: "reduce",
    });
    expect(emu.state()).toMatchObject({
      colorScheme: null,
      reducedMotion: "reduce",
    });
  });

  test("UA 与 locale 联动：两项任一变了就重发 UA 覆盖，原始 UA 只读一次", async () => {
    const { emu, sent, reads } = make("原始 UA/1.0");
    await emu.apply({ userAgent: "新 UA/2.0" });
    expect(sent).toEqual([
      {
        method: "Emulation.setUserAgentOverride",
        params: { userAgent: "新 UA/2.0", acceptLanguage: "" },
      },
    ]);
    // 加 locale：UA 取之前的覆盖值，acceptLanguage 带上语言。
    sent.length = 0;
    await emu.apply({ locale: "ja-JP" });
    expect(sent).toEqual([
      {
        method: "Emulation.setUserAgentOverride",
        params: { userAgent: "新 UA/2.0", acceptLanguage: "ja-JP" },
      },
      {
        method: "Emulation.setLocaleOverride",
        params: { locale: "ja-JP" },
      },
    ]);
    // 原始 UA 只读一次（第一次覆盖前），之后一直用记下的那个。
    expect(reads()).toBe(1);

    // 撤销 UA：locale 还在，UA 发回原始值。
    sent.length = 0;
    await emu.apply({ userAgent: null });
    expect(sent[0]).toEqual({
      method: "Emulation.setUserAgentOverride",
      params: { userAgent: "原始 UA/1.0", acceptLanguage: "ja-JP" },
    });
    // 撤销 locale：不传 locale 字段就是撤销，UA 仍是原始值。
    sent.length = 0;
    await emu.apply({ locale: null });
    expect(sent).toEqual([
      {
        method: "Emulation.setUserAgentOverride",
        params: { userAgent: "原始 UA/1.0", acceptLanguage: "" },
      },
      { method: "Emulation.setLocaleOverride", params: {} },
    ]);
    expect(reads()).toBe(1);
    expect(emu.state()).toMatchObject({ userAgent: null, locale: null });
  });

  test("只给 locale 时 UA 取原始值", async () => {
    const { emu, sent, reads } = make("原始 UA/1.0");
    await emu.apply({ locale: "de-DE" });
    expect(sent).toEqual([
      {
        method: "Emulation.setUserAgentOverride",
        params: { userAgent: "原始 UA/1.0", acceptLanguage: "de-DE" },
      },
      { method: "Emulation.setLocaleOverride", params: { locale: "de-DE" } },
    ]);
    expect(reads()).toBe(1);
  });

  test("timezone 与 cacheDisabled", async () => {
    const { emu, sent } = make();
    await emu.apply({ timezone: "Asia/Tokyo" });
    expect(sent).toEqual([
      {
        method: "Emulation.setTimezoneOverride",
        params: { timezoneId: "Asia/Tokyo" },
      },
    ]);
    sent.length = 0;
    await emu.apply({ timezone: null });
    expect(sent).toEqual([
      { method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } },
    ]);
    sent.length = 0;
    await emu.apply({ cacheDisabled: true });
    expect(sent).toEqual([
      { method: "Network.enable" },
      { method: "Network.setCacheDisabled", params: { cacheDisabled: true } },
    ]);
    expect(emu.state()).toMatchObject({
      timezone: null,
      cacheDisabled: true,
    });
  });

  test("某项失败：之前成功的项保留，失败项不进状态", async () => {
    const { emu } = make(undefined, (method) =>
      method === "Emulation.setTimezoneOverride" ? "无效时区" : null,
    );
    await emu.apply({ cpuSlowdown: 2 });
    const err = (await emu
      .apply({ offline: true, timezone: "Mars/Base" })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("无效时区");
    const state = emu.state();
    expect(state.offline).toBe(true);
    expect(state.cpuSlowdown).toBe(2);
    expect(state.timezone).toBeNull();
  });

  test("state() 给的是拷贝", async () => {
    const { emu } = make();
    await emu.apply({ throttle: { latencyMs: 10 } });
    const s = emu.state();
    (s.throttle as { latencyMs: number }).latencyMs = 999;
    expect(emu.state().throttle?.latencyMs).toBe(10);
  });

  test("校验：cpuSlowdown < 1、throttle 里有负数或非有限数", async () => {
    const { emu, sent } = make();
    await expect(emu.apply({ cpuSlowdown: 0.5 })).rejects.toThrow(
      "cpuSlowdown 必须 ≥ 1",
    );
    await expect(emu.apply({ throttle: { latencyMs: -1 } })).rejects.toThrow(
      "latencyMs 必须是 ≥ 0 的有限数",
    );
    await expect(
      emu.apply({ throttle: { downloadKbps: Number.NaN } }),
    ).rejects.toThrow("downloadKbps 必须是 ≥ 0 的有限数");
    await expect(
      emu.apply({ throttle: { uploadKbps: Number.POSITIVE_INFINITY } }),
    ).rejects.toThrow("uploadKbps 必须是 ≥ 0 的有限数");
    expect(sent).toEqual([]);
  });
});
