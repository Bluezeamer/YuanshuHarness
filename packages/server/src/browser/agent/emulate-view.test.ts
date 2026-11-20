// renderEmulation：外壳、ACTIVE 的逐项写法、none、throttle 的 unlimited、UA 截断。
import { describe, expect, test } from "vitest";
import type { EmulationState } from "../engine/types.js";
import { renderEmulation } from "./emulate-view.js";

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

const query = { title: "示例页", url: "https://example.com/a" };

describe("renderEmulation", () => {
  test("没有覆盖时写 ACTIVE: none", () => {
    expect(renderEmulation(EMPTY, query)).toBe(
      ["EMULATION: 示例页 | https://example.com/a", "ACTIVE: none"].join("\n"),
    );
  });

  test("每一项的写法与顺序固定，throttle 里 -1 写 unlimited", () => {
    expect(
      renderEmulation(
        {
          offline: true,
          throttle: { latencyMs: 300, downloadKbps: 500, uploadKbps: -1 },
          cpuSlowdown: 4,
          colorScheme: "dark",
          reducedMotion: "reduce",
          userAgent: 'Mozilla/5.0 "x"',
          locale: "ja-JP",
          timezone: "Asia/Tokyo",
          cacheDisabled: true,
        },
        query,
      ),
    ).toBe(
      [
        "EMULATION: 示例页 | https://example.com/a",
        'ACTIVE: offline, throttle latency 300 ms / down 500 kbps / up unlimited, cpu ×4, colorScheme=dark, reducedMotion=reduce, userAgent="Mozilla/5.0 \\"x\\"", locale=ja-JP, timezone=Asia/Tokyo, cacheDisabled',
      ].join("\n"),
    );
  });

  test("throttle 里没限的延迟写 unlimited", () => {
    expect(
      renderEmulation(
        {
          ...EMPTY,
          throttle: { latencyMs: -1, downloadKbps: -1, uploadKbps: 100 },
        },
        query,
      ).split("\n")[1],
    ).toBe("ACTIVE: throttle latency unlimited / down unlimited / up 100 kbps");
  });

  test("UA 超过 120 字符截断并写剩下的字符数", () => {
    const ua = "A".repeat(150);
    const line = renderEmulation({ ...EMPTY, userAgent: ua }, query).split(
      "\n",
    )[1];
    expect(line).toBe(`ACTIVE: userAgent="${"A".repeat(120)}…(+30 chars)"`);
  });
});
