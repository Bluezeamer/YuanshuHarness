import { describe, expect, test } from "vitest";
import { renderDiff } from "./diff-render.js";
import { buildTree, type DNode } from "./diff-tree.js";
import {
  diffElements,
  type ElemDiff,
  isUnchanged,
  type Op,
} from "./elemdiff.js";

/** 一份最小的原始快照：缩进两级一层，编号照引擎的样子写。 */
const raw = (...lines: string[]): string => lines.join("\n");

const shown = (before: string, after: string, origin = ""): string =>
  renderDiff(diffElements(before, after), origin).lines.join("\n");

const counts = (d: ElemDiff) => {
  const r = renderDiff(d);
  return { added: r.added, removed: r.removed, changed: r.changed };
};

/** 前序条目 key（整棵子树）。 */
const preorder = (n: DNode, out: string[]): void => {
  if (n.item !== null) out.push(n.item.key);
  for (const c of n.children) preorder(c, out);
};

/**
 * 重建不变量：把 ops 还原成两侧的条目 key 序列。
 * same 的 nodes 两边共用（没变就是自己的 key 与对面一样）。
 */
const flatten = (ops: Op[], side: "before" | "after"): string[] => {
  const out: string[] = [];
  const walk = (list: Op[]): void => {
    for (const op of list) {
      if (op.kind === "same") {
        for (const n of op.nodes) preorder(n, out);
      } else if (op.kind === "add") {
        if (side === "after") preorder(op.node, out);
      } else if (op.kind === "del") {
        if (side === "before") preorder(op.node, out);
      } else {
        const own = side === "after" ? op.own?.after : op.own?.before;
        if (own) out.push(own.key);
        walk(op.kids);
      }
    }
  };
  walk(ops);
  return out;
};

/** 两侧都还原得回来才算自洽。 */
const expectRebuild = (before: string, after: string): void => {
  const d = diffElements(before, after);
  const keys = (raw: string): string[] => {
    const out: string[] = [];
    for (const n of buildTree(raw)) preorder(n, out);
    return out;
  };
  expect(flatten(d.ops, "before")).toEqual(keys(before));
  expect(flatten(d.ops, "after")).toEqual(keys(after));
};

describe("elemdiff：登录填错点 Sign in", () => {
  const before = raw(
    `- main [ref=e1]:`,
    `  - textbox "Username or email address" [active] [ref=e25]`,
    `  - textbox "Password" [ref=e28]`,
    `  - button "Sign in" [ref=e31]`,
  );
  const after = raw(
    `- main [ref=e1]:`,
    `  - button "Dismiss this message" [active] [ref=f1e25]`,
    `  - alert [ref=f1e28]: Incorrect username or password.`,
    `  - textbox "Username or email address" [ref=f1e33]: demo-user`,
    `  - textbox "Password" [ref=f1e36]`,
    `  - button "Sign in" [ref=f1e39]`,
  );

  test("新增关闭按钮与 alert，用户名框的值变化；编号整体变了也不算新增", () => {
    const d = diffElements(before, after);
    expect(isUnchanged(d)).toBe(false);
    expect(shown(before, after)).toBe(
      [
        `+ f1e25 button "Dismiss this message"`,
        `+ alert: Incorrect username or password.`,
        `~ f1e33 textbox "Username or email address": "" → "demo-user"`,
      ].join("\n"),
    );
  });

  test("重建不变量", () => {
    expectRebuild(before, after);
  });
});

describe("elemdiff：待办页添加一项", () => {
  const before = raw(
    `- generic [ref=e6]:`,
    `  - heading "todos" [level=1] [ref=e7]`,
    `  - textbox "What needs to be done?" [active] [ref=e8]`,
  );
  const after = raw(
    `- generic [ref=e6]:`,
    `  - heading "todos" [level=1] [ref=e7]`,
    `  - textbox "What needs to be done?" [active] [ref=e8]`,
    `  - checkbox "❯Mark all as complete" [ref=e16]`,
    `  - generic [ref=e17]: ❯Mark all as complete`,
    `  - list [ref=e18]:`,
    `    - listitem [ref=e19]:`,
    `      - checkbox "Toggle Todo" [ref=e21]`,
    `      - generic [ref=e22]: buy milk`,
    `  - generic [ref=e23]:`,
    `    - generic [ref=e24]:`,
    `      - strong [ref=e25]: "1"`,
    `      - text: item left`,
  );

  test("有文字的 generic 也算元素（`generic: buy milk`）；新增的列表带块头与缩进", () => {
    expect(shown(before, after)).toBe(
      [
        // 这一层有块级新增，未变的两项标出位置
        `= 2 unchanged (heading "todos" … textbox "What needs to be done?")`,
        `+ e16 checkbox "❯Mark all as complete"`,
        `+ generic: ❯Mark all as complete`,
        `+ list "Toggle Todo"`,
        `  + listitem "Toggle Todo"`,
        `    + e21 checkbox "Toggle Todo"`,
        `    + generic: buy milk`,
        `+ strong: "1"`,
        `+ text: item left`,
      ].join("\n"),
    );
  });

  test("重建不变量", () => {
    expectRebuild(before, after);
  });
});

