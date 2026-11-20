import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CLEAN_LIMITS } from "./limits.js";
import { mechanical } from "./mech.js";
import {
  expandRef,
  indexRaw,
  projectIntent,
  projectOverview,
} from "./project.js";

/** 原始快照 → 机械层文本（投影读的是机械层的行号与原始快照的展开）。 */
const mechOf = (raw: string, origin = "https://lobste.rs"): string =>
  mechanical(raw, origin);

const TODO_RAW = `- generic [ref=e1]:
  - generic [ref=e2]:
    - heading "todos" [level=1] [ref=e7]
    - textbox "What needs to be done?" [active] [ref=e8]
  - list [ref=e18]:
    - listitem [ref=e19]:
      - checkbox "Toggle Todo" [ref=e21]
      - generic [ref=e22]: buy milk
    - listitem [ref=e27]:
      - link "All" [ref=e28]:
        - /url: "#/"
`;

describe("expandRef：名字与文字", () => {
  const idx = indexRaw(TODO_RAW, "https://demo.playwright.dev");

  test("listitem 不借子孙的名字（只写角色）", () => {
    expect(expandRef(idx, "e19")).toBe("e19 listitem");
  });

  test("容器有自己的文字就追加，不带引号", () => {
    expect(expandRef(idx, "e22")).toBe("e22 generic: buy milk");
  });

  test("heading 带自己的名字；textbox 带标记", () => {
    expect(expandRef(idx, "e7")).toBe(`e7 heading "todos" [level=1]`);
    expect(expandRef(idx, "e8")).toBe(
      `e8 textbox "What needs to be done?" [active]`,
    );
  });

  test("没有 [ref] 的空壳 generic 不是索引目标（编号在机械层里已去掉）", () => {
    expect(expandRef(idx, "e1")).toBe("e1 generic");
  });

  test("编号不存在返回 null", () => {
    expect(expandRef(idx, "e999")).toBeNull();
  });
});

describe("expandRef：借子孙的名字", () => {
  const raw = `- link [ref=e5]:
  - paragraph [ref=e6]:
    - text: How Not to Build a Music Player
  - /url: /s/wbkayq
- button [ref=e8]
- link "Docs" [ref=e9]:
  - /url: /docs
`;
  const idx = indexRaw(raw, "https://lobste.rs");

  test("link 名字为空时借第一个有名字 / 有文字的子孙", () => {
    expect(expandRef(idx, "e5")).toBe(
      `e5 link "How Not to Build a Music Player" → /s/wbkayq`,
    );
  });

  test("既没名字也没文字写 (unnamed)", () => {
    expect(expandRef(idx, "e8")).toBe("e8 button (unnamed)");
  });

  test("自己的名字不给引号以外的加工", () => {
    expect(expandRef(idx, "e9")).toBe(`e9 link "Docs" → /docs`);
  });
});

describe("expandRef：表单控件的值与状态", () => {
  const raw = `- textbox "Username or email address" [ref=e25]: demo-user
- checkbox "Remember me" [checked] [ref=e9]
- button "Old" [disabled] [ref=e10]
- textbox "Note" [ref=e11]: ${"x".repeat(150)}
`;
  const idx = indexRaw(raw, "https://github.com");

  test("值用引号写在末尾，状态标记原样带上", () => {
    expect(expandRef(idx, "e25")).toBe(
      `e25 textbox "Username or email address": "demo-user"`,
    );
    expect(expandRef(idx, "e9")).toBe(`e9 checkbox "Remember me" [checked]`);
    expect(expandRef(idx, "e10")).toBe(`e10 button "Old" [disabled]`);
  });

  test("像数字的值（引擎写成引号串）只套一层引号", () => {
    const idx2 = indexRaw(
      `- spinbutton "Count" [ref=e3]: "7"\n`,
      "https://a.test",
    );
    expect(expandRef(idx2, "e3")).toBe(`e3 spinbutton "Count": "7"`);
  });

  test("过长的值截到 120 字符再加 …", () => {
    expect(expandRef(idx, "e11")).toBe(
      `e11 textbox "Note": "${"x".repeat(120)}…"`,
    );
  });
});

