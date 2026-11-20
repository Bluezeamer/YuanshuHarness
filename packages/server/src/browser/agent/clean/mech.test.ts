import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { mechanical } from "./mech.js";
import { nodeName, parseSnapshot, type SnapNode, splitLine } from "./parse.js";

const LOBS = "https://lobste.rs";
const WIKI = "https://en.wikipedia.org";
const GH = "https://github.com";

/** 机械层一行到底（输入里没有缩进时最好读）。 */
const mech = (raw: string, origin = LOBS): string => mechanical(raw, origin);

describe("机械层：可点元素上的游标", () => {
  const raw = `- link "Home" [ref=e1] [cursor=pointer]:
  - /url: /home
- columnheader "Country" [ref=e2] [cursor=pointer]
- generic "caches" [ref=e3] [cursor=pointer]`;

  test("link / button 上的 [cursor=pointer] 去掉，其余角色保留", () => {
    expect(mech(raw)).toBe(`- link "Home" [ref=e1] → /home
- columnheader "Country" [ref=e2] [cursor=pointer]
- generic "caches" [ref=e3] [cursor=pointer]`);
  });
});

describe("机械层：/url 子行并入链接行", () => {
  test("链接行写成 `→ 目标`，/url 不再是子节点", () => {
    expect(
      mech(
        `- main:\n  - link "Docs" [ref=e1] [cursor=pointer]:\n    - /url: /docs`,
      ),
    ).toBe(`- main:\n  - link "Docs" [ref=e1] → /docs`);
  });

  test("不是链接的节点上，/url 仍然原样当子行", () => {
    expect(mech(`- main:\n  - generic [ref=e1]:\n    - /url: /x`)).toBe(
      `- main:\n  - generic:\n    - /url: /x`,
    );
  });
});

describe("机械层：/src 子行并入 img 行", () => {
  test("块形式的 img 写成 `→ 地址`，/src 不再是子节点；同源写成根相对", () => {
    expect(
      mech(
        `- main:
  - img "甲" [ref=e5]:
    - /src: https://lobste.rs/a.png`,
      ),
    ).toBe(`- main:\n  - img "甲" [ref=e5] → /a.png`);
  });

  test("img 本来就有正文时与链接一致：`→ 地址: 正文`", () => {
    expect(mech(`- img "甲" [ref=e5]:\n  - /src: /a.png`)).toBe(
      `- img "甲" [ref=e5] → /a.png`,
    );
    expect(mech(`- img "甲" [ref=e5]: 说明`)).toBe(`- img "甲" [ref=e5]: 说明`);
  });

  test("没有 /src 的 img 输出一字不变", () => {
    const raw = `- main:\n  - img "甲" [ref=e5]`;
    expect(mech(raw)).toBe(raw);
  });

  test("行内形式带地址与编号：`![甲](/a.png){e5}`，没有编号就不写花括号", () => {
    expect(
      mech(
        `- paragraph [ref=e1]:
  - text: 看图
  - img "甲" [ref=e5]:
    - /src: https://lobste.rs/a.png`,
      ),
    ).toBe(`- paragraph [ref=e1]: 看图 ![甲](/a.png){e5}`);
    expect(
      mech(
        `- paragraph [ref=e1]:
  - text: 看图
  - img "甲":
    - /src: /a.png`,
      ),
    ).toBe(`- paragraph [ref=e1]: 看图 ![甲](/a.png)`);
  });

  test("行内形式的地址里有空格与括号时与行内链接写法一致（原样，不加转义）", () => {
    const raw = `- paragraph [ref=e1]:\n  - text: 看图\n  - img "甲" [ref=e5]:\n    - /src: /a b(1).png`;
    expect(mech(raw)).toBe(`- paragraph [ref=e1]: 看图 ![甲](/a b(1).png){e5}`);
  });
});