describe("elemdiff：短文字的重排", () => {
  const before = raw(`- text: A`, `- text: B`);

  test("「A」「B」两列互换：一块消失、同一块在新位置新增，不报重排", () => {
    const d = diffElements(before, raw(`- text: B`, `- text: A`));
    expect(isUnchanged(d)).toBe(false);
    expect(counts(d)).toEqual({ added: 1, removed: 1, changed: 0 });
    expect(shown(before, raw(`- text: B`, `- text: A`))).toBe(
      [`- text: A`, `+ text: A`].join("\n"),
    );
  });

  test("顺序没变、只是在中间插了一条", () => {
    const after = raw(`- text: A`, `- text: X`, `- text: B`);
    expect(shown(before, after)).toBe(`+ text: X`);
    expectRebuild(before, after);
  });

  test("纯标点与空白的文字不参与比较", () => {
    const after = raw(`- text: ·`, `- text: —`);
    expect(isUnchanged(diffElements(raw(`- text: ·`), after))).toBe(true);
  });
});

describe("elemdiff：菜单展开", () => {
  const links = Array.from(
    { length: 15 },
    (_, i) =>
      `  - link "Tool ${i + 1}" [ref=e${100 + i}]:\n    - /url: /wiki/tool-${i + 1}`,
  );
  const before = raw(
    `- main [ref=e1]:`,
    `  - button "Tools" [ref=e2] [expanded]`,
  );
  const after = raw(
    `- main [ref=e1]:`,
    `  - button "Tools" [ref=e2] [expanded]`,
    ...links,
  );

  test("新增的 15 个链接各一行，带编号与目标", () => {
    const r = renderDiff(diffElements(before, after));
    expect(r.added).toBe(15);
    expect(r.lines[0]).toBe(`+ e100 link "Tool 1" → /wiki/tool-1`);
    expect(r.lines).toHaveLength(15);
  });

  test("没有新增的元素时，[expanded] 从无到有只算状态变化", () => {
    expect(
      shown(raw(`- main [ref=e1]:`, `  - button "Tools" [ref=e2]`), before),
    ).toBe(`~ e2 button "Tools" [-] → [expanded]`);
  });

  test("重建不变量", () => {
    expectRebuild(before, after);
  });
});

describe("elemdiff：同名重复项", () => {
  const before = raw(`- list [ref=e1]:`, `  - button "Delete" [ref=e2]`);
  const after = raw(
    `- list [ref=e1]:`,
    `  - button "Delete" [ref=e2]`,
    `  - button "Delete" [ref=e3]`,
    `  - button "Delete" [ref=e4]`,
    `  - button "Delete" [ref=e5]`,
  );

  test("相邻的同名新增合成一行，末尾写多出来的个数", () => {
    expect(shown(before, after)).toBe(`+ e3 button "Delete" (×2 more)`);
    expectRebuild(before, after);
  });
});

describe("elemdiff：编号整体变化、内容不变", () => {
  const before = raw(
    `- link "Home" [ref=e1]:`,
    `  - /url: /`,
    `- checkbox "Remember me" [checked] [ref=e2]`,
    `- paragraph [ref=e3]: hello`,
  );
  const after = raw(
    `- link "Home" [ref=f9e1]:`,
    `  - /url: /`,
    `- checkbox "Remember me" [checked] [ref=f9e2]`,
    `- paragraph [ref=f9e3]: hello`,
  );

  test("isUnchanged 为真，渲染为空", () => {
    expect(isUnchanged(diffElements(before, after))).toBe(true);
    expect(shown(before, after)).toBe("");
  });
});

