import { expect, test } from "vitest";
import {
  addressProblem,
  fmtRemaining,
  normalizeBase,
  pairingUrl,
  remainingMs,
} from "./model";

test("地址整理：去空白与末尾斜杠，没写协议补 http://", () => {
  expect(normalizeBase("  192.168.1.20:7431/ ")).toBe(
    "http://192.168.1.20:7431",
  );
  expect(normalizeBase("https://h.example.com///")).toBe(
    "https://h.example.com",
  );
  expect(normalizeBase("")).toBe("");
});

test("配对链接：地址 + /m/?pair=码，码里的特殊字符会转义", () => {
  expect(pairingUrl("http://10.0.0.5:7431/", "AB23CDEF")).toBe(
    "http://10.0.0.5:7431/m/?pair=AB23CDEF",
  );
  expect(pairingUrl("10.0.0.5", "a b")).toBe("http://10.0.0.5/m/?pair=a%20b");
});

test("手机打不开的地址：本机地址与不成样子的地址", () => {
  for (const local of [
    "http://localhost:7431",
    "http://127.0.0.1:7431",
    "127.0.0.1",
    "http://[::1]:7431",
  ])
    expect(addressProblem(local), local).toBe("local");
  expect(addressProblem("")).toBe("invalid");
  expect(addressProblem("http://")).toBe("invalid");
  expect(addressProblem("192.168.1.20:7431")).toBeNull();
  expect(addressProblem("https://harness.example.com")).toBeNull();
});

test("配对码剩余时间：到点归零不为负；格式是「分 秒」", () => {
  const at = "2026-11-19T10:05:00.000Z";
  const t0 = new Date("2026-11-19T10:00:00.000Z").getTime();
  expect(remainingMs(at, t0)).toBe(300_000);
  expect(remainingMs(at, t0 + 400_000)).toBe(0);
  expect(fmtRemaining(300_000)).toBe("5 分 00 秒");
  expect(fmtRemaining(65_400)).toBe("1 分 06 秒");
  expect(fmtRemaining(0)).toBe("0 分 00 秒");
});
