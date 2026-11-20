import { describe, expect, test } from "vitest";
import { fitDiff, renderDiff } from "./diff-render.js";
import { diffElements } from "./elemdiff.js";

const raw = (...lines: string[]): string => lines.join("\n");

/** 只取行（多数用例只看文法）。 */
const lines = (before: string, after: string, origin = ""): string[] =>
  renderDiff(diffElements(before, after), origin).lines;

describe("透明容器", () => {
  test("generic 没有自己条目：不写头行、也不增加缩进", () => {
    const before = raw(`- generic [ref=e1]:`, `  - text: A`);
    const after = raw(
      `- generic [ref=e1]:`,
      `  - text: A`,
      `  - generic [ref=e2]:`,
      `    - text: B`,
    );
    // 中间那层 generic 是透明的：`text: B` 与 `text: A` 同一层
    expect(lines(before, after)).toEqual([`+ text: B`]);
  });

  test("其它纯容器要打印头行，子节点缩进一层", () => {
    const before = raw(`- main [ref=e1]:`);
    const after = raw(
      `- main [ref=e1]:`,
      `  - list [ref=e2]:`,
      `    - listitem [ref=e3]:`,
      `      - text: A`,
    );
    // 纯容器的头行带上子树里第一个有标签的条目（这里是 text "A"）
    expect(lines(before, after)).toEqual([
      `+ main "A"`,
      `  + list "A"`,
      `    + listitem "A"`,
      `      + text: A`,
    ]);
  });

  test("透明容器的变化也不写上下文行", () => {
    const before = raw(
      `- main [ref=e1]:`,
      `  - generic [ref=e2]:`,
      `    - text: A`,
    );
    const after = raw(
      `- main [ref=e1]:`,
      `  - generic [ref=e2]:`,
      `    - text: B`,
    );
    expect(lines(before, after)).toEqual([`~ text: A → B`]);
  });

  test("即使同层有好几个 generic，其中一个的变化也不写上下文行", () => {
    const before = raw(
      `- main [ref=e1]:`,
      `  - generic [ref=e2]:`,
      `    - text: A`,
      `  - generic [ref=e3]:`,
      `    - text: B`,
    );
    const after = raw(
      `- main [ref=e1]:`,
      `  - generic [ref=e2]:`,
      `    - text: A2`,
      `  - generic [ref=e3]:`,
      `    - text: B`,
    );
    expect(lines(before, after)).toEqual([`~ text: A → A2`]);
  });

  test("透明容器里包着块：照样算块级新增，给未变兄弟标位置", () => {
    const before = raw(`- main [ref=e1]:`, `  - text: A`);
    const after = raw(
      `- main [ref=e1]:`,
      `  - text: A`,
      `  - generic [ref=e2]:`,
      `    - list [ref=e3]:`,
      `      - listitem [ref=e4]: B`,
    );
    expect(lines(before, after)).toEqual([
      `= 1 unchanged (text "A")`,
      `+ list "B"`,
      `  + listitem: B`,
    ]);
  });
});

