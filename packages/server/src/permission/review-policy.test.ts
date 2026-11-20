import { describe, expect, test } from "vitest";
import {
  buildSystemPrompt,
  DEFAULT_CRITERIA,
  isReviewPolicyMode,
  PROTOCOL_HEAD,
  PROTOCOL_TAIL,
  resolveCriteria,
} from "./review-policy.js";

describe("buildSystemPrompt", () => {
  test("固定头在前、判别准则居中、固定尾在后，各出现一次", () => {
    const got = buildSystemPrompt("我的准则");
    expect(got.indexOf(PROTOCOL_HEAD)).toBe(0);
    expect(got.indexOf("我的准则")).toBeGreaterThan(got.indexOf(PROTOCOL_HEAD));
    expect(got.indexOf(PROTOCOL_TAIL)).toBeGreaterThan(got.indexOf("我的准则"));
    for (const part of [PROTOCOL_HEAD, "我的准则", PROTOCOL_TAIL])
      expect(got.split(part)).toHaveLength(2);
  });
});

describe("resolveCriteria", () => {
  test("全局没自定义时用默认准则", () => {
    expect(resolveCriteria(null, null)).toBe(DEFAULT_CRITERIA);
  });

  test("全局自定义优先于默认", () => {
    expect(resolveCriteria("只许改 docs", null)).toBe("只许改 docs");
  });

  test("工作区追加：保留全局并加上标题行", () => {
    expect(
      resolveCriteria("只许改 docs", { mode: "append", text: "不要联网" }),
    ).toBe("只许改 docs\n\n本工作区的附加要求：\n不要联网");
    expect(resolveCriteria(null, { mode: "append", text: "不要联网" })).toBe(
      `${DEFAULT_CRITERIA}\n\n本工作区的附加要求：\n不要联网`,
    );
  });

  test("工作区覆盖：全局与默认都不在", () => {
    expect(
      resolveCriteria("只许改 docs", { mode: "override", text: "一律拒绝" }),
    ).toBe("一律拒绝");
    expect(resolveCriteria(null, { mode: "override", text: "一律拒绝" })).toBe(
      "一律拒绝",
    );
  });

  test("工作区文字为空时 override 与 append 都跟随全局", () => {
    for (const mode of ["append", "override"] as const) {
      expect(resolveCriteria("只许改 docs", { mode, text: "" })).toBe(
        "只许改 docs",
      );
      expect(resolveCriteria(null, { mode, text: "" })).toBe(DEFAULT_CRITERIA);
    }
  });
});

describe("isReviewPolicyMode", () => {
  test("只认 append 与 override", () => {
    expect(isReviewPolicyMode("append")).toBe(true);
    expect(isReviewPolicyMode("override")).toBe(true);
    for (const bad of ["prepend", "APPEND", "", null, undefined, 1, {}])
      expect(isReviewPolicyMode(bad), String(bad)).toBe(false);
  });
});
