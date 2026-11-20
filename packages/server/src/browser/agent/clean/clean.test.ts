import { describe, expect, test } from "vitest";
import { createCleaner } from "./clean.js";
import type { AuxCall, CleanInput } from "./types.js";

const identity = (s: string) => s;

/** 页面快照：按钮集合。 */
const page = (...names: string[]): string =>
  `- main:\n${names
    .map((n, i) => `  - button "${n}" [ref=e${i + 1}]`)
    .join("\n")}`;

const BASE = page("登录", "注册");

/** 超过 inlineMaxChars 的页面：会走到结构视图 + 落文件（因此会过遮罩）。 */
const LARGE = page(
  ...Array.from({ length: 400 }, (_, i) => `一个挺长的按钮名字 ${i}`),
);

const input = (raw: string, over: Partial<CleanInput> = {}): CleanInput => ({
  sessionId: "s1",
  pageId: "p1",
  raw,
  url: "https://x.test/a",
  title: "登录页",
  explicit: false,
  saveText: async () => "[attach_file] page.txt",
  ...over,
});

/** 记录调用、按固定答案作答的辅助模型。 */
function aux(reply: string | (() => string)) {
  const calls: { system: string; user: string }[] = [];
  const call: AuxCall = async (a) => {
    calls.push(a);
    return typeof reply === "string" ? reply : reply();
  };
  return { call, calls };
}

const OVERVIEW = JSON.stringify({
  gist: "登录页",
  parts: [{ caption: "表单", lines: [1, 2], refs: ["e1"] }],
});

const setup = (
  over: {
    aux?: AuxCall | null;
    reader?: Parameters<typeof createCleaner>[0]["reader"];
  } = {},
) =>
  createCleaner({
    aux: () => over.aux ?? null,
    reader: over.reader ?? (() => null),
    mask: identity,
  });