describe("expandRef：容器的名字与文字", () => {
  const raw = `- table "List of countries" [ref=e236]:
  - caption [ref=e237]: 表标题
  - rowgroup [ref=e238]:
    - row [ref=e239]:
      - columnheader "Country" [ref=e240]
      - cell "8,021,407,192" [ref=e258]
- list "Tags" [ref=e300]
`;
  const idx = indexRaw(raw, "https://en.wikipedia.org");

  test("容器只写角色与自己的文字（名字不算、也不借子孙的）", () => {
    expect(expandRef(idx, "e237")).toBe("e237 caption: 表标题");
    expect(expandRef(idx, "e240")).toBe("e240 columnheader");
    expect(expandRef(idx, "e258")).toBe("e258 cell");
  });

  test("没有文字也没有名字的容器只写角色", () => {
    expect(expandRef(idx, "e238")).toBe("e238 rowgroup");
    expect(expandRef(idx, "e239")).toBe("e239 row");
  });
});

describe("expandRef：B1a 的真实夹具", () => {
  const fixture = (name: string): string =>
    readFileSync(
      new URL(`./__fixtures__/${name}.txt`, import.meta.url),
      "utf8",
    );

  test("github 登录页：控件、标记、同源地址改写", () => {
    const idx = indexRaw(fixture("github-login"), "https://github.com");
    expect(expandRef(idx, "e25")).toBe(
      `e25 textbox "Username or email address" [active]`,
    );
    expect(expandRef(idx, "e31")).toBe(`e31 button "Sign in"`);
    expect(expandRef(idx, "e45")).toBe("e45 paragraph: New to GitHub?");
    expect(expandRef(idx, "e46")).toBe(
      `e46 link "Create an account" → /signup?source=login`,
    );
    expect(expandRef(idx, "e55")).toBe(
      `e55 link "Terms" → https://docs.github.com/site-policy/github-terms/github-terms-of-service`,
    );
  });

  test("lobsters 列表：无名链接借子孙的名字（少数派的标题在段落里）", () => {
    const idx = indexRaw(fixture("lobsters-list"), "https://lobste.rs");
    expect(expandRef(idx, "e10")).toBe(`e10 link "Active" → /active`);
    expect(expandRef(idx, "e27")).toBe(
      `e27 link "How Not to Build a Music Player" → https://alichraghi.github.io/blog/how-not-to-build-a-music-player`,
    );
    // 容器不写名字（地名、列表名不是页面正文），只写角色与自己的文字。
    expect(expandRef(idx, "e7")).toBe("e7 navigation");
    expect(expandRef(idx, "e8")).toBe("e8 list");
  });

  test("wikipedia 表格：容器不借子孙的名字", () => {
    const idx = indexRaw(
      fixture("wikipedia-table"),
      "https://en.wikipedia.org",
    );
    expect(expandRef(idx, "e238")).toBe("e238 rowgroup");
    expect(expandRef(idx, "e243")).toBe("e243 columnheader: Change(%)");
    expect(expandRef(idx, "e237")).toBe(
      "e237 caption: List of countries and inhabited territories by total population. United Nations",
    );
  });
});

describe("expandRef：图片的地址", () => {
  const raw = `- main [ref=e1]:
  - img "图 3" [ref=e9]:
    - /src: https://lobste.rs/a/3.jpg
  - img "占位图" [ref=e10]:
    - /src: data:image/gif (43 chars)
  - img "没有地址" [ref=e11]
`;
  const idx = indexRaw(raw, "https://lobste.rs");

  test("/src 子行展开成 `→ 地址`，同源写成根相对", () => {
    expect(expandRef(idx, "e9")).toBe(`e9 img "图 3" → /a/3.jpg`);
  });

  test("data: 地址按快照里的样子原样展开；没有地址的 img 不带 →", () => {
    expect(expandRef(idx, "e10")).toBe(
      `e10 img "占位图" → data:image/gif (43 chars)`,
    );
    expect(expandRef(idx, "e11")).toBe(`e11 img "没有地址"`);
  });
});

describe("expandRef：同源地址改写", () => {
  const idx = indexRaw(
    `- link "Terms" [ref=e55]:
  - /url: https://github.com/site-policy/terms
- link "Docs" [ref=e59]:
  - /url: https://docs.github.com
`,
    "https://github.com",
  );

  test("同源绝对地址写成根相对路径，别的域原样", () => {
    expect(expandRef(idx, "e55")).toBe(`e55 link "Terms" → /site-policy/terms`);
    expect(expandRef(idx, "e59")).toBe(
      `e59 link "Docs" → https://docs.github.com`,
    );
  });
});

