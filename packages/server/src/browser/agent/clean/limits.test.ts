import { describe, expect, test } from "vitest";
import { CLEAN_LIMITS } from "./limits.js";

describe("CLEAN_LIMITS", () => {
  test("阈值表齐全且都是正数（后面的模块只从这里取数字）", () => {
    expect(Object.keys(CLEAN_LIMITS).sort()).toEqual(
      [
        "captionMaxChars",
        "diffMaxChars",
        "directMaxChars",
        "gistMaxChars",
        "inlineMaxChars",
        "partsMax",
        "quoteLineChars",
        "quoteMaxLines",
        "refsPerPartMax",
        "singleCallMaxChars",
        "structureLineChars",
      ].sort(),
    );
    for (const v of Object.values(CLEAN_LIMITS)) expect(v).toBeGreaterThan(0);
  });

  test("刻度之间的顺序：直接给 < 内联 < 单次调用", () => {
    expect(CLEAN_LIMITS.directMaxChars).toBeLessThan(
      CLEAN_LIMITS.inlineMaxChars,
    );
    expect(CLEAN_LIMITS.inlineMaxChars).toBeLessThan(
      CLEAN_LIMITS.singleCallMaxChars,
    );
  });
});