describe("完整路径的判定", () => {
  test("显式 snapshot 永远走完整路径：与基线一样也给内容，不给 NO CHANGES", async () => {
    const c = setup();
    const first = await c.clean(input(BASE));
    expect(first.stage).toBe("direct");
    const again = await c.clean(input(BASE, { explicit: true }));
    expect(again.stage).toBe("direct");
    expect(again.text).not.toContain("NO CHANGES");
    expect(again.text).toContain(
      `SNAPSHOT: s2 · ${BASE.split("\n").length} lines`,
    );
  });

  test("没有基线：走完整路径", async () => {
    const c = setup();
    const out = await c.clean(input(BASE));
    expect(out.stage).toBe("direct");
    expect(out.text.split("\n")[0]).toBe("PAGE: 登录页 | https://x.test/a");
  });

  test("地址变了：走完整路径并在 URL 行写旧 → 新", async () => {
    const c = setup();
    await c.clean(input(BASE));
    const out = await c.clean(
      input(BASE, { url: "https://x.test/b", action: "click e99" }),
    );
    expect(out.stage).toBe("direct");
    const lines = out.text.split("\n");
    expect(lines[1]).toBe("ACTION: click e99");
    expect(lines[2]).toBe("URL: https://x.test/a → https://x.test/b");
  });

  test("无变化：NO CHANGES 并说清它只比较什么，带 ACTION 行", async () => {
    const c = setup();
    await c.clean(input(BASE));
    const out = await c.clean(input(BASE, { action: "click e1" }));
    expect(out.stage).toBe("no-changes");
    expect(out.text).toBe(
      "PAGE: 登录页 | https://x.test/a\nACTION: click e1\nNO CHANGES (element tree and text only; scroll position and pixels are not compared)",
    );
  });

  test("小改动：确定性 diff", async () => {
    const c = setup();
    await c.clean(input(BASE));
    const out = await c.clean(
      input(page("登录", "注册", "帮助"), { action: "click e2" }),
    );
    expect(out.stage).toBe("diff");
    expect(out.text).toContain(`+ e3 button "帮助"`);
    expect(out.text).not.toContain("SNAPSHOT:");
  });

  test("图片换了地址：diff 里同源地址写成根相对（与机械层一致）", async () => {
    const pic = (src: string) =>
      `- main:\n  - img "图 3" [ref=e2]:\n    - /src: ${src}`;
    const c = setup();
    await c.clean(input(pic("data:image/gif (43 chars)")));
    const out = await c.clean(
      input(pic("https://x.test/a/3.jpg"), { action: "scroll down" }),
    );
    expect(out.stage).toBe("diff");
    expect(out.text).toContain(
      `~ e2 img "图 3" → /a/3.jpg (was data:image/gif (43 chars))`,
    );
  });

  test("大改动（渲染后超过 diffMaxChars）：只截断内联、全文存附件，不调辅助模型、不起阅读 agent", async () => {
    const f = aux(OVERVIEW);
    const reads: string[] = [];
    const saved: { name: string; text: string }[] = [];
    const c = createCleaner({
      aux: () => f.call,
      reader:
        () =>
        async ({ sessionId }) => {
          reads.push(sessionId);
          return OVERVIEW;
        },
      // 遮罩会改字，用来确认落盘的是遮罩之后的文本
      mask: (s) => s.replace(/一个挺长的按钮名字/g, "[masked]"),
    });
    await c.clean(input(BASE));
    const many = Array.from(
      { length: 300 },
      (_, i) => `一个挺长的按钮名字 ${i}`,
    );
    const after = input(page("登录", ...many), {
      action: "click e2",
      saveText: async (name, text) => {
        saved.push({ name, text });
        return "[attach_file] diff.txt";
      },
    });
    const out = await c.clean(after);
    expect(out.stage).toBe("diff");
    expect(f.calls).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect(out.text).not.toContain("SNAPSHOT:");
    expect(out.text).toMatch(
      /\n… \d+ more lines not shown \(300 added, 0 changed, 1 removed elements in total\); full diff: \[attach_file\] diff\.txt$/,
    );
    // 内联部分不超过预算（末尾声明行不算）
    const inline = out.text.split("\n… ")[0] ?? "";
    expect(inline.length).toBeLessThanOrEqual(6_000 + 200);
    // 附件是遮罩之后的完整 diff：行数与元素数都对得上
    const file = saved[0];
    expect(file?.name).toBe("diff-p1-d1.txt");
    const lines = (file?.text ?? "").split("\n");
    // 完整 diff：一行消失的按钮 + 300 行新增
    expect(lines).toHaveLength(301);
    expect(lines[0]).toBe(`- button "注册"`);
    expect(lines[1]).toBe(`+ e2 button "[masked] 0"`);
    expect(file?.text).not.toContain("一个挺长的按钮名字");
    // 基线已更新：同样内容再调一次就是 NO CHANGES
    expect((await c.clean(after)).stage).toBe("no-changes");
  });

  test("超预算但附件存不上：只声明存不上", async () => {
    const c = setup();
    await c.clean(input(BASE));
    const many = Array.from(
      { length: 300 },
      (_, i) => `一个挺长的按钮名字 ${i}`,
    );
    const out = await c.clean(
      input(page("登录", ...many), {
        action: "click e2",
        saveText: async () => {
          throw new Error("存不了");
        },
      }),
    );
    expect(out.stage).toBe("diff");
    expect(out.text).toContain("; the full diff could not be saved");
    expect(out.text).not.toContain("full diff: [attach_file]");
  });

  test("只重排：给 diff（一块消失、同一块在新位置新增），不换路径", async () => {
    const f = aux(OVERVIEW);
    const c = setup({ aux: f.call });
    await c.clean(input(page("甲", "乙", "丙")));
    const out = await c.clean(input(page("乙", "甲", "丙")));
    expect(out.stage).toBe("diff");
    expect(out.text).toContain(`- button "甲"`);
    expect(out.text).toContain(`+ e2 button "甲"`);
    expect(out.text).not.toContain("SNAPSHOT:");
    expect(f.calls).toHaveLength(0);
  });

  test("基线在每次返回后更新：连续两次动作的 diff 相对上一次返回的状态", async () => {
    const c = setup();
    await c.clean(input(page("A")));
    const one = await c.clean(input(page("A", "B"), { action: "click e1" }));
    expect(one.text).toContain(`+ e2 button "B"`);
    const two = await c.clean(
      input(page("A", "B", "C"), { action: "click e2" }),
    );
    expect(two.text).toContain(`+ e3 button "C"`);
    // B 已经在上一次交出去了，不能重复出现
    expect(two.text).not.toContain(`button "B"`);
  });

  test("no-changes 之后基线也更新（地址以最新一次为准）", async () => {
    const c = setup();
    await c.clean(input(BASE));
    await c.clean(input(BASE, { action: "click e1" }));
    const out = await c.clean(input(BASE, { url: "https://x.test/b" }));
    expect(out.text).toContain("URL: https://x.test/a → https://x.test/b");
  });

  test("两个会话各看各的基线", async () => {
    const c = setup();
    await c.clean(input(BASE, { sessionId: "s1" }));
    const other = await c.clean(input(BASE, { sessionId: "s2" }));
    expect(other.stage).toBe("direct");
    expect(other.text).not.toContain("NO CHANGES");
    // s1 自己的基线还在
    expect((await c.clean(input(BASE, { sessionId: "s1" }))).stage).toBe(
      "no-changes",
    );
  });

  test("不同页面各看各的基线", async () => {
    const c = setup();
    await c.clean(input(BASE, { pageId: "p1" }));
    expect((await c.clean(input(BASE, { pageId: "p2" }))).stage).toBe("direct");
  });
});