describe("projectOverview", () => {
  const raw = `- banner [ref=e1]:
  - link "Active" [ref=e10]:
    - /url: https://lobste.rs/active
  - link "Recent" [ref=e12]:
    - /url: /recent
  - button "Login" [ref=e18]
- main [ref=e19]:
  - textbox "Search" [ref=e20]: jquery
  - paragraph [ref=e21]: 1 item left
  - link "Page 2" [ref=e22]:
    - /url: /page/2
`;
  const mech = mechOf(raw);
  const idx = indexRaw(raw, "https://lobste.rs");
  const p = (parts: unknown[], gist = "") =>
    ({ gist, parts }) as Parameters<typeof projectOverview>[0];

  test("机械层夹具就是投影的输入", () => {
    expect(mech).toBe(
      [
        `- banner [ref=e1]:`,
        `  - link "Active" [ref=e10] → /active`,
        `  - link "Recent" [ref=e12] → /recent`,
        `  - button "Login" [ref=e18]`,
        `- main [ref=e19]:`,
        `  - textbox "Search" [ref=e20]: jquery`,
        `  - paragraph [ref=e21]: 1 item left`,
        `  - link "Page 2" [ref=e22] → /page/2`,
      ].join("\n"),
    );
  });

  test("GIST + 各部分 + 逐字引用 + 取回游标 + 覆盖声明", () => {
    const out = projectOverview(
      p(
        [
          {
            caption: "Site header",
            lines: [1, 4],
            refs: ["e10", "e12"],
            quote: [[7, 7]],
          },
          {
            caption: "Story list (main feed)",
            lines: [5, 8],
            refs: ["e22"],
            quote: [],
          },
        ],
        "Lobsters: a tech news feed.",
      ),
      idx,
      mech,
    );
    expect(out.text).toBe(
      [
        `GIST (model-written, navigation only): Lobsters: a tech news feed.`,
        `[1] Site header · L1-4`,
        `  e10 link "Active" → /active`,
        `  e12 link "Recent" → /recent`,
        `  L7| - paragraph [ref=e21]: 1 item left`,
        `  … more in L1-4`,
        `[2] Story list (main feed) · L5-8`,
        `  e22 link "Page 2" → /page/2`,
        `  … more in L5-8`,
      ].join("\n"),
    );
    expect(out.invalid).toBe(0);
  });

  test("没有 part 时只有 GIST 与一条 UNDESCRIBED", () => {
    expect(projectOverview(p([], "只有一句话"), idx, mech).text).toBe(
      [
        `GIST (model-written, navigation only): 只有一句话`,
        `UNDESCRIBED: L1-8 (5 interactive elements)`,
      ].join("\n"),
    );
  });

  test("lines 先交换再夹到 [1, 总行数]", () => {
    const out = projectOverview(
      p([{ caption: "A", lines: [99, 5], refs: ["e10"], quote: [] }]),
      idx,
      mech,
    );
    expect(out.text).toBe(
      [
        `[1] A · L5-8`,
        `  e10 link "Active" → /active`,
        `  … more in L5-8`,
        `UNDESCRIBED: L1-4 (3 interactive elements)`,
      ].join("\n"),
    );
  });

  test("无效编号丢弃并计数，重复编号只出现一次且不算无效", () => {
    const out = projectOverview(
      p([
        {
          caption: "A",
          lines: [1, 8],
          refs: ["e10", "e999", "e10", "e12"],
          quote: [],
        },
        { caption: "B", lines: [1, 8], refs: ["e12", "e404"], quote: [] },
      ]),
      idx,
      mech,
    );
    expect(out.invalid).toBe(2);
    expect(out.text).toBe(
      [
        `[1] A · L1-8`,
        `  e10 link "Active" → /active`,
        `  e12 link "Recent" → /recent`,
        `  … more in L1-8`,
        `[2] B · L1-8`,
        `  … more in L1-8`,
        `NOTE: 2 invalid pointers dropped`,
      ].join("\n"),
    );
  });

  test("每部分至多 refsPerPartMax 个代表元素，多的忽略（不算无效）", () => {
    const refs = Array.from(
      { length: CLEAN_LIMITS.refsPerPartMax + 3 },
      (_, i) => `e${30 + i}`,
    );
    const many = `- main [ref=e1]:\n${refs
      .map((r, i) => `  - button "B${i}" [ref=${r}]`)
      .join("\n")}\n`;
    const out = projectOverview(
      p([{ caption: "A", lines: [1, 1], refs, quote: [] }]),
      indexRaw(many, "https://lobste.rs"),
      mechOf(many),
    );
    expect(out.invalid).toBe(0);
    expect(
      out.text.split("\n").filter((l) => l.startsWith("  e")),
    ).toHaveLength(CLEAN_LIMITS.refsPerPartMax);
  });

  test("gist 与 caption 截断加 …", () => {
    const out = projectOverview(
      p(
        [
          {
            caption: "c".repeat(CLEAN_LIMITS.captionMaxChars + 5),
            lines: [1, 8],
            refs: [],
            quote: [],
          },
        ],
        "g".repeat(CLEAN_LIMITS.gistMaxChars + 5),
      ),
      idx,
      mech,
    );
    expect(out.text.split("\n")[0]).toBe(
      `GIST (model-written, navigation only): ${"g".repeat(CLEAN_LIMITS.gistMaxChars - 1)}…`,
    );
    expect(out.text.split("\n")[1]).toBe(
      `[1] ${"c".repeat(CLEAN_LIMITS.captionMaxChars - 1)}… · L1-8`,
    );
  });

  test("至多 partsMax 个部分（多的整段忽略）", () => {
    const parts = Array.from({ length: CLEAN_LIMITS.partsMax + 2 }, () => ({
      caption: "A",
      lines: [1, 8] as [number, number],
      refs: [],
      quote: [],
    }));
    const out = projectOverview(p(parts), idx, mech);
    expect(out.text).not.toContain(`[${CLEAN_LIMITS.partsMax + 1}]`);
  });
});

