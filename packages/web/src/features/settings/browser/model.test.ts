import { expect, test } from "vitest";
import type { LoginMeta } from "../../../api/browser";
import { describeLogin, mirrorError } from "./model";

const meta = (over: Partial<LoginMeta> = {}): LoginMeta => ({
  site: "github.com",
  enabled: true,
  savedAt: "2026-11-13T08:05:00.000Z",
  cookies: 12,
  origins: 3,
  ...over,
});

test("describeLogin：条数与保存时间，不含任何内容", () => {
  const text = describeLogin(meta());
  expect(text).toContain("12 个 cookie");
  expect(text).toContain("3 个站点存储");
  expect(text).toContain("保存于");
});

test("describeLogin：时间解析不了就只给条数", () => {
  expect(describeLogin(meta({ savedAt: "坏的" }))).toBe(
    "12 个 cookie · 3 个站点存储",
  );
});

test("mirrorError：空与 http(s) 地址放行，其余给提示", () => {
  for (const ok of ["", "  ", "https://a.b/pw", " http://10.0.0.2:8080/pw "])
    expect(mirrorError(ok), ok).toBeNull();
  for (const bad of [
    "mirror.example",
    "ftp://a.b/c",
    "javascript:alert(1)",
    `https://a.b/${"x".repeat(600)}`,
  ])
    expect(mirrorError(bad), bad).not.toBeNull();
});
