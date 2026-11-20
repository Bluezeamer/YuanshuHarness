// emulate-tools 的行为：参数形状与校验、只读与写两条路径、摘要不含 UA 全文、结果外壳。
// 全部用替身：不装浏览器、不起进程。
import { afterAll, describe, expect, test } from "vitest";
import {
  cleanupTmpDirs,
  makeToolHarness,
  type ToolHarness,
} from "./testkit.js";

afterAll(cleanupTmpDirs);

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

const error = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
};

/** 经工具打开一个站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  await h.run("browser_open", { target });
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1) };
}

/** 带确认替身的工作台：confirms 记下每次确认的入参。 */
function harness(overrides: Parameters<typeof makeToolHarness>[0] = {}) {
  const confirms: Array<{ tool: string; host: string; summary: string }> = [];
  const h = makeToolHarness({
    async confirmAction(args) {
      confirms.push(args);
      return { allowed: true };
    },
    ...overrides,
  });
  return { h, confirms };
}

describe("browser_emulate", () => {
  test("用户正在操作页面：只读照常，写被拒（只读不占操作权）", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    expect(textOf(await h.run("browser_emulate", { pageId }))).toContain(
      "ACTIVE: none",
    );
    expect(
      await error(h.run("browser_emulate", { pageId, offline: true })),
    ).toContain("用户正在操作");
  });

  test("什么都不给：只读当前状态，不确认、不审计", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    // 环境模拟不读页面内容，不经清洗器（browser_open 自己读一次）
    const cleaned = h.cleaner.calls.length;
    const out = textOf(await h.run("browser_emulate", { pageId }));
    expect(out).toBe(
      ["EMULATION: 示例页 | https://example.com/a", "ACTIVE: none"].join("\n"),
    );
    expect(page.emulationPatches).toEqual([]);
    // 普通站点不逐动作确认，但只读路径也不写审计。
    expect(confirms).toEqual([]);
    expect(h.audit).toEqual([
      { tool: "browser_open", pageId, summary: "打开 https://example.com/a" },
    ]);
    expect(h.cleaner.calls).toHaveLength(cleaned);
  });

  test("给几项：合成一份 patch，返回改完后的状态", async () => {
    const { h, confirms } = harness();
    const { pageId, page } = await openViaTool(h);
    page.setTitle("示例页");
    const out = textOf(
      await h.run("browser_emulate", {
        pageId,
        offline: true,
        latencyMs: 300,
        downloadKbps: 500,
        cpuSlowdown: 4,
        colorScheme: "dark",
      }),
    );
    expect(page.emulationPatches).toEqual([
      {
        offline: true,
        throttle: { latencyMs: 300, downloadKbps: 500 },
        cpuSlowdown: 4,
        colorScheme: "dark",
      },
    ]);
    expect(out).toBe(
      [
        "EMULATION: 示例页 | https://example.com/a",
        "ACTIVE: offline, throttle latency 300 ms / down 500 kbps / up unlimited, cpu ×4, colorScheme=dark",
      ].join("\n"),
    );
    // 摘要只列项名，不含 UA 与语言的值
    expect(h.audit.at(-1)?.summary).toBe(
      "环境模拟：offline、throttle、cpuSlowdown、colorScheme",
    );
    // 普通站点不逐动作确认
    expect(confirms).toEqual([]);
  });

  test("UA 与语言：摘要里只写项名，不写值", async () => {
    const { h } = harness();
    const { pageId } = await openViaTool(h);
    const ua = `Mozilla/5.0 (secret-agent-${"x".repeat(50)})`;
    await h.run("browser_emulate", { pageId, userAgent: ua, locale: "ja-JP" });
    expect(h.audit.at(-1)?.summary).toBe("环境模拟：userAgent、locale");
    expect(h.audit.at(-1)?.summary).not.toContain("secret-agent");
  });

  test("reset 与其它项合成一次 patch", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_emulate", {
      pageId,
      reset: true,
      timezone: "Asia/Tokyo",
    });
    expect(page.emulationPatches).toEqual([
      {
        offline: false,
        throttle: null,
        cpuSlowdown: null,
        colorScheme: null,
        reducedMotion: null,
        userAgent: null,
        locale: null,
        timezone: "Asia/Tokyo",
        cacheDisabled: false,
      },
    ]);
  });

  test("只给 reset：patch 就是撤销全部", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    const out = textOf(await h.run("browser_emulate", { pageId, reset: true }));
    expect(page.emulationPatches).toHaveLength(1);
    expect(page.emulationPatches[0]).toMatchObject({
      offline: false,
      throttle: null,
      cacheDisabled: false,
    });
    expect(out.split("\n")[1]).toBe("ACTIVE: none");
    expect(h.audit.at(-1)?.summary).toBe("环境模拟：reset");
  });

  test("参数校验：类型与范围不对时一句话说清怎么改", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    expect(
      await error(h.run("browser_emulate", { pageId, offline: "yes" })),
    ).toBe("offline 必须是布尔值");
    expect(
      await error(h.run("browser_emulate", { pageId, cacheDisabled: 1 })),
    ).toBe("cacheDisabled 必须是布尔值");
    expect(
      await error(h.run("browser_emulate", { pageId, latencyMs: -1 })),
    ).toContain("latencyMs 必须是 ≥ 0 的数");
    expect(
      await error(h.run("browser_emulate", { pageId, downloadKbps: "500" })),
    ).toContain("downloadKbps 必须是 ≥ 0 的数");
    expect(
      await error(h.run("browser_emulate", { pageId, uploadKbps: -5 })),
    ).toContain("uploadKbps 必须是 ≥ 0 的数");
    expect(
      await error(h.run("browser_emulate", { pageId, cpuSlowdown: 0.5 })),
    ).toContain("cpuSlowdown 必须是 ≥ 1 的数");
    expect(
      await error(h.run("browser_emulate", { pageId, colorScheme: "auto" })),
    ).toBe("colorScheme 只能是 light、dark、no-preference");
    expect(
      await error(h.run("browser_emulate", { pageId, reducedMotion: "none" })),
    ).toBe("reducedMotion 只能是 reduce、no-preference");
    expect(
      await error(h.run("browser_emulate", { pageId, userAgent: "" })),
    ).toBe("userAgent 不能是空串：要换成的 UA 字符串");
    expect(
      await error(h.run("browser_emulate", { pageId, locale: "x".repeat(36) })),
    ).toBe("locale 最长 35 个字符，现在 36 个");
    expect(
      await error(
        h.run("browser_emulate", { pageId, timezone: "x".repeat(65) }),
      ),
    ).toBe("timezone 最长 64 个字符，现在 65 个");
    expect(
      await error(h.run("browser_emulate", { pageId, reset: false })),
    ).toContain("reset 只能是 true");
    expect(await error(h.run("browser_emulate", { pageId: "" }))).toContain(
      "pageId 必须是",
    );
    // 校验失败时一条命令都没发
    expect(page.emulationPatches).toEqual([]);
  });

  test("高敏感站点：先逐动作确认，拒绝时不动页面", async () => {
    const { h, confirms } = harness();
    h.deps.access = { approved: () => true, known: () => true };
    h.deps.confirmAction = async (args) => {
      confirms.push(args);
      return { allowed: false, note: "" };
    };
    await h.run("browser_open", { target: "https://mail.google.com/a" });
    const pageId = h.registry.list("w1")[0]?.id as string;
    const page = h.ctx().pageAt(-1);
    const msg = await error(
      h.run("browser_emulate", { pageId, offline: true }),
    );
    expect(msg).toContain("用户没有批准");
    expect(confirms).toEqual([
      {
        tool: "browser_emulate",
        host: "mail.google.com",
        summary: "环境模拟：offline",
      },
    ]);
    expect(page.emulationPatches).toEqual([]);
  });

  test("引擎报错原样给模型（只取一行）", async () => {
    const { h } = harness();
    const { pageId, page } = await openViaTool(h);
    page.emulateError = new Error("时区不对\n第二行");
    expect(
      await error(h.run("browser_emulate", { pageId, timezone: "x" })),
    ).toBe("时区不对");
  });
});
