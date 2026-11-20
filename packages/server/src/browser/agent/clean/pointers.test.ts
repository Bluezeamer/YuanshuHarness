import { describe, expect, test } from "vitest";
import { parseIntent, parseOverview } from "./pointers.js";

const OVERVIEW = `{"gist":"Lobsters front page","parts":[{"caption":"Header","lines":[1,16],"refs":["e10","e12"],"quote":[[14,15]]}]}`;

describe("pointers：取 JSON 的容错", () => {
  test("``` 围栏", () => {
    expect(parseOverview(`\`\`\`json\n${OVERVIEW}\n\`\`\``)).toEqual({
      gist: "Lobsters front page",
      parts: [
        {
          caption: "Header",
          lines: [1, 16],
          refs: ["e10", "e12"],
          quote: [[14, 15]],
        },
      ],
    });
  });

  test("前后夹着说明文字", () => {
    expect(
      parseOverview(`好的，页面概览如下：\n${OVERVIEW}\n以上。`),
    ).not.toBeNull();
  });

  test("说明文字里的花括号不是 JSON，跳过找下一个", () => {
    expect(parseOverview(`格式是 {gist, parts}：\n${OVERVIEW}`)?.gist).toBe(
      "Lobsters front page",
    );
  });

  test("字符串里的花括号与转义引号不算结构", () => {
    const reply = `说明 {"gist":"他说 \\"用 {a} 包起来\\"","parts":[]} 结束`;
    expect(parseOverview(reply)).toEqual({
      gist: `他说 "用 {a} 包起来"`,
      parts: [],
    });
  });

  test("字符串里单个的花括号不配平也不算结构；转义引号之后的花括号仍在字符串里", () => {
    expect(parseOverview(`{"gist":"a } b","parts":[]}`)?.gist).toBe("a } b");
    expect(parseOverview(`{"gist":"a { b","parts":[]}`)?.gist).toBe("a { b");
    expect(parseOverview(`{"gist":"x\\" } y","parts":[]}`)?.gist).toBe(
      'x" } y',
    );
  });

  test("两个 JSON 连写时取第一个", () => {
    expect(parseOverview(`${OVERVIEW}\n${OVERVIEW}`)?.parts).toHaveLength(1);
  });

  test("没有 JSON、括号不配平、JSON 语法错都返回 null", () => {
    expect(parseOverview("没有 JSON")).toBeNull();
    expect(parseOverview(`{"parts":[]`)).toBeNull();
    expect(parseOverview(`{'parts': []}`)).toBeNull();
  });

  test("顶层不是对象返回 null", () => {
    expect(parseOverview(`["parts"]`)).toBeNull();
    expect(parseIntent(`"groups"`)).toBeNull();
    expect(parseOverview(`null`)).toBeNull();
  });

  test("parts / groups 不是数组返回 null", () => {
    expect(parseOverview(`{"gist":"x","parts":"none"}`)).toBeNull();
    expect(parseIntent(`{"groups":null}`)).toBeNull();
  });
});

describe("pointers：overview 的字段", () => {
  test("字段缺失按空值处理", () => {
    expect(parseOverview(`{"parts":[{"lines":[1,2]}]}`)).toEqual({
      gist: "",
      parts: [{ caption: "", lines: [1, 2], refs: [], quote: [] }],
    });
    // parts 不是数组（缺字段也算）就是形状不对。
    expect(parseOverview(`{}`)).toBeNull();
  });

  test("类型不对的元素丢掉，不抛错", () => {
    const reply = `{"gist":42,"parts":[{"caption":"A","lines":[1,2],"refs":["e1",7,"e2",null],"quote":[[1,2],[3],"x",[4,5,6]]}]}`;
    expect(parseOverview(reply)).toEqual({
      gist: "",
      parts: [
        { caption: "A", lines: [1, 2], refs: ["e1", "e2"], quote: [[1, 2]] },
      ],
    });
  });

  test("lines 不是两个整数的整个 part 丢掉（含小数、缺一个）", () => {
    const reply = `{"parts":[{"lines":[1]},{"lines":[1.5,2]},{"lines":["1","2"]},{"caption":"好","lines":[3,4]}]}`;
    expect(parseOverview(reply)?.parts).toEqual([
      { caption: "好", lines: [3, 4], refs: [], quote: [] },
    ]);
  });

  test("parts 里不是对象的条目丢掉", () => {
    const reply = `{"parts":[1,"x",null,{"lines":[1,2]}]}`;
    expect(parseOverview(reply)?.parts).toHaveLength(1);
  });

  test("不在这里截断长度", () => {
    const long = "x".repeat(500);
    expect(parseOverview(`{"gist":"${long}","parts":[]}`)?.gist).toBe(long);
  });
});

describe("pointers：intent 的字段", () => {
  test("分组与 unresolved", () => {
    expect(
      parseIntent(
        `\`\`\`\n{"groups":[{"refs":["e25","e28"]},{"refs":["e31"]}],"unresolved":"找不到验证码框"}\n\`\`\``,
      ),
    ).toEqual({
      groups: [{ refs: ["e25", "e28"] }, { refs: ["e31"] }],
      unresolved: "找不到验证码框",
    });
  });

  test("字段缺失与类型不对", () => {
    expect(
      parseIntent(`{"groups":[{},{"refs":"e1"},{"refs":["e1",2]}]}`),
    ).toEqual({
      groups: [{ refs: [] }, { refs: [] }, { refs: ["e1"] }],
      unresolved: "",
    });
  });
});
