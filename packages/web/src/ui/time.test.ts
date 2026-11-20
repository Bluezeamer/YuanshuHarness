import { describe, expect, it } from "vitest";
import { fmtDateTime } from "./time";

describe("fmtDateTime", () => {
  it("本地时区，补零到分钟", () => {
    expect(fmtDateTime(new Date(2026, 0, 5, 3, 7, 59))).toBe(
      "2026-01-05 03:07",
    );
    expect(fmtDateTime(new Date(2026, 10, 12, 18, 30).toISOString())).toBe(
      "2026-11-12 18:30",
    );
  });

  it("缺失或解析失败是空串", () => {
    for (const v of [undefined, null, "", "不是日期"])
      expect(fmtDateTime(v)).toBe("");
  });
});