describe("机械层：同源地址写成根相对路径", () => {
  test("origin 开头的绝对地址变路径，别的域不动", () => {
    expect(
      mech(
        `- main:
  - link "A" [ref=e1] [cursor=pointer]:
    - /url: https://lobste.rs/a?x=1
  - link "B" [ref=e2] [cursor=pointer]:
    - /url: https://example.com/b`,
      ),
    ).toBe(`- main:
  - link "A" [ref=e1] → /a?x=1
  - link "B" [ref=e2] → https://example.com/b`);
  });

  test("只是前缀相同的域名不算同源（必须带 / 边界）", () => {
    expect(
      mech(
        `- main:
  - link "A" [ref=e1] [cursor=pointer]:
    - /url: https://lobste.rs.example/a
  - link "B" [ref=e2] [cursor=pointer]:
    - /url: https://lobste.rs`,
      ),
    ).toBe(`- main:
  - link "A" [ref=e1] → https://lobste.rs.example/a
  - link "B" [ref=e2] → https://lobste.rs`);
  });
});

describe("机械层：无名空壳 generic", () => {
  test("唯一子节点就地替换，自己的 [ref] 去掉", () => {
    expect(
      mech(
        `- main:\n  - generic [ref=e1]:\n    - link "Only" [ref=e2] [cursor=pointer]:\n      - /url: /only`,
      ),
    ).toBe(`- main:\n  - link "Only" [ref=e2] → /only`);
  });

  test("是父节点唯一孩子时，孩子上提（兄弟数为 0）", () => {
    expect(
      mech(
        `- main:
  - listitem [ref=e9]:
    - generic [ref=e1]:
      - link "A" [ref=e2] [cursor=pointer]:
        - /url: /a
      - link "B" [ref=e3] [cursor=pointer]:
        - /url: /b`,
      ),
    ).toBe(`- main:
  - listitem [ref=e9]:
    - link "A" [ref=e2] → /a
    - link "B" [ref=e3] → /b`);
  });

  test("有兄弟的多孩子空壳不压平（分组边界留着）", () => {
    expect(
      mech(
        `- main:
  - generic [ref=e1]:
    - link "Prev" [ref=e2] [cursor=pointer]:
      - /url: /p
    - generic [ref=e3]:
      - link "A" [ref=e4] [cursor=pointer]:
        - /url: /a
      - link "B" [ref=e5] [cursor=pointer]:
        - /url: /b`,
      ),
    ).toBe(`- main:
  - link "Prev" [ref=e2] → /p
  - generic:
    - link "A" [ref=e4] → /a
    - link "B" [ref=e5] → /b`);
  });

  test("无名无文字但可点（有游标）的 generic 不是空壳，原样保留", () => {
    expect(
      mech(
        `- main:
  - generic [ref=e1] [cursor=pointer]:
    - img "logo" [ref=e2]`,
      ),
    ).toBe(`- main:
  - generic [ref=e1] [cursor=pointer]:
    - img "logo" [ref=e2]`);
  });

  test("有名字、有文字或有游标的 generic 不是空壳，结构与编号都留着；空壳的编号去掉", () => {
    expect(
      mech(
        `- main:
  - generic "caches" [ref=e1] [cursor=pointer]
  - generic [ref=e2]: 有文字
  - listitem [ref=e3]:
    - generic [ref=e4]`,
      ),
    ).toBe(`- main:
  - generic "caches" [ref=e1] [cursor=pointer]
  - generic [ref=e2]: 有文字
  - listitem [ref=e3]:
    - generic`);
  });
});

