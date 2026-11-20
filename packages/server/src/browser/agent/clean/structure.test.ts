import { describe, expect, test } from "vitest";
import { CLEAN_LIMITS } from "./limits.js";
import { numberLines, structureView } from "./structure.js";

describe("numberLines", () => {
  test("行号从 1 开始，右对齐到总行数的位数", () => {
    expect(numberLines("one\ntwo")).toBe("1| one\n2| two");
    expect(numberLines("a\nb\nc")).toBe("1| a\n2| b\n3| c");
  });

  test("空行也是行", () => {
    expect(numberLines("a\n\nc")).toBe("1| a\n2| \n3| c");
  });

  test("末尾换行不多算一行（行号与文件里的行一致）", () => {
    expect(numberLines("a\nb\n")).toBe("1| a\n2| b");
  });

  test("与文件里的第 n 行一致", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    // 12 行 → 行号占两位，与 `-n` 按行取的结果一致。
    expect(numberLines(text).split("\n")[10]).toBe("11| line 11");
  });
});

describe("structureView", () => {
  const mech = [
    "- banner [ref=e1]:",
    '  - link "Home" [ref=e2] → /',
    '- heading "Title" [level=1] [ref=e3]',
    "  - text: 副标题",
    "- paragraph [ref=e4]: 第一段正文。",
    "- paragraph [ref=e5]: 第二段正文，不列。",
    '- heading "Part" [level=2] [ref=e6]',
    "  - listitem [ref=e7]: 没有段落的一段",
    "- paragraph [ref=e8]: Part 的第一段。",
  ].join("\n");

  test("标题整行保留；每段只留第一条 paragraph；其余写成声明", () => {
    expect(structureView(mech)).toBe(
      [
        "      … L1–2（2 行未列出）",
        '    3| - heading "Title" [level=1] [ref=e3]',
        "      … L4–4（1 行未列出）",
        "    5| - paragraph [ref=e4]: 第一段正文。",
        "      … L6–6（1 行未列出）",
        '    7| - heading "Part" [level=2] [ref=e6]',
        "      … L8–8（1 行未列出）",
        "    9| - paragraph [ref=e8]: Part 的第一段。",
      ].join("\n"),
    );
  });

  test("标题段里没有 paragraph 时整段是一条声明（行号是全页行号）", () => {
    expect(structureView('- heading "A" [level=1]\n- text: x')).toBe(
      '    1| - heading "A" [level=1]\n      … L2–2（1 行未列出）',
    );
  });

  test("行截到 structureLineChars，超出写 …(+N)", () => {
    const head = "- paragraph [ref=e1]: ";
    const room = CLEAN_LIMITS.structureLineChars - head.length;
    const exact = `${head}${"x".repeat(room)}`;
    expect(structureView(exact)).toBe(`    1| ${exact}`);
    const longer = `${head}${"x".repeat(room)}0123456789`;
    expect(structureView(longer)).toBe(`    1| ${exact} …(+10)`);
  });

  test("超过 maxChars 时先去掉 paragraph 行，相邻声明合并成一条", () => {
    const out = structureView(mech, { maxChars: 200 });
    expect(out).toBe(
      [
        "      … L1–2（2 行未列出）",
        '    3| - heading "Title" [level=1] [ref=e3]',
        "      … L4–6（3 行未列出）",
        '    7| - heading "Part" [level=2] [ref=e6]',
        "      … L8–9（2 行未列出）",
      ].join("\n"),
    );
  });

  test("仍超限时从尾部按整行截断并声明", () => {
    const out = structureView(mech, { maxChars: 60 });
    expect(out).toBe(
      [
        "      … L1–2（2 行未列出）",
        "      … 结构视图在 L2 处截断（其余部分请用搜索）",
      ].join("\n"),
    );
    expect(out.length).toBeLessThanOrEqual(60);
  });

  test("连一条都放不下时只留截断声明", () => {
    expect(structureView(mech, { maxChars: 10 })).toBe(
      "      … 结构视图在 L0 处截断（其余部分请用搜索）",
    );
  });
});
