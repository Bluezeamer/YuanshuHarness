// storage-view 的渲染规则：Cookie 行、Web 存储条目行、空清单、预算与整行截断、写操作的返回文字。
import { describe, expect, test } from "vitest";
import type { PageCookie, WebStorageEntry } from "../engine/types.js";
import {
  defaultCookiePath,
  renderCookies,
  renderStorageWrite,
  renderStore,
  storageName,
} from "./storage-view.js";

const cookie = (p: Partial<PageCookie> = {}): PageCookie => ({
  name: "sid",
  value: "abc123",
  domain: ".x.test",
  path: "/",
  expires: Date.parse("2026-12-01T00:00:00Z") / 1000,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  ...p,
});

const query = { title: "示例页", url: "https://x.test/app" };

describe("renderCookies", () => {
  test("外壳：scope page 带页面地址，每行一个 Cookie，属性按固定顺序", () => {
    const lines = [
      "STORAGE: cookies · scope page (https://x.test/app) | 示例页",
      "COOKIES: 2",
      "#1 sid  .x.test  /  expires 2026-12-01T00:00:00Z  httpOnly secure SameSite=Lax  value: abc123",
      "#2 theme  x.test  /  session  SameSite=Lax  value: dark",
    ].join("\n");
    expect(
      renderCookies(
        [
          cookie(),
          cookie({
            name: "theme",
            value: "dark",
            domain: "x.test",
            expires: -1,
            httpOnly: false,
            secure: false,
          }),
        ],
        { ...query, scope: "page" },
      ),
    ).toEqual({ text: lines, elided: false, full: lines });
  });

  test("scope all：头行不写页面地址；没有 Cookie 写 No cookies.", () => {
    expect(renderCookies([], { ...query, scope: "all" }).text).toBe(
      [
        "STORAGE: cookies · scope all | 示例页",
        "COOKIES: 0",
        "No cookies.",
      ].join("\n"),
    );
  });

  test("值超过 2000 字符：截到 2000 并标出剩下的字符数（full 也一样，截的只是值）", () => {
    const view = renderCookies([cookie({ value: "v".repeat(2500) })], {
      ...query,
      scope: "page",
    });
    const line = view.text.split("\n")[2] ?? "";
    expect(line).toContain("…(+500 chars)");
    expect(view.full.split("\n")[2]).toContain("…(+500 chars)");
    expect(view.full).not.toContain("v".repeat(2500));
  });

  test("清单超预算：按整行留前 6000 字符、报剩余行数，full 完整", () => {
    const cookies = Array.from({ length: 200 }, (_, i) =>
      cookie({ name: `c${i}`, value: "v".repeat(100) }),
    );
    const view = renderCookies(cookies, { ...query, scope: "page" });
    expect(view.elided).toBe(true);
    const lines = view.text.split("\n");
    expect(lines[0]).toBe(
      "STORAGE: cookies · scope page (https://x.test/app) | 示例页",
    );
    expect(lines[1]).toBe("COOKIES: 200");
    expect(lines.at(-1)).toMatch(
      /^… \d+ more lines \(200 lines total\); full list is saved as an attachment$/,
    );
    expect(lines.slice(2, -1).every((l) => l.startsWith("#"))).toBe(true);
    expect(lines.slice(2, -1).join("\n").length).toBeLessThanOrEqual(6000);
    expect(view.full.split("\n")).toHaveLength(2 + 200);
  });
});