describe("机械层：正文并成一行", () => {
  test("全行内的孩子并成一行，带链接 / 强调 / 代码 / 上标记号", () => {
    expect(
      mech(
        `- main:
  - paragraph [ref=e1]:
    - text: See
    - link "docs" [ref=e2] [cursor=pointer]:
      - /url: /docs
    - text: for
    - emphasis:
      - text: details
    - text: .
    - code:
      - text: npm i
    - superscript:
      - text: "1"`,
      ),
    ).toBe(`- main:
  - paragraph [ref=e1]: See [docs](/docs){e2} for *details* . \`npm i\` ^"1"`);
  });

  test("链接名里的方括号转义", () => {
    expect(
      mech(
        `- main:
  - paragraph [ref=e1]:
    - text: see
    - link "[1]" [ref=e2] [cursor=pointer]:
      - /url: "#cite"`,
      ),
    ).toBe(`- main:\n  - paragraph [ref=e1]: see [\\[1\\]]("#cite"){e2}`);
  });

  test("没有文字孩子的节点不并（只剩结构时留多行）", () => {
    expect(
      mech(
        `- main:\n  - paragraph [ref=e1]:\n    - button "Sign in" [ref=e2] [cursor=pointer]`,
      ),
    ).toBe(`- main:\n  - paragraph [ref=e1]:\n    - button "Sign in" [ref=e2]`);
  });

  test("带名字又带孩子的孩子节点不并（行内化会丢名字）", () => {
    expect(
      mech(
        `- main:
  - paragraph [ref=e1]:
    - text: before
    - strong "Title":
      - text: inside`,
      ),
    ).toBe(`- main:
  - paragraph [ref=e1]:
    - text: before
    - strong "Title": inside`);
  });

  test("time 不并", () => {
    expect(
      mech(
        `- main:
  - paragraph [ref=e1]:
    - text: at
    - time [ref=e2]: 19 hours ago`,
      ),
    ).toBe(`- main:
  - paragraph [ref=e1]:
    - text: at
    - time [ref=e2]: 19 hours ago`);
  });

  test("带标记（如 aria-hidden）的孩子不并", () => {
    expect(
      mech(
        `- main:
  - paragraph [ref=e1]:
    - text: before
    - generic [aria-hidden] [ref=e3]: secret`,
      ),
    ).toBe(`- main:
  - paragraph [ref=e1]:
    - text: before
    - generic [aria-hidden] [ref=e3]: secret`);
  });

  test("空壳 generic 的整段行内内容写成一行 text", () => {
    expect(
      mech(
        `- main:
  - generic [ref=e1]:
    - text: 作者
    - link "alice" [ref=e2] [cursor=pointer]:
      - /url: /~alice`,
      ),
    ).toBe(`- main:\n  - text: 作者 [alice](/~alice){e2}`);
  });
});

describe("机械层：原样保留的部分", () => {
  test("状态标记、rowgroup 与表格结构、time、其余编号", () => {
    expect(
      mech(
        `- main:
  - checkbox "Remember" [checked] [ref=e1]
  - button "Hidden" [disabled] [ref=e2]
  - table [ref=e3]:
    - rowgroup [ref=e4]:
      - row [ref=e5]:
        - cell [ref=e6]: x
  - time [ref=e7]: now`,
      ),
    ).toBe(`- main:
  - checkbox "Remember" [checked] [ref=e1]
  - button "Hidden" [disabled] [ref=e2]
  - table [ref=e3]:
    - rowgroup [ref=e4]:
      - row [ref=e5]:
        - cell [ref=e6]: x
  - time [ref=e7]: now`);
  });

  test("有孩子但没文字的节点保留结尾冒号，正文原样", () => {
    expect(
      mech(
        `- main:
  - heading [level=2] [ref=e10]:
    - link "T" [ref=e11] [cursor=pointer]:
      - /url: /t
  - alert [ref=e12]: 出错了`,
      ),
    ).toBe(`- main:
  - heading [level=2] [ref=e10]:
    - link "T" [ref=e11] → /t
  - alert [ref=e12]: 出错了`);
  });
});

