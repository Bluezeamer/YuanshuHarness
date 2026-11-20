// 浏览器一次能接收的合计上限：agent 上传与用户页上传共用的那一份定义。
import { expect, test } from "vitest";
import { checkUploadTotal, UPLOAD_MAX_TOTAL_BYTES } from "./limits.js";

const MB = 1024 * 1024;

test("合计上限：没超就通过，写死的上限是 50 MB", () => {
  expect(UPLOAD_MAX_TOTAL_BYTES).toBe(50 * MB);
  expect(() => checkUploadTotal([])).not.toThrow();
  expect(() =>
    checkUploadTotal([{ size: 30 * MB }, { size: 19 }]),
  ).not.toThrow();
});

test("合计刚好等于上限也拒（Playwright 的界限是 >= 50 MB）", () => {
  const err = (() => {
    try {
      checkUploadTotal([{ size: 50 * MB }]);
      return null;
    } catch (e) {
      return e as Error;
    }
  })();
  expect(err?.message).toContain("50 MB");
});

test("合计超限：错误里带实际合计与上限两个数字", () => {
  const err = (() => {
    try {
      checkUploadTotal([{ size: 40 * MB }, { size: 20 * MB }]);
      return null;
    } catch (e) {
      return e as Error;
    }
  })();
  expect(err?.message).toContain("60 MB");
  expect(err?.message).toContain("50 MB");
  expect(err?.message).toContain("少传几个");
});