describe("renderStore", () => {
  const entry = (p: Partial<WebStorageEntry> = {}): WebStorageEntry => ({
    key: "theme",
    value: "dark",
    ...p,
  });

  test("外壳与条目行；键名顺序按调用方给的（引擎已按键名升序）", () => {
    expect(
      renderStore("local", [entry(), entry({ key: "user", value: "a" })], {
        title: "示例页",
        origin: "https://x.test",
      }).text,
    ).toBe(
      [
        "STORAGE: localStorage · https://x.test | 示例页",
        "#1 theme: dark",
        "#2 user: a",
      ].join("\n"),
    );
    expect(
      renderStore("session", [], {
        title: "示例页",
        origin: "https://x.test",
      }).text,
    ).toBe(
      ["STORAGE: sessionStorage · https://x.test | 示例页", "No entries."].join(
        "\n",
      ),
    );
  });

  test("值超过 2000 字符：截断标出剩余字符数", () => {
    const out = renderStore("local", [entry({ value: "x".repeat(2100) })], {
      title: "示例页",
      origin: "https://x.test",
    }).text;
    expect(out.split("\n")[1]).toContain("…(+100 chars)");
  });

  test("条目超预算：整行前缀 + 提示行", () => {
    const entries = Array.from({ length: 300 }, (_, i) =>
      entry({ key: `k${i}`, value: "v".repeat(80) }),
    );
    const view = renderStore("session", entries, {
      title: "示例页",
      origin: "https://x.test",
    });
    expect(view.elided).toBe(true);
    expect(view.text.split("\n").at(-1)).toMatch(
      /^… \d+ more lines \(300 lines total\); full list is saved as an attachment$/,
    );
    expect(view.full.split("\n")).toHaveLength(1 + 300);
  });
});

describe("storageName", () => {
  test("kind 写成页面里的对象名", () => {
    expect(storageName("local")).toBe("localStorage");
    expect(storageName("session")).toBe("sessionStorage");
  });
});

describe("renderStorageWrite", () => {
  test("写 Cookie：只有域与路径，不贴值", () => {
    expect(
      renderStorageWrite({
        op: "set-cookie",
        cookie: {
          name: "sid",
          value: "超级秘密",
          domain: ".x.test",
          path: "/",
        },
        pageUrl: "https://x.test/app",
      }),
    ).toBe("SET cookie sid (domain .x.test, path /)");
  });

  test("写 Cookie 没给 domain / path：按页面地址补出实际落下的那两项", () => {
    expect(
      renderStorageWrite({
        op: "set-cookie",
        cookie: { name: "sid", value: "v" },
        pageUrl: "https://x.test/app/x?q=1",
      }),
    ).toBe("SET cookie sid (domain x.test, path /app/)");
  });

  test("删 Cookie：删到几个都照写，0 也是正常结果", () => {
    expect(
      renderStorageWrite({ op: "del-cookie", scope: "page", removed: 2 }),
    ).toBe("DELETED 2 cookies (scope page)");
    expect(
      renderStorageWrite({ op: "del-cookie", scope: "all", removed: 1 }),
    ).toBe("DELETED 1 cookie (scope all)");
    expect(
      renderStorageWrite({ op: "del-cookie", scope: "page", removed: 0 }),
    ).toBe("DELETED 0 cookies (scope page)");
  });

  test("Web 存储的写 / 删 / 清：键名带引号，不贴值", () => {
    expect(
      renderStorageWrite({ op: "set-store", kind: "local", key: "theme" }),
    ).toBe('SET localStorage key "theme"');
    expect(
      renderStorageWrite({
        op: "del-store",
        kind: "local",
        key: "theme",
        changed: 1,
      }),
    ).toBe('DELETED localStorage key "theme"');
    expect(
      renderStorageWrite({
        op: "del-store",
        kind: "local",
        key: "theme",
        changed: 0,
      }),
    ).toBe('DELETED 0 entries from localStorage (key "theme")');
    expect(
      renderStorageWrite({ op: "clear-store", kind: "session", changed: 5 }),
    ).toBe("CLEARED 5 entries from sessionStorage");
  });
});

describe("defaultCookiePath", () => {
  test("按地址的目录推；根目录与解析不了的地址都是 /", () => {
    expect(defaultCookiePath("https://x.test/app/x?q=1")).toBe("/app/");
    expect(defaultCookiePath("https://x.test/")).toBe("/");
    expect(defaultCookiePath("https://x.test")).toBe("/");
    expect(defaultCookiePath("about:blank")).toBe("/");
  });
});