describe("机械层：真实片段", () => {
  const fixture = (name: string): string =>
    readFileSync(
      new URL(`./__fixtures__/${name}.txt`, import.meta.url),
      "utf8",
    );

  const bodyOf = (n: SnapNode): string => splitLine(n.text).body;
  const flat = (nodes: SnapNode[]): SnapNode[] =>
    nodes.flatMap((n) => [n, ...flat(n.children)]);

  /** 无损断言用的一组事实：文字、名字、链接目标、编号，以及「允许随行内合并一起消失的编号」。 */
  function facts(raw: string, origin: string) {
    const text = (s: string): string => s.replace(/\s+/g, " ").trim();
    const nodes = flat(parseSnapshot(raw));
    return {
      nodes,
      texts: nodes
        .filter((n) => n.role === "text")
        .map((n) => text(bodyOf(n)))
        .filter(Boolean),
      names: nodes.map((n) => text(nodeName(n))).filter(Boolean),
      urls: nodes
        .filter((n) => n.role === "/url")
        .map((n) => text(bodyOf(n)))
        .map((u) => (u.startsWith(`${origin}/`) ? u.slice(origin.length) : u)),
    };
  }

  /** 行内合并会把非链接节点的编号（上下标、强调、图片…）压掉，链接的编号写在 `{eN}` 里。 */
  const INLINE_LOST = new Set([
    "generic",
    "superscript",
    "subscript",
    "emphasis",
    "strong",
    "code",
    "mark",
    "deletion",
    "insertion",
    "abbr",
    "img",
    "time",
  ]);

  const cases = [
    ["lobsters-list", LOBS],
    ["wikipedia-article", WIKI],
    ["github-login", GH],
    ["wikipedia-table", WIKI],
  ] as const;

  for (const [name, origin] of cases) {
    test(`${name}: 文字、名字、链接目标都还在，输出更短`, () => {
      const raw = fixture(name);
      const out = mech(raw, origin);
      const f = facts(raw, origin);
      // 行内链接名里的方括号在输出里是转义过的。
      const hay = out.replace(/\\([[\]])/g, "$1").replace(/\s+/g, " ");
      for (const t of f.texts) expect(hay).toContain(t);
      for (const n of f.names) expect(hay).toContain(n);
      for (const u of f.urls) expect(hay).toContain(u);
      // 编号：交互角色与其余结构角色都留着；行内合并压掉的非链接节点除外。
      for (const n of f.nodes) {
        if (n.ref === null || INLINE_LOST.has(n.role)) continue;
        expect(out).toMatch(new RegExp(`ref=${n.ref}\\]|\\{${n.ref}\\}`));
      }
      expect(out.length).toBeLessThan(raw.length);
    });
  }

  test("lobsters 列表：链接目标与编号齐全", () => {
    const out = mech(fixture("lobsters-list"), LOBS);
    expect(out).toContain(
      `- link "How Not to Build a Music Player" [ref=e27] → https://alichraghi.github.io/blog/how-not-to-build-a-music-player`,
    );
    expect(out).toContain(`- link "Tag person" [ref=e30] → /t/person:`);
    expect(out).toMatch(/generic \[aria-hidden\] \[ref=e\d+\]: Lobsters/);
  });

  test("wikipedia 正文段：整段并成一行，引用编号留着", () => {
    const out = mech(fixture("wikipedia-article"), WIKI);
    expect(out.split("\n")[0]).toContain(
      `- paragraph [ref=e429]: A large language model (LLM) is a [machine learning model](/wiki/Machine_learning#Models){e430}`,
    );
    expect(out).toContain(`^[\\[1\\]]("#cite_note-few-shot-learners-1"){e435}`);
  });

  test("github 登录表单：控件与状态原样", () => {
    const out = mech(fixture("github-login"), GH);
    expect(out).toContain(
      `- textbox "Username or email address" [active] [ref=e25]`,
    );
    expect(out).toContain(`- button "Sign in" [ref=e31]`);
    expect(out).toContain(
      `- paragraph [ref=e45]: New to GitHub? [Create an account](/signup?source=login){e46}`,
    );
  });

  test("wikipedia 表格：rowgroup 与列头结构保留", () => {
    const out = mech(fixture("wikipedia-table"), WIKI);
    expect(out).toContain(`- rowgroup [ref=e238]:`);
    expect(out).toContain(
      `- columnheader "Change (%)" [ref=e243] [cursor=pointer]: Change(%)`,
    );
    expect(out).toContain(`- cell "8,021,407,192" [ref=e258]`);
  });
});
