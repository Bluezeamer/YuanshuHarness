import { describe, expect, test } from "vitest";
import { CLEAN_LIMITS } from "./limits.js";
import { readPage } from "./read.js";
import type { AuxCall, PageReader } from "./types.js";

/** 一份小页面：机械层后不到 directMaxChars。 */
const SMALL = `- main:
  - button "登录" [ref=e1]`;

/** 一份中等页面：机械层后超过 directMaxChars、不到 singleCallMaxChars。 */
const MEDIUM = `- main:\n${Array.from(
  { length: 40 },
  (_, i) => `  - button "提交表单的第 ${i} 个按钮" [ref=e${i + 1}]`,
).join("\n")}`;

/** 一份大页面：机械层后超过 singleCallMaxChars。 */
const BIG = `- main:\n${Array.from(
  { length: 2000 },
  (_, i) => `  - button "提交表单的第 ${i} 个按钮" [ref=e${i + 1}]`,
).join("\n")}`;

const lineCount = (raw: string): number => raw.split("\n").length;

interface Ctx {
  aux: AuxCall | null;
  reader: PageReader | null;
  masked: string[];
  saved: { name: string; text: string }[];
  auxCalls: { system: string; user: string }[];
  readerCalls: { sessionId: string; task: string; label: string }[];
}

function deps(over: Partial<Ctx> = {}) {
  const ctx: Ctx = {
    aux: null,
    reader: null,
    masked: [],
    saved: [],
    auxCalls: [],
    readerCalls: [],
    ...over,
  };
  const d = {
    aux: () => ctx.aux,
    reader: () => ctx.reader,
    mask: (text: string) => {
      ctx.masked.push(text);
      return text.replace(/SECRET/g, "***");
    },
  };
  return { ctx, deps: d };
}

const args = (over: {
  raw?: string;
  intent?: string | null;
  save?: (name: string, text: string) => Promise<string>;
  signal?: AbortSignal;
}) => ({
  sessionId: "s1",
  pageId: "p1",
  raw: over.raw ?? MEDIUM,
  url: "https://x.test/a",
  title: "登录页",
  intent: over.intent ?? null,
  snapshotId: "s1",
  saveText:
    over.save ??
    (async (name: string, text: string) => {
      saved.push({ name, text });
      return `[attach_file] ${name}`;
    }),
  ...(over.signal ? { signal: over.signal } : {}),
});

const saved: { name: string; text: string }[] = [];

/** overview 指针：覆盖整页，带一个代表元素。 */
const OVERVIEW = JSON.stringify({
  gist: "登录页",
  parts: [{ caption: "表单", lines: [1, 2], refs: ["e1"] }],
});

const INTENT = JSON.stringify({ groups: [{ refs: ["e1"] }], unresolved: "" });

describe("readPage：直给", () => {
  test("机械层不超过 directMaxChars：给机械层全文，不调模型、不存文件", async () => {
    const { ctx, deps: d } = deps();
    saved.length = 0;
    const out = await readPage(d, args({ raw: SMALL }));
    expect(out.stage).toBe("direct");
    expect(out.body).toContain(`- button "登录" [ref=e1]`);
    expect(out.lines).toBe(lineCount(SMALL));
    expect(ctx.auxCalls).toEqual([]);
    expect(saved).toEqual([]);
  });

  test("同源绝对地址写成根相对路径（origin 取 url）", async () => {
    const { deps: d } = deps();
    const out = await readPage(
      d,
      args({
        raw: `- link "Home" [ref=e1]:\n  - /url: https://x.test/home`,
      }),
    );
    expect(out.body).toContain("→ /home");
  });
});