describe("projectOverview：覆盖声明", () => {
  const raw = `- main [ref=e1]:
  - link "A" [ref=e2]:
    - /url: /a
  - paragraph [ref=e3]: x
  - button "B" [ref=e4]
  - button "C" [ref=e5]
`;
  const idx = indexRaw(raw, "https://lobste.rs");
  const mech = mechOf(raw);

  test("没覆盖的行段各报一段，交互元素数按角色算", () => {
    const out = projectOverview(
      {
        gist: "",
        parts: [{ caption: "A", lines: [3, 3], refs: [], quote: [] }],
      },
      idx,
      mech,
    );
    expect(out.text).toBe(
      [
        `[1] A · L3-3`,
        `  … more in L3-3`,
        `UNDESCRIBED: L1-2 (1 interactive elements), L4-5 (2 interactive elements)`,
      ].join("\n"),
    );
  });

  test("区间重叠也算覆盖，相邻段合并成一条", () => {
    const out = projectOverview(
      {
        gist: "",
        parts: [
          { caption: "A", lines: [1, 3], refs: [], quote: [] },
          { caption: "B", lines: [2, 5], refs: [], quote: [] },
        ],
      },
      idx,
      mech,
    );
    expect(out.text).not.toContain("UNDESCRIBED");
  });

  test("一个区间整个包在另一个里面：后一个不把覆盖位置拉回去", () => {
    const out = projectOverview(
      {
        gist: "",
        parts: [
          { caption: "A", lines: [1, 5], refs: [], quote: [] },
          { caption: "B", lines: [2, 3], refs: [], quote: [] },
        ],
      },
      idx,
      mech,
    );
    expect(out.text).not.toContain("UNDESCRIBED");
  });
});

