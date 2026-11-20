import { expect, test } from "vitest";
import { defaultDeviceName } from "./deviceName";

test("Android 的 UA 取机型，去掉 Build 后缀", () => {
  expect(
    defaultDeviceName(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
    ),
  ).toBe("Pixel 8");
  expect(
    defaultDeviceName(
      "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
    ),
  ).toBe("SM-S918B");
});

test("Chrome 缩减过的 UA（机型是 K）、iOS、其他都有兜底", () => {
  expect(
    defaultDeviceName("Mozilla/5.0 (Linux; Android 10; K) Chrome/120 Mobile"),
  ).toBe("手机");
  expect(defaultDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe(
    "iPhone",
  );
  expect(defaultDeviceName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("手机");
});