describe("readPage：单次辅助调用", () => {
  test("overview：送进 aux 的是遮罩后的带行号文本，system 是 OVERVIEW_SYSTEM", async () => {
    const { ctx, deps: d } = deps({
      aux: async (a: { system: string; user: string }) => {
        ctx.auxCalls.push(a);
        return OVERVIEW;
      },
    });
    saved.length = 0;
    const out = await readPage(d, args({ raw: MEDIUM }));
    expect(out.stage).toBe("aux");
    expect(ctx.auxCalls).toHaveLength(1);
    const call = ctx.auxCalls[0];
    expect(call?.system).toContain("You are a page-reading component");
    expect(call?.system).toContain("ONE JSON object");
    // 带行号
    expect(call?.user).toContain("SNAPSHOT (");
    expect(call?.user).toMatch(/\n *1\| - main:/);
    expect(call?.user).toContain("TASK: describe this page");
    // 投影：编号与事实来自原文展开，gist 标成模型所写
    expect(out.body).toContain("GIST (model-written, navigation only): 登录页");
    expect(out.body).toContain("[1] 表单 · L1-2");
    expect(out.body).toContain(`e1 button "提交表单的第 0 个按钮"`);
  });

  test("overview：存的是遮罩后的文件，body 末尾有 FULL TEXT 行", async () => {
    const { ctx, deps: d } = deps({
      aux: async (a: { system: string; user: string }) => {
        ctx.auxCalls.push(a);
        return OVERVIEW;
      },
    });
    saved.length = 0;
    const out = await readPage(
      d,
      args({
        raw: `- main:\n  - button "SECRET" [ref=e1]\n  - text: ${"x".repeat(1000)}`,
      }),
    );
    // 送模型的带行号文本也是遮罩后的
    expect(ctx.auxCalls[0]?.user).not.toContain("SECRET");
    expect(ctx.auxCalls[0]?.user).toContain("***");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe("page-p1-s1.txt");
    expect(saved[0]?.text).not.toContain("SECRET");
    expect(saved[0]?.text).toContain("***");
    // 行号与送模型的一致
    expect(saved[0]?.text.split("\n").length).toBe(
      ctx.masked.at(-1)?.split("\n").length,
    );
    expect(out.body.split("\n").at(-1)).toMatch(
      /^FULL TEXT \(\d+ lines; the L<n> numbers above are its line numbers\): \[attach_file\] page-p1-s1.txt$/,
    );
  });

  test("intent：走 INTENT_SYSTEM，输出分组，不存文件", async () => {
    const { ctx, deps: d } = deps({
      aux: async (a: { system: string; user: string }) => {
        ctx.auxCalls.push(a);
        return INTENT;
      },
    });
    saved.length = 0;
    const out = await readPage(
      d,
      args({ raw: MEDIUM, intent: "找到登录按钮" }),
    );
    expect(out.stage).toBe("aux");
    expect(ctx.auxCalls[0]?.system).toContain(
      "must be a pointer into the snapshot",
    );
    expect(ctx.auxCalls[0]?.user).toContain("INTENT: 找到登录按钮");
    expect(out.body).toContain("INTENT: 找到登录按钮");
    expect(out.body).toContain(`e1 button "提交表单的第 0 个按钮"`);
    expect(saved).toEqual([]);
    expect(out.body).not.toContain("FULL TEXT");
  });

  test("解析失败重试一次：第二次成功就用它", async () => {
    let n = 0;
    const { deps: d } = deps({
      aux: async () => {
        n += 1;
        return n === 1 ? "我不会回 JSON" : OVERVIEW;
      },
    });
    const out = await readPage(d, args({ raw: MEDIUM }));
    expect(n).toBe(2);
    expect(out.stage).toBe("aux");
  });

  test("两次都解析不了：回落，NOTE 行在最前，stage 是 fallback", async () => {
    let n = 0;
    const { deps: d } = deps({
      aux: async () => {
        n += 1;
        return "还是不是 JSON";
      },
    });
    const out = await readPage(d, args({ raw: MEDIUM }));
    expect(n).toBe(2);
    expect(out.stage).toBe("fallback");
    expect(out.body.split("\n")[0]).toBe(
      "NOTE: page-reading model unavailable (returned an unusable answer); showing the page without a model summary.",
    );
    // 放得下内联上限：给机械层全文
    expect(out.body).toContain(`- button "提交表单的第 0 个按钮" [ref=e1]`);
  });

  test("辅助调用抛错：同样进回落，不把异常漏出去", async () => {
    const { deps: d } = deps({
      aux: async () => {
        throw new Error("超时");
      },
    });
    const out = await readPage(d, args({ raw: MEDIUM }));
    expect(out.stage).toBe("fallback");
    expect(out.body).toContain("NOTE: page-reading model unavailable");
  });

  test("存文件失败：整次进回落，不让异常漏出去", async () => {
    const { ctx, deps: d } = deps({
      aux: async (a: { system: string; user: string }) => {
        ctx.auxCalls.push(a);
        return OVERVIEW;
      },
    });
    const out = await readPage(
      d,
      args({
        raw: MEDIUM,
        save: async () => {
          throw new Error("附件区满了");
        },
      }),
    );
    expect(out.stage).toBe("fallback");
    expect(out.body).toContain("could not save the page text file");
  });
});