describe("elemdiff：状态与值", () => {
  test("复选框的勾选态变化写成 `[-] → [checked]`", () => {
    expect(
      shown(
        raw(`- checkbox "Remember me" [ref=e9]`),
        raw(`- checkbox "Remember me" [checked] [ref=e9]`),
      ),
    ).toBe(`~ e9 checkbox "Remember me" [-] → [checked]`);
  });

  test("值的比较只针对表单控件：链接行尾的文字不是值", () => {
    expect(
      isUnchanged(
        diffElements(
          raw(`- link "Tag person" [ref=e30]: person`),
          raw(`- link "Tag person" [ref=e30]: something else`),
        ),
      ),
    ).toBe(true);
  });

  test("值过长时截断并写补了多少字符", () => {
    const long = "x".repeat(260);
    expect(
      shown(
        raw(`- textbox "Note" [ref=e1]`),
        raw(`- textbox "Note" [ref=e1]: ${long}`),
      ),
    ).toBe(`~ e1 textbox "Note": "" → "${"x".repeat(200)}…(+60 chars)"`);
  });
});

describe("elemdiff：链接只改查询串", () => {
  test("路径相同不算新增 / 消失（查询串与片段不进身份），但目标变了要报", () => {
    const after = raw(
      `- link "Create an account" [ref=e2]:`,
      `  - /url: /signup?return_to=x&source=login#top`,
    );
    const d = diffElements(
      raw(
        `- link "Create an account" [ref=e1]:`,
        `  - /url: /signup?source=login`,
      ),
      after,
    );
    expect(counts(d)).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(
      shown(
        raw(
          `- link "Create an account" [ref=e1]:`,
          `  - /url: /signup?source=login`,
        ),
        after,
      ),
    ).toBe(
      `~ e2 link "Create an account" → /signup?return_to=x&source=login#top (was /signup?source=login)`,
    );
  });

  test("目标一字不差、只是编号变了：不算变化", () => {
    expect(
      isUnchanged(
        diffElements(
          raw(`- link "Next" [ref=e1]:`, `  - /url: /list?page=2`),
          raw(`- link "Next" [ref=e9]:`, `  - /url: /list?page=2`),
        ),
      ),
    ).toBe(true);
  });

  test("路径变了：同一位置的一对按「配上了」写一行变化，不报消失 + 新增", () => {
    expect(
      shown(
        raw(`- link "Docs" [ref=e1]:`, `  - /url: /docs`),
        raw(`- link "Docs" [ref=e2]:`, `  - /url: /docs/v2`),
      ),
    ).toBe(`~ e2 link "Docs" → /docs/v2 (was /docs)`);
  });
});

describe("elemdiff：无名控件的名字", () => {
  const before = raw(`- main [ref=e1]:`);

  test("没有名字就借第一个有名字的子孙，再退到第一段文字", () => {
    const after = raw(
      `- main [ref=e1]:`,
      `  - link [ref=e5]:`,
      `    - paragraph [ref=e6]:`,
      `      - text: How Not to Build a Music Player`,
      `    - /url: /s/x`,
    );
    expect(shown(before, after)).toBe(
      [
        `+ main "How Not to Build a Music Player"`,
        `  + e5 link "How Not to Build a Music Player" → /s/x`,
        `    + paragraph "How Not to Build a Music Player"`,
        `      + text: How Not to Build a Music Player`,
      ].join("\n"),
    );
    expectRebuild(before, after);
  });

  test("既没名字也没文字写空串", () => {
    expect(shown(before, raw(`- main [ref=e1]:`, `  - button [ref=e5]`))).toBe(
      [`+ main`, `  + e5 button ""`].join("\n"),
    );
  });
});

describe("elemdiff：数字类控件的值", () => {
  // 引擎把像数字的值写成引号串（`: "0"`），diff 里不能再套一层引号。
  test('滑块拖动：值写成 "0" → "4"，不是转义套转义', () => {
    expect(
      shown(
        raw(`- slider "进度" [ref=e1]: "0"`),
        raw(`- slider "进度" [ref=e1]: "4"`),
      ),
    ).toBe(`~ e1 slider "进度": "0" → "4"`);
  });
});