describe("上下文行 `@`", () => {
  /** 两条回答，只有第一条的按钮改名。 */
  const feed = (name: string): string =>
    raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - heading "回答 1" [ref=e3]`,
      `    - button "${name}" [ref=e9]`,
      `  - listitem [ref=e20]:`,
      `    - heading "回答 2" [ref=e21]`,
      `    - button "别的" [ref=e10]`,
    );

  test("同类兄弟里的某一个：写一行所在块的头，子树缩进一层", () => {
    expect(lines(feed("旧"), feed("新"))).toEqual([
      `@ listitem "回答 1"`,
      `  ~ e9 button "旧" → "新"`,
    ]);
  });

  test("同一层只有一个同角色节点：不写上下文行（没有「是哪一条」的问题）", () => {
    const before = raw(`- main [ref=e1]:`, `  - paragraph [ref=e2]: 旧`);
    const after = raw(`- main [ref=e1]:`, `  - paragraph [ref=e2]: 新`);
    expect(lines(before, after)).toEqual([`~ paragraph: 旧 → 新`]);
  });

  test("容器自己有变化时写 `~` 行，不写 `@`", () => {
    const before = raw(`- list [ref=e1]:`, `  - button "甲" [ref=e2]`);
    const after = raw(`- list [ref=e1]:`, `  - button "乙" [ref=e2]`);
    expect(lines(before, after)).toEqual([`~ e2 button "甲" → "乙"`]);
  });
});

describe("未变折叠行 `=`", () => {
  test("只有块级增删才写；N 是这一串的兄弟个数", () => {
    const before = raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - text: 一`,
      `  - listitem [ref=e3]:`,
      `    - text: 二`,
      `  - listitem [ref=e4]:`,
      `    - text: 三`,
    );
    const after = raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - text: 一`,
      `  - listitem [ref=e3]:`,
      `    - text: 二`,
      `  - listitem [ref=e4]:`,
      `    - text: 三`,
      `  - listitem [ref=e5]:`,
      `    - text: 四`,
    );
    expect(lines(before, after)).toEqual([
      `= 3 unchanged (listitem "一" … listitem "三")`,
      `+ listitem "四"`,
      `  + text: 四`,
    ]);
  });

  test("只有一个未变兄弟时写 `= 1 unchanged (<头>)`，不写尾", () => {
    const before = raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - text: 一`,
      `  - listitem [ref=e3]:`,
      `    - text: 二`,
    );
    const after = raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - text: 一`,
    );
    // 这一块只有一个条目，「有几个 element」不用另说
    expect(lines(before, after)).toEqual([
      `= 1 unchanged (listitem "一")`,
      `- listitem "二"`,
    ]);
  });

  test("叶子级的小改动不写 `=` 行", () => {
    const before = raw(
      `- list [ref=e1]:`,
      `  - button "甲" [ref=e2]`,
      `  - button "乙" [ref=e3]`,
    );
    const after = raw(
      `- list [ref=e1]:`,
      `  - button "甲" [ref=e2]`,
      `  - button "乙" [ref=e3]`,
      `  - button "丙" [ref=e4]`,
    );
    expect(lines(before, after)).toEqual([`+ e4 button "丙"`]);
  });
});

describe("相邻合并", () => {
  // 容器本身不变，只换里面的东西：容器不会当成新增块
  const withList = (...items: string[]): string =>
    raw(`- list [ref=e1]:`, `  - button "旧" [ref=e0]`, ...items);
  const btn = (name: string, ref: number): string =>
    `  - button "${name}" [ref=e${ref}]`;

  test("同缩进、同符号、同正文的相邻叶子行合成一行", () => {
    const before = withList();
    const after = withList(btn("重试", 2), btn("重试", 3), btn("重试", 4));
    expect(lines(before, after)).toEqual([`+ e2 button "重试" (×2 more)`]);
  });

  test("不相邻的不合并（中间隔了别的元素）", () => {
    const before = withList();
    const after = withList(btn("重试", 2), btn("取消", 3), btn("重试", 4));
    expect(lines(before, after)).toEqual([
      `+ e2 button "重试"`,
      `+ e3 button "取消"`,
      `+ e4 button "重试"`,
    ]);
  });

  test("整块消失的行不合并（(×N more) 会被当成元素个数）", () => {
    const item = (ref: number): string[] => [
      `    - listitem [ref=e${ref}]:`,
      `      - text: 一`,
    ];
    const before = raw(
      `- list [ref=e1]:`,
      `  - text: 保留`,
      ...item(10),
      ...item(20),
    );
    const after = raw(`- list [ref=e1]:`, `  - text: 保留`);
    // 两块各写一行（不合并），各自只有 1 个条目，不写 (N elements)
    expect(lines(before, after)).toEqual([
      `- listitem "一"`,
      `- listitem "一"`,
    ]);
  });

  test("块头即使同文也不合并（各自后面跟着自己的子树）", () => {
    const item = (ref: number): string[] => [
      `    - listitem [ref=e${ref}]:`,
      `      - text: 一`,
    ];
    const before = raw(
      `- main [ref=e1]:`,
      `  - list [ref=e2]:`,
      `    - listitem [ref=e5]:`,
      `      - text: 保留`,
    );
    const after = raw(
      `- main [ref=e1]:`,
      `  - list [ref=e2]:`,
      `    - listitem [ref=e5]:`,
      `      - text: 保留`,
      `  - list [ref=e3]:`,
      ...item(10),
      `  - list [ref=e4]:`,
      ...item(20),
    );
    expect(lines(before, after)).toEqual([
      `= 1 unchanged (list "保留")`,
      `+ list "一"`,
      `  + listitem "一"`,
      `    + text: 一`,
      `+ list "一"`,
      `  + listitem "一"`,
      `    + text: 一`,
    ]);
  });
});

describe("消失行", () => {
  test("叶子：只有名字与角色，不带编号", () => {
    const before = raw(
      `- list [ref=e1]:`,
      `  - button "保留" [ref=e3]`,
      `  - button "删除" [ref=e2]`,
    );
    const after = raw(`- list [ref=e1]:`, `  - button "保留" [ref=e3]`);
    expect(lines(before, after)).toEqual([`- button "删除"`]);
  });

  test("有子树：一行写完，尾巴写条目个数，不展开", () => {
    const before = raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - heading "回答 1" [ref=e3]`,
      `    - button "赞同 3" [ref=e4]`,
      `  - text: 保留`,
    );
    const after = raw(`- list [ref=e1]:`, `  - text: 保留`);
    expect(lines(before, after)).toEqual([
      `- listitem "回答 1" (2 elements)`,
      `= 1 unchanged (text "保留")`,
    ]);
  });
});

describe("计数", () => {
  test("added / removed 数子树条目，changed 数自己变化的 mod", () => {
    const before = raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - heading "回答 1" [ref=e3]`,
      `    - button "旧" [ref=e4]`,
      `  - listitem [ref=e5]:`,
      `    - text: 只会消失`,
    );
    const after = raw(
      `- list [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - heading "回答 1" [ref=e3]`,
      `    - button "新" [ref=e4]`,
      `  - listitem [ref=e6]:`,
      `    - text: 新来的`,
      `    - text: 第二条`,
    );
    expect(renderDiff(diffElements(before, after))).toMatchObject({
      added: 2,
      removed: 1,
      changed: 1,
    });
  });
});

describe("fitDiff", () => {
  test("放得下就全文，hidden 为 0", () => {
    expect(fitDiff(["ab", "cd"], 10)).toEqual({ text: "ab\ncd", hidden: 0 });
  });

  test("恰好等于预算：全给", () => {
    // "ab\ncd" 长度 5
    expect(fitDiff(["ab", "cd"], 5)).toEqual({ text: "ab\ncd", hidden: 0 });
  });

  test("超一行就截：换行符也算进预算", () => {
    expect(fitDiff(["ab", "cd"], 4)).toEqual({ text: "ab", hidden: 1 });
  });

  test("第一行自己就超预算：也给这一行", () => {
    expect(fitDiff(["a".repeat(50), "b"], 10)).toEqual({
      text: "a".repeat(50),
      hidden: 1,
    });
  });

  test("空列表：空正文、没有隐藏行", () => {
    expect(fitDiff([], 10)).toEqual({ text: "", hidden: 0 });
  });
});