describe("readPage：大页面走 reader", () => {
  test("任务文字里的结构视图来自遮罩后的文本，含文件标记行", async () => {
    const { ctx, deps: d } = deps({
      aux: async () => OVERVIEW,
      reader: async ({ task }: { task: string }) => {
        ctx.readerCalls.push({ sessionId: "s1", task, label: "x" });
        return OVERVIEW;
      },
    });
    saved.length = 0;
    const out = await readPage(
      d,
      args({
        raw: `- main:\n  - heading "SECRET 标题" [ref=e1]\n${Array.from(
          { length: 2000 },
          (_, i) => `  - button "按钮 ${i}" [ref=e${i + 2}]`,
        ).join("\n")}`,
      }),
    );
    expect(out.stage).toBe("agent");
    const task = ctx.readerCalls[0]?.task ?? "";
    expect(task).toContain("PAGE TEXT FILE: [attach_file] page-p1-s1.txt");
    expect(task).toContain("STRUCTURE VIEW:");
    expect(task).toContain("*** 标题");
    expect(task).not.toContain("SECRET");
    expect(saved[0]?.text).not.toContain("SECRET");
  });

  test("reader 返回 null：回落为结构视图 + 文件，不重试", async () => {
    let n = 0;
    const { deps: d } = deps({
      aux: async () => OVERVIEW,
      reader: async () => {
        n += 1;
        return null;
      },
    });
    const out = await readPage(d, args({ raw: BIG }));
    expect(n).toBe(1);
    expect(out.stage).toBe("fallback");
    expect(out.body.split("\n")[0]).toBe(
      "NOTE: page-reading model unavailable (reader agent gave no result); showing the page without a model summary.",
    );
    expect(out.body).toContain("reader agent gave no result");
    expect(out.body).toContain("FULL TEXT (");
  });

  test("reader 返回非法 JSON：同样回落，不重试", async () => {
    let n = 0;
    const { deps: d } = deps({
      aux: async () => OVERVIEW,
      reader: async () => {
        n += 1;
        return "不是 JSON";
      },
    });
    const out = await readPage(d, args({ raw: BIG }));
    expect(n).toBe(1);
    expect(out.stage).toBe("fallback");
    expect(out.body).toContain("returned an unusable answer");
  });

  test("没有 reader 可用：直接回落，不调任何模型", async () => {
    const { deps: d } = deps({ aux: async () => OVERVIEW, reader: null });
    const out = await readPage(d, args({ raw: BIG }));
    expect(out.stage).toBe("fallback");
    expect(out.body.split("\n")[0]).toContain("reader agent gave no result");
  });

  test("label 带标题（截到 30 字）", async () => {
    const labels: string[] = [];
    const { deps: d } = deps({
      aux: async () => OVERVIEW,
      reader: async ({ label }: { label: string }) => {
        labels.push(label);
        return OVERVIEW;
      },
    });
    await readPage(d, {
      ...args({ raw: BIG }),
      title: `${"很长".repeat(30)}的页面标题`,
    });
    expect(labels[0]).toBe(`页面阅读：${"很长".repeat(15)}`);
  });
});

describe("readPage：没配辅助模型", () => {
  test("不超过 inlineMaxChars：整份机械层", async () => {
    const { deps: d } = deps();
    const raw = `- main:\n${Array.from(
      { length: 80 },
      (_, i) => `  - button "按钮 ${i}" [ref=e${i + 1}]`,
    ).join("\n")}`;
    const out = await readPage(d, args({ raw }));
    expect(out.stage).toBe("inline");
    expect(out.body).toContain(`- button "按钮 0" [ref=e1]`);
    expect(out.body).not.toContain("FULL TEXT");
  });

  test("超过 inlineMaxChars：结构视图 + 文件", async () => {
    const { deps: d } = deps();
    saved.length = 0;
    const out = await readPage(d, args({ raw: BIG }));
    expect(out.stage).toBe("structure");
    expect(out.body).toContain("FULL TEXT (");
    expect(saved).toHaveLength(1);
    expect(out.body.length).toBeLessThan(BIG.length);
  });

  test("回落也一样：超过 inlineMaxChars 时给结构视图 + 文件", async () => {
    const { deps: d } = deps({
      aux: async () => {
        throw new Error("超时");
      },
    });
    saved.length = 0;
    const out = await readPage(d, args({ raw: BIG }));
    expect(out.stage).toBe("fallback");
    expect(out.body.split("\n")[0]).toContain(
      "NOTE: page-reading model unavailable",
    );
    expect(out.body).toContain("FULL TEXT (");
    expect(saved).toHaveLength(1);
  });
});

test("阈值都是字符数：directMaxChars 以上才走模型路径", async () => {
  const { ctx, deps: d } = deps({
    aux: async (a: { system: string; user: string }) => {
      ctx.auxCalls.push(a);
      return OVERVIEW;
    },
  });
  const justOver = `- main:\n  - text: ${"x".repeat(CLEAN_LIMITS.directMaxChars)}`;
  const out = await readPage(d, args({ raw: justOver }));
  expect(out.stage).toBe("aux");
});