describe("projectOverview：逐字引用", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `- text: line ${i + 1}`);
  const mech = lines.join("\n");

  test("按行号原样输出并去掉缩进；超过 quoteMaxLines 的部分声明截断", () => {
    const out = projectOverview(
      {
        gist: "",
        parts: [
          {
            caption: "A",
            lines: [1, 60],
            refs: [],
            quote: [
              [2, 3],
              [5, 60],
            ],
          },
        ],
      },
      indexRaw("", "https://lobste.rs"),
      mech,
    );
    const rows = out.text.split("\n");
    expect(rows.slice(0, 6)).toEqual([
      `[1] A · L1-60`,
      `  L2| - text: line 2`,
      `  L3| - text: line 3`,
      `  L5| - text: line 5`,
      `  L6| - text: line 6`,
      `  L7| - text: line 7`,
    ]);
    // 40 行额度用完：2 行（L2-3）+ 38 行（L5-42），剩下 L43-60 共 18 行声明截断。
    expect(rows.filter((l) => /^ {2}L\d+\| /.test(l))).toHaveLength(40);
    expect(rows).toContain(`  … quote truncated (18 more lines)`);
    expect(rows).toContain(`  … more in L1-60`);
  });
});

describe("projectOverview：引用行数与单行截断", () => {
  test("总量至多 quoteMaxLines 行，单行超过 quoteLineChars 截断", () => {
    const max = CLEAN_LIMITS.quoteLineChars;
    const first = `- text: ${"y".repeat(max + 40)}`;
    const mech = [
      first,
      ...Array.from(
        { length: CLEAN_LIMITS.quoteMaxLines + 10 },
        (_, i) => `- text: q${i}`,
      ),
    ].join("\n");
    const out = projectOverview(
      {
        gist: "",
        parts: [
          {
            caption: "A",
            lines: [1, 1],
            refs: [],
            quote: [[1, mech.split("\n").length]],
          },
        ],
      },
      indexRaw("", "https://lobste.rs"),
      mech,
    );
    const rows = out.text.split("\n");
    expect(rows[1]).toBe(`  L1| ${first.slice(0, max)} …(+48 chars)`);
    const quoteRows = rows.filter((l) => /^ {2}L\d+\| /.test(l));
    expect(quoteRows).toHaveLength(CLEAN_LIMITS.quoteMaxLines);
    expect(rows).toContain(`  … quote truncated (11 more lines)`);
  });
});

describe("projectIntent", () => {
  const raw = `- main [ref=e1]:
  - textbox "Username or email address" [ref=e25]
  - textbox "Password" [ref=e28]
  - button "Sign in" [ref=e31]
`;
  const idx = indexRaw(raw, "https://github.com");

  test("每个分组各一行，组间空一行；编号去重", () => {
    const out = projectIntent(
      {
        groups: [{ refs: ["e25", "e28"] }, { refs: ["e31", "e25", "e404"] }],
        unresolved: "",
      },
      idx,
      "找到登录所需的输入框和提交按钮",
    );
    expect(out.text).toBe(
      [
        `INTENT: 找到登录所需的输入框和提交按钮`,
        `  e25 textbox "Username or email address"`,
        `  e28 textbox "Password"`,
        ``,
        `  e31 button "Sign in"`,
        `NOTE: 1 invalid pointers dropped`,
      ].join("\n"),
    );
    expect(out.invalid).toBe(1);
  });

  test("没有有效元素时写 (no matching elements found)，仍写 UNRESOLVED", () => {
    const out = projectIntent(
      { groups: [{ refs: ["e404"] }], unresolved: "没有验证码框" },
      idx,
      "找验证码",
    );
    expect(out.text).toBe(
      [
        `INTENT: 找验证码`,
        `  (no matching elements found)`,
        `UNRESOLVED (model-written): 没有验证码框`,
        `NOTE: 1 invalid pointers dropped`,
      ].join("\n"),
    );
  });

  test("没有分组也没有 unresolved 时只有 INTENT 与「没有匹配」", () => {
    expect(
      projectIntent({ groups: [], unresolved: "" }, idx, "找按钮").text,
    ).toBe([`INTENT: 找按钮`, `  (no matching elements found)`].join("\n"));
  });

  test("intent 与 unresolved 截到上限", () => {
    const long = "i".repeat(CLEAN_LIMITS.gistMaxChars + 3);
    const out = projectIntent({ groups: [], unresolved: long }, idx, long);
    expect(out.text).toBe(
      [
        `INTENT: ${"i".repeat(CLEAN_LIMITS.gistMaxChars - 1)}…`,
        `  (no matching elements found)`,
        `UNRESOLVED (model-written): ${"i".repeat(CLEAN_LIMITS.gistMaxChars - 1)}…`,
      ].join("\n"),
    );
  });
});