describe("rebase / forgetPage", () => {
  test("rebase 把基线重置成给的那份：下一次比得到", async () => {
    const c = setup();
    await c.clean(input(page("A")));
    c.rebase("s1", "p1", page("X", "Y"), "https://x.test/a");
    const out = await c.clean(input(page("X", "Y", "Z")));
    expect(out.stage).toBe("diff");
    expect(out.text).toContain(`+ e3 button "Z"`);
  });

  test("rebase 也换地址：地址不同就按完整路径", async () => {
    const c = setup();
    c.rebase("s1", "p1", BASE, "https://x.test/old");
    const out = await c.clean(input(BASE));
    expect(out.stage).toBe("direct");
    expect(out.text).toContain("URL: https://x.test/old → https://x.test/a");
  });

  test("forgetPage 丢掉这个页面上所有会话的基线", async () => {
    const c = setup();
    await c.clean(input(BASE, { sessionId: "s1" }));
    await c.clean(input(BASE, { sessionId: "s2" }));
    c.forgetPage("p1");
    for (const sessionId of ["s1", "s2"])
      expect((await c.clean(input(BASE, { sessionId }))).stage).toBe("direct");
  });

  test("forgetPage 不影响别的页面", async () => {
    const c = setup();
    await c.clean(input(BASE, { pageId: "p1" }));
    await c.clean(input(BASE, { pageId: "p2" }));
    c.forgetPage("p1");
    expect((await c.clean(input(BASE, { pageId: "p2" }))).stage).toBe(
      "no-changes",
    );
  });
});

describe("外壳", () => {
  test("行的顺序：PAGE / ACTION / URL / notes / SNAPSHOT / body", async () => {
    const c = setup();
    await c.clean(input(BASE));
    const out = await c.clean(
      input(BASE, {
        url: "https://x.test/b",
        action: "click e1",
        notes: ['CLIPBOARD (page copied): "hi"'],
      }),
    );
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("PAGE: 登录页 | https://x.test/b");
    expect(lines[1]).toBe("ACTION: click e1");
    expect(lines[2]).toBe("URL: https://x.test/a → https://x.test/b");
    expect(lines[3]).toBe(`CLIPBOARD (page copied): "hi"`);
    expect(lines[4]).toBe(`SNAPSHOT: s2 · ${BASE.split("\n").length} lines`);
  });

  test("SNAPSHOT 编号单调递增；diff / no-changes 没有 SNAPSHOT 行", async () => {
    const c = setup();
    const a = await c.clean(input(BASE, { explicit: true }));
    const b = await c.clean(input(BASE, { explicit: true }));
    expect(a.text).toContain("SNAPSHOT: s1 · ");
    expect(b.text).toContain("SNAPSHOT: s2 · ");
    const diff = await c.clean(input(page("登录", "注册", "x")));
    expect(diff.text).not.toContain("SNAPSHOT:");
  });
});