describe("elemdiff：图片地址", () => {
  const GIF = "data:image/gif (43 chars)";
  const pic = (ref: string, alt: string, src: string | null): string =>
    src === null
      ? `  - img "${alt}" [ref=${ref}]`
      : `  - img "${alt}" [ref=${ref}]:\n    - /src: ${src}`;
  const page = (...lines: string[]): string =>
    [`- main [ref=e1]:`, ...lines].join("\n");

  test("带地址的 img 才是 diff 条目：新增一行带编号", () => {
    const after = page(pic("e9", "图 3", "/a/3.jpg"));
    expect(shown(page(), after)).toBe(
      [`+ main "图 3"`, `  + e9 img "图 3" → /a/3.jpg`].join("\n"),
    );
    expectRebuild(page(), after);
  });

  test("占位图换成真图：地址变化一行，`was` 后面是旧地址；同源写成根相对", () => {
    const before = page(pic("e9", "图 3", GIF));
    const after = page(pic("e9", "图 3", "https://shop.test/a/3.jpg"));
    expect(shown(before, after, "https://shop.test")).toBe(
      `~ e9 img "图 3" → /a/3.jpg (was ${GIF})`,
    );
    expectRebuild(before, after);
  });

  test("地址变了但名字没变，不报「消失 + 新增」", () => {
    const d = diffElements(
      page(pic("e9", "图 3", "/a/1.jpg")),
      page(pic("e10", "图 3", "/a/2.jpg")),
    );
    expect(counts(d)).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  test("编号变了、地址没变不算变化", () => {
    expect(
      isUnchanged(
        diffElements(
          page(pic("e9", "图 3", "/a/3.jpg")),
          page(pic("e42", "图 3", "/a/3.jpg")),
        ),
      ),
    ).toBe(true);
  });

  test("消失：只写那一行（块级对齐按块报，不展开子树，也不带已经作废的编号）", () => {
    expect(shown(page(pic("e9", "图 3", "/a/3.jpg")), page())).toBe(
      `- main "图 3"`,
    );
  });

  test("没有地址的 img 仍不算条目", () => {
    expect(
      isUnchanged(
        diffElements(
          page(pic("e9", "图 3", null)),
          page(pic("e9", "图 3", null), `  - img "图 4"`),
        ),
      ),
    ).toBe(true);
  });

  test("同名的重复项沿用 (×N more)", () => {
    const after = page(
      pic("e9", "图 3", "/a/3.jpg"),
      pic("e10", "图 3", "/a/3.jpg"),
      pic("e11", "图 3", "/a/3.jpg"),
    );
    expect(shown(page(), after)).toBe(
      [`+ main "图 3"`, `  + e9 img "图 3" → /a/3.jpg (×2 more)`].join("\n"),
    );
  });

  test("地址过长时两边都截断", () => {
    const long = (n: string): string => `/${n.repeat(260)}.jpg`;
    const was = long("a");
    const now = long("b");
    expect(
      shown(page(pic("e9", "图 3", was)), page(pic("e9", "图 3", now))),
    ).toBe(
      `~ e9 img "图 3" → ${now.slice(0, 200)}…(+65 chars) (was ${was.slice(0, 200)}…(+65 chars))`,
    );
  });

  test("无名图片：同一位置换地址按「配上了」写一行变化，`was` 后面是旧地址", () => {
    const before = page(pic("e9", "", GIF));
    const after = page(pic("e9", "", "https://shop.test/a/3.jpg"));
    const d = diffElements(before, after);
    expect(counts(d)).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(shown(before, after, "https://shop.test")).toBe(
      `~ e9 img "" → /a/3.jpg (was ${GIF})`,
    );
  });

  test("无名图片在前面插入新的：已有的不被误报成变化", () => {
    expect(
      shown(
        page(pic("e9", "", "/a/1.jpg"), pic("e10", "", "/a/2.jpg")),
        page(
          pic("e8", "", "/a/0.jpg"),
          pic("e9", "", "/a/1.jpg"),
          pic("e10", "", "/a/2.jpg"),
        ),
      ),
    ).toBe(`+ e8 img "" → /a/0.jpg`);
  });
});

// ── 信息流：每条回答 = listitem{ heading、link、paragraph、button 赞同 N、button 展开阅读全文、link 评论 } ──

interface Answer {
  /** 第几条回答（写进标签，也是本轮测试的编号依据） */
  i: number;
  /** 赞同数 */
  agree: number;
  /** 这一条用的编号基数（同一个回答在两份快照里要一样） */
  base: number;
}

/** 一条回答的编号：每 10 个号一段，留出空间让「新回答的编号区间」与旧回答不同。 */
const baseOf = (i: number): number => 100 + i * 10;

function answer(a: Answer): string {
  const b = a.base;
  return [
    `    - listitem [ref=e${b}]:`,
    `      - heading "回答 ${a.i}" [level=2] [ref=e${b + 1}]`,
    `      - link "回答 ${a.i} 的标题" [ref=e${b + 2}]:`,
    `        - /url: /question/${a.i}/answer/${a.i}`,
    `      - paragraph [ref=e${b + 3}]: 这是第 ${a.i} 条回答的正文`,
    `      - button "赞同 ${a.agree}" [ref=e${b + 4}]`,
    `      - button "展开阅读全文" [ref=e${b + 5}]`,
    `      - link "${a.i * 3} 条评论" [ref=e${b + 6}]:`,
    `        - /url: /question/${a.i}/answer/${a.i}/comments`,
  ].join("\n");
}

const feed = (items: Answer[]): string =>
  [`- main [ref=e1]:`, `  - list [ref=e2]:`, ...items.map(answer)].join("\n");

/** 第 1..n 条（或从 from 起连续 n 条），编号按 10 递增；赞同数跟着序号走，删一条不会连带别的。 */
const answers = (n: number, from = 1, base = baseOf): Answer[] =>
  Array.from({ length: n }, (_, k) => ({
    i: from + k,
    agree: 1000 + from + k,
    base: base(from + k),
  }));

describe("elemdiff：信息流滚动追加", () => {
  for (const add of [5, 10, 80]) {
    test(`追加 ${add} 条：一行未变折叠 + 新增块（每块一头行 + 缩进的叶子）`, () => {
      const before = feed(answers(10));
      // 后面追加的用另一段编号，模拟重绘后引擎重新发号
      const after = feed([
        ...answers(10),
        ...answers(add, 11, (i) => 5000 + i * 10),
      ]);
      const r = renderDiff(diffElements(before, after));
      expect(r.lines[0]).toBe(
        `= 10 unchanged (listitem "回答 1" … listitem "回答 10")`,
      );
      // 每条新增：一行块头 + 6 行缩进的叶子
      expect(r.lines).toHaveLength(1 + add * 7);
      expect(
        r.lines.slice(1).every((l) => l.trimStart().startsWith("+ ")),
      ).toBe(true);
      expect(r.added).toBe(add * 6);
      expect(r.removed).toBe(0);
      // 不再有「交给辅助模型 / 阅读 agent」的痕迹
      expect(r.lines.join("\n")).not.toMatch(/FULL|SNAPSHOT|full diff/);
      expectRebuild(before, after);
    });
  }
});

describe("elemdiff：信息流顶部插入一条", () => {
  const before = feed(answers(10));
  const newOne: Answer = { i: 0, agree: 999, base: 9000 };
  const after = feed([newOne, ...answers(10)]);

  test("新增块里「展开阅读全文」的编号是新回答自己的，未变折叠行在新增块后面", () => {
    const r = renderDiff(diffElements(before, after));
    expect(r.lines).toEqual([
      `+ listitem "回答 0"`,
      `  + heading: 回答 0`,
      `  + e9002 link "回答 0 的标题" → /question/0/answer/0`,
      `  + paragraph: 这是第 0 条回答的正文`,
      `  + e9004 button "赞同 999"`,
      `  + e9005 button "展开阅读全文"`,
      `  + e9006 link "0 条评论" → /question/0/answer/0/comments`,
      `= 10 unchanged (listitem "回答 1" … listitem "回答 10")`,
    ]);
    // 旧回答的编号一个都没出现在新增块里
    const block = r.lines.slice(0, 7).join("\n");
    for (const old of answers(10)) {
      expect(block).not.toContain(`e${old.base}`);
      expect(block).not.toContain(`e${old.base + 5}`);
    }
    expectRebuild(before, after);
  });
});

describe("elemdiff：信息流中间插入一条", () => {
  const before = feed(answers(10));
  const after = feed([
    ...answers(5),
    { i: 99, agree: 1, base: 9000 },
    ...answers(5, 6),
  ]);

  test("插入点前面的未变块与后面的未变块各一行，新增块夹在中间", () => {
    const lines = renderDiff(diffElements(before, after)).lines;
    expect(lines[0]).toBe(
      `= 5 unchanged (listitem "回答 1" … listitem "回答 5")`,
    );
    expect(lines[1]).toBe(`+ listitem "回答 99"`);
    expect(lines.at(-1)).toBe(
      `= 5 unchanged (listitem "回答 6" … listitem "回答 10")`,
    );
    expect(counts(diffElements(before, after))).toEqual({
      added: 6,
      removed: 0,
      changed: 0,
    });
    expectRebuild(before, after);
  });
});

describe("elemdiff：信息流里一条回答的赞同数 +1", () => {
  test("写成一行变化，带所在块的上下文行，不是一删一增", () => {
    const list = answers(10);
    const before = feed(list);
    // 最后一条 +1：邻居的赞同数不会跟着撞上
    const after = feed(
      list.map((a) => (a.i === 10 ? { ...a, agree: 1011 } : a)),
    );
    expect(renderDiff(diffElements(before, after)).lines).toEqual([
      `@ listitem "回答 10"`,
      `  ~ e204 button "赞同 1010" → "赞同 1011"`,
    ]);
    expectRebuild(before, after);
  });

  test("与邻居的赞同数撞车（同名按钮）也只报这一条，不误判重排", () => {
    const list = answers(10);
    const before = feed(list);
    // 第 3 条 +1 之后与第 4 条同名；改的是第 3 条自己
    const after = feed(
      list.map((a) => (a.i === 3 ? { ...a, agree: 1004 } : a)),
    );
    const d = diffElements(before, after);
    expect(counts(d)).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(renderDiff(d).lines).toEqual([
      `@ listitem "回答 3"`,
      `  ~ e134 button "赞同 1003" → "赞同 1004"`,
    ]);
    expectRebuild(before, after);
  });
});

describe("elemdiff：信息流对调 / 整页打乱", () => {
  const before = feed(answers(10));

  test("对调两条：del + add，isUnchanged 为假，没有「重排」字样", () => {
    const list = answers(10);
    const [a, b] = [list[2], list[3]] as [Answer, Answer];
    const after = feed([...list.slice(0, 2), b, a, ...list.slice(4)]);
    const d = diffElements(before, after);
    expect(isUnchanged(d)).toBe(false);
    expect(counts(d)).toEqual({ added: 6, removed: 6, changed: 0 });
    const text = renderDiff(d).lines.join("\n");
    expect(text).toContain(`- listitem "回答 3" (6 elements)`);
    expect(text).toContain(`+ listitem "回答 3"`);
    expect(text).not.toMatch(/重排|reorder/i);
    expectRebuild(before, after);
  });

  test("整页顺序打乱：全部按块报增删，不抛错", () => {
    const list = answers(10);
    const after = feed([...list.slice(5), ...list.slice(0, 5)]);
    const d = diffElements(before, after);
    expect(isUnchanged(d)).toBe(false);
    const counts2 = counts(d);
    expect(counts2.added).toBeGreaterThan(0);
    expect(counts2.removed).toBeGreaterThan(0);
    expectRebuild(before, after);
  });
});

describe("elemdiff：信息流删掉一条回答", () => {
  test('一行 `- listitem "…" (6 elements)`，不展开子树', () => {
    const before = feed(answers(10));
    const after = feed(answers(9, 2));
    const r = renderDiff(diffElements(before, after));
    expect(r.lines).toEqual([
      `- listitem "回答 1" (6 elements)`,
      `= 9 unchanged (listitem "回答 2" … listitem "回答 10")`,
    ]);
    expect(r.removed).toBe(6);
    expectRebuild(before, after);
  });
});

describe("elemdiff：缺口个数不等", () => {
  test("同一个缺口里改一条又加两条：全部当 del + add，不猜配对", () => {
    const list = answers(10);
    const before = feed(list);
    const after = feed([
      ...list.slice(0, 3),
      // 改掉标题：这一块的签名变了，不再是对齐锚点
      { ...(list[3] as Answer), i: 44 },
      { i: 50, agree: 0, base: 9000 },
      { i: 51, agree: 0, base: 9500 },
      ...list.slice(4),
    ]);
    const r = renderDiff(diffElements(before, after));
    expect(r.lines).toContain(`- listitem "回答 4" (6 elements)`);
    expect(r.lines).toContain(`+ listitem "回答 44"`);
    expect(r.lines).toContain(`+ listitem "回答 50"`);
    expect(r.lines).toContain(`+ listitem "回答 51"`);
    // 改过的那条不是一行变化
    expect(r.lines.some((l) => l.startsWith("~"))).toBe(false);
    expect(r.removed).toBe(6);
    expect(r.added).toBe(18);
    expectRebuild(before, after);
  });
});

describe("elemdiff：缺口逐位置配对", () => {
  test("个数相等但角色不同的一对不配对：消失 + 新增，不写成一行变化", () => {
    const before = raw(`- main [ref=e1]:`, `  - button "A" [ref=e2]`);
    const after = raw(
      `- main [ref=e1]:`,
      `  - link "B" [ref=e2]:`,
      `    - /url: /b`,
    );
    expect(shown(before, after)).toBe(`- button "A"\n+ e2 link "B" → /b`);
    expectRebuild(before, after);
  });
});

describe("elemdiff：generic 包装层时有时无", () => {
  // 引擎的快照把只剩一个孩子的 generic 折叠掉：悬停菜单展开时按钮外多一层 generic，收起后没有
  const expanded = raw(
    `- generic [active] [ref=e1]:`,
    `  - generic [ref=e2]:`,
    `    - button "菜单" [ref=e3]`,
    `    - list [ref=e10]:`,
    `      - listitem [ref=e11]:`,
    `        - link "个人资料" [ref=e12]:`,
    `          - /url: /p1`,
    `  - paragraph [ref=e4]: 页面其余内容`,
  );
  const collapsed = raw(
    `- generic [active] [ref=e1]:`,
    `  - button "菜单" [ref=e3]`,
    `  - paragraph [ref=e4]: 页面其余内容`,
  );

  test("收起：只报列表消失，没变的按钮不被当成新增", () => {
    expect(shown(expanded, collapsed)).toBe(
      [
        `= 1 unchanged (button "菜单")`,
        `- list "个人资料"`,
        `= 1 unchanged (paragraph "页面其余内容")`,
      ].join("\n"),
    );
    expectRebuild(expanded, collapsed);
  });

  test("展开：只报新增的列表，按钮不被当成消失", () => {
    expect(shown(collapsed, expanded)).toBe(
      [
        `= 1 unchanged (button "菜单")`,
        `+ list "个人资料"`,
        `  + listitem "个人资料"`,
        `    + e12 link "个人资料" → /p1`,
        `= 1 unchanged (paragraph "页面其余内容")`,
      ].join("\n"),
    );
    expectRebuild(collapsed, expanded);
  });
});

describe("elemdiff：文字变了", () => {
  test("段落文字：`~ paragraph: 旧 → 新`", () => {
    const before = raw(`- main [ref=e1]:`, `  - paragraph [ref=e2]: 旧`);
    const after = raw(`- main [ref=e1]:`, `  - paragraph [ref=e2]: 新`);
    expect(shown(before, after)).toBe(`~ paragraph: 旧 → 新`);
    expectRebuild(before, after);
  });

  test('按钮改名：`~ e9 button "旧" → "新"`，在同类兄弟之间带上下文行', () => {
    const item = (name: string, note: string): string =>
      [
        `  - listitem [ref=e2]:`,
        `    - heading "回答 1" [ref=e3]`,
        `    - button "${name}" [ref=e9]`,
        `    - text: ${note}`,
      ].join("\n");
    const other = [
      `  - listitem [ref=e20]:`,
      `    - heading "回答 2" [ref=e21]`,
      `    - button "别的" [ref=e10]`,
      `    - text: 说明二`,
    ].join("\n");
    const before = raw(`- list [ref=e1]:`, item("旧", "说明一"), other);
    const after = raw(`- list [ref=e1]:`, item("新", "说明一"), other);
    expect(shown(before, after)).toBe(
      [`@ listitem "回答 1"`, `  ~ e9 button "旧" → "新"`].join("\n"),
    );
    expectRebuild(before, after);
  });
});

describe("elemdiff：LCS 的格子上限", () => {
  test("两个 3000 个兄弟、顺序打乱的列表：不卡、结果自洽", () => {
    const line = (n: number): string => `- text: item ${n}`;
    const before = Array.from({ length: 3000 }, (_, i) => line(i)).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => line(2999 - i)).join(
      "\n",
    );
    const started = performance.now();
    const d = diffElements(before, after);
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1000);
    expect(isUnchanged(d)).toBe(false);
    expectRebuild(before, after);
  });
});
