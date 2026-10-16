import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("exposes its package name", () => {
  expect(packageName).toBe("yuanshu-harness-web");
});