describe("辅助模型路径", () => {
  test("配了辅助模型就走它：stage 是 aux，外壳照常", async () => {
    const f = aux(OVERVIEW);
    const c = setup({ aux: f.call });
    const out = await c.clean(
      input(
        `- main:\n${Array.from({ length: 40 }, (_, i) => `  - button "按钮 ${i}" [ref=e${i + 1}]`).join("\n")}`,
      ),
    );
    expect(out.stage).toBe("aux");
    expect(out.text).toContain("SNAPSHOT: s1 · ");
    expect(out.text).toContain("GIST (model-written, navigation only): 登录页");
    expect(f.calls).toHaveLength(1);
  });

  test("intent 每次现给：传给辅助模型", async () => {
    const f = aux(
      JSON.stringify({ groups: [{ refs: ["e1"] }], unresolved: "" }),
    );
    const c = setup({ aux: f.call });
    const raw = `- main:\n${Array.from({ length: 40 }, (_, i) => `  - button "按钮 ${i}" [ref=e${i + 1}]`).join("\n")}`;
    await c.clean(input(raw, { intent: "找登录" }));
    expect(f.calls[0]?.user).toContain("INTENT: 找登录");
    expect(f.calls[0]?.system).toContain("must be a pointer into the snapshot");
  });

  test("辅助模型谈不成：回落，stage 是 fallback，NOTE 在最前", async () => {
    const c = setup({
      aux: async () => {
        throw new Error("炸了");
      },
    });
    const raw = `- main:\n${Array.from({ length: 40 }, (_, i) => `  - button "按钮 ${i}" [ref=e${i + 1}]`).join("\n")}`;
    const out = await c.clean(input(raw));
    expect(out.stage).toBe("fallback");
    expect(out.text).toContain("NOTE: page-reading model unavailable");
  });
});

describe("读大页面时的信号", () => {
  test("调用方的 signal 与会话编号原样交给读页面的 agent", async () => {
    const huge = page(
      ...Array.from({ length: 2500 }, (_, i) => `一个挺长的按钮名字 ${i}`),
    );
    const seen: { sessionId: string; signal?: AbortSignal }[] = [];
    const c = setup({
      aux: aux(OVERVIEW).call,
      reader:
        () =>
        async ({ sessionId, signal }) => {
          seen.push({ sessionId, ...(signal ? { signal } : {}) });
          return OVERVIEW;
        },
    });
    const ac = new AbortController();
    const out = await c.clean(input(huge, { signal: ac.signal }));
    expect(out.stage).toBe("agent");
    expect(seen).toEqual([{ sessionId: "s1", signal: ac.signal }]);
  });
});

describe("健壮性", () => {
  test("遮罩抛错也不让 clean 抛：落成 fallback 的完整路径", async () => {
    const bad = createCleaner({
      aux: () => null,
      reader: () => null,
      mask: () => {
        throw new Error("遮罩坏了");
      },
    });
    const out = await bad.clean(input(LARGE, { explicit: true }));
    expect(out.text.split("\n")[0]).toBe("PAGE: 登录页 | https://x.test/a");
    expect(out.stage).toBe("fallback");
  });

  test("基线读抛错：兜成完整路径，不抛给调用方", async () => {
    const c = createCleaner({
      aux: () => null,
      reader: () => null,
      mask: identity,
      baselines: {
        get: () => {
          throw new Error("库坏了");
        },
        set: () => {
          throw new Error("库坏了");
        },
        delete: () => {},
        deletePage: () => {},
      },
    });
    const out = await c.clean(input(BASE));
    expect(out.text.split("\n")[0]).toBe("PAGE: 登录页 | https://x.test/a");
    expect(out.stage).toBe("direct");
  });
});
