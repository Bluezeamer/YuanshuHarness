import { describe, expect, test } from "vitest";
import type { ConsoleEntry } from "../engine/types.js";
import { renderConsole } from "./console-view.js";

/** 本地时间 2026-01-02 12:00:05 附近的一个基点，时钟断言与本地时区无关。 */
const BASE = new Date(2026, 0, 2, 12, 0, 5).getTime();

const entry = (p: Partial<ConsoleEntry> & { text: string }): ConsoleEntry => ({
  id: 1,
  ts: BASE,
  firstTs: BASE,
  count: 1,
  kind: "console",
  level: "log",
  ...p,
});

const run = (
  entries: ConsoleEntry[],
  opts: { evicted?: number; level?: "warn" | "error"; now?: number } = {},
) =>
  renderConsole(entries, {
    evicted: opts.evicted ?? 0,
    ...(opts.level === undefined ? {} : { level: opts.level }),
    now: opts.now ?? BASE,
  });

describe("renderConsole", () => {
  test("空缓冲：只有头行与一句没有消息", () => {
    expect(run([])).toEqual({
      text: "CONSOLE: 0 entries · 0 distinct · 0 evicted\n(no console messages)",
      elided: false,
      full: "CONSOLE: 0 entries · 0 distinct · 0 evicted",
    });
  });

  test("头行的 N 是次数之和、M 是组数、K 是挤掉次数", () => {
    const out = run(
      [
        entry({ id: 1, count: 3, text: "a" }),
        entry({ id: 2, count: 1, text: "b" }),
      ],
      { evicted: 7 },
    );
    expect(out.text.split("\n")[0]).toBe(
      "CONSOLE: 4 entries · 2 distinct · 7 evicted",
    );
  });

  test("每组一行：×n 与 last 只在次数大于 1 时出现；带 url 时写在文字后", () => {
    expect(
      run([
        entry({ id: 1, count: 1, text: "one" }),
        entry({
          id: 2,
          count: 4,
          text: "many",
          level: "warn",
          url: "https://x.test/api",
        }),
      ]).text,
    ).toBe(
      [
        "CONSOLE: 5 entries · 2 distinct · 0 evicted",
        "[log] one · 0s ago",
        "[warn] ×4 many (https://x.test/api) · last 0s ago",
      ].join("\n"),
    );
  });

  test("相对时间四档与负数", () => {
    const text = renderConsole(
      [
        entry({ id: 1, text: "a", ts: BASE - 12_000 }),
        entry({ id: 2, text: "b", ts: BASE - 3 * 60_000 }),
        entry({ id: 3, text: "c", ts: BASE - 2 * 3_600_000 }),
        entry({ id: 4, text: "d", ts: BASE - 30 * 3_600_000 }),
        entry({ id: 5, text: "e", ts: BASE + 5_000 }),
      ],
      { evicted: 0, now: BASE },
    ).text;
    expect(text.split("\n").slice(1)).toEqual([
      "[log] a · 12s ago",
      "[log] b · 3m ago",
      "[log] c · 2h ago",
      "[log] d · 1d ago",
      "[log] e · 0s ago",
    ]);
  });

  test("单条超过 500 字符截断，标出被截掉的字符数；换行折成空格再算长度", () => {
    const long = "x".repeat(600);
    const out = run([entry({ text: long })]);
    expect(out.text.split("\n")[1]).toBe(
      `[log] ${"x".repeat(500)}…(+100 chars) · 0s ago`,
    );
    expect(out.elided).toBe(true);

    // 换行折成一个空格后正好 500 字符：不截断
    const folded = `${"y".repeat(498)}\nz`;
    expect(run([entry({ text: folded })]).text.split("\n")[1]).toBe(
      `[log] ${"y".repeat(498)} z · 0s ago`,
    );
  });

  test("过滤：warn 保留 warn / error / 失败请求 / 页面异常，error 只保留后三者", () => {
    const entries = [
      entry({ id: 1, text: "plain", level: "log" }),
      entry({ id: 2, text: "info", level: "info" }),
      entry({ id: 3, text: "warned", level: "warn" }),
      entry({ id: 4, text: "failed", level: "error" }),
      entry({
        id: 5,
        text: "req",
        kind: "request-failed",
        level: "error",
        url: "https://x.test/a",
      }),
      entry({
        id: 6,
        text: "uncaught",
        kind: "error",
        level: "error",
        url: "https://x.test/app.js:9",
      }),
    ];
    const warn = run(entries, { level: "warn" }).text.split("\n");
    expect(warn[0]).toBe(
      "CONSOLE: 4 entries · 4 distinct · 0 evicted · level >= warn",
    );
    expect(warn.slice(1)).toEqual([
      "[warn] warned · 0s ago",
      "[error] failed · 0s ago",
      "[request failed] req (https://x.test/a) · 0s ago",
      "[error] uncaught (https://x.test/app.js:9) · 0s ago",
    ]);

    const error = run(entries, { level: "error" }).text.split("\n");
    expect(error[0]).toBe(
      "CONSOLE: 3 entries · 3 distinct · 0 evicted · level >= error",
    );
    expect(error.slice(1)).toEqual(warn.slice(2));
  });

  test("过滤后一条不剩：头行写过滤后的零，仍写 level", () => {
    const out = run([entry({ text: "plain", level: "log" })], {
      level: "error",
    });
    expect(out.text).toBe(
      "CONSOLE: 0 entries · 0 distinct · 0 evicted · level >= error\n(no console messages)",
    );
  });

  test("超预算：从最早的组整组丢、声明组数，头行仍写过滤后的总数", () => {
    // 20 组，单条各自截到 500 后仍然总远也超 6000：前面几组要被整组丢掉
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry({ id: i + 1, text: `${i}-${"z".repeat(590)}` }),
    );
    const out = run(entries);
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("CONSOLE: 20 entries · 20 distinct · 0 evicted");
    expect(lines[1]).toMatch(/^… \d+ earlier entries omitted$/);
    const dropped = Number(/(\d+) earlier/.exec(lines[1] ?? "")?.[1]);
    expect(dropped).toBeGreaterThan(0);
    // 丢的是最早的组：留下的是最后几组，第一组一定被丢了
    expect(out.text).not.toContain("[log] 0-zzz");
    expect(out.text).toContain("[log] 19-zzz");
    expect(lines).toHaveLength(1 + 1 + (20 - dropped));
    expect(out.text.length).toBeLessThanOrEqual(6000);
    expect(out.elided).toBe(true);
  });

  test("elided 的三个来源：单条截断、超预算、缓冲挤掉过", () => {
    expect(run([entry({ text: "short" })]).elided).toBe(false);
    expect(run([entry({ text: "x".repeat(600) })]).elided).toBe(true);
    expect(run([], { evicted: 1 }).elided).toBe(true);
  });

  test("full：不过滤、不截断，含 ×n 与首末时间；挤掉过时头行下面声明", () => {
    const warnings = entry({
      id: 1,
      text: "warned",
      level: "warn",
      count: 2,
      firstTs: BASE - 65_000,
      ts: BASE,
    });
    const long = entry({
      id: 2,
      text: "L".repeat(600),
      kind: "error",
      level: "error",
    });
    const out = run([warnings, long], { evicted: 3, level: "error" });
    expect(out.text).not.toContain("warned");
    expect(out.full).toBe(
      [
        "CONSOLE: 3 entries · 2 distinct · 3 evicted",
        "(3 earlier occurrences were evicted from the buffer and are not in this file)",
        "[warn] ×2 warned · first 11:59:00 · last 12:00:05",
        `[error] ×1 ${"L".repeat(600)} · at 12:00:05`,
      ].join("\n"),
    );
  });

  test("full 里文字里的换行折成空格", () => {
    const out = run([entry({ text: "a\nb" })]);
    expect(out.full.split("\n")).toEqual([
      "CONSOLE: 1 entries · 1 distinct · 0 evicted",
      "[log] ×1 a b · at 12:00:05",
    ]);
  });
});
