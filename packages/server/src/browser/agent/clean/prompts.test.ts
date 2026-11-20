import { describe, expect, test } from "vitest";
import {
  INTENT_SYSTEM,
  intentUser,
  OVERVIEW_SYSTEM,
  overviewUser,
  readerTask,
} from "./prompts.js";

const MECH = '1| - main:\n2|   - link "Home" [ref=e1] → /home';

/** 提示词里不该留下任何 `<…>` 占位符。 */
const noPlaceholder = (text: string): void => {
  expect(text).not.toMatch(/<[^>\n]*>/);
};

describe("系统提示词", () => {
  test("原样给出（不调工具、只回一个 JSON、值是指针）", () => {
    expect(OVERVIEW_SYSTEM).toContain(
      "You reply with ONE JSON object and nothing else",
    );
    expect(OVERVIEW_SYSTEM).toContain("do not copy or paraphrase page text");
    expect(INTENT_SYSTEM).toContain(
      "Every value you output must be a pointer into the snapshot",
    );
    expect(INTENT_SYSTEM).toContain("any text you invent is discarded");
    expect(OVERVIEW_SYSTEM).not.toBe(INTENT_SYSTEM);
  });

  test("系统提示词里没有占位符", () => {
    noPlaceholder(OVERVIEW_SYSTEM);
    noPlaceholder(INTENT_SYSTEM);
  });
});

describe("用户消息", () => {
  test("overview：快照头 + 带行号的快照 + TASK 块", () => {
    const text = overviewUser(MECH, 2);
    const head = text.split("\n")[0] as string;
    expect(head).toBe(
      'SNAPSHOT (2 lines; each line starts with its line number and "|"; element refs look like eN; "→" precedes a link target or an image source; a {eN} after a link in a prose line is that link\'s ref):',
    );
    expect(text).toContain(
      `\n${MECH}\n\nTASK: describe this page for that reader.\n`,
    );
    expect(text).toContain("The snapshot has 2 lines.");
    expect(text).toContain('"parts":[{"caption"');
    // 只有 <N> 是代码要填的占位符；schema 里示范用的尖括号原样留着。
    expect(text).not.toContain("<N>");
  });

  test("overview：行数填进快照头与任务块两处，没有残留的 <N>", () => {
    const text = overviewUser(MECH, 554);
    expect(text).toContain("SNAPSHOT (554 lines;");
    expect(text).toContain("The snapshot has 554 lines.");
    expect(text).toContain("between 1 and 554.");
    expect(text).not.toContain("<N>");
  });

  test("intent：INTENT 行与 INTENT 任务块", () => {
    const text = intentUser(MECH, 48, "找到登录所需的输入框和提交按钮");
    expect(text).toContain("INTENT: 找到登录所需的输入框和提交按钮\n");
    expect(text).toContain(
      '"groups":[{"refs":["e27","e41"]}], "unresolved":""',
    );
    expect(text).toContain("The snapshot has 48 lines.");
    expect(text).not.toContain("TASK: describe this page");
    expect(text).not.toMatch(/<intent>/);
  });

  test("同一份快照：overview 与 intent 的正文前缀相同，任务块不同", () => {
    const a = overviewUser(MECH, 2);
    const b = intentUser(MECH, 2, "找登录");
    const [aHead, aRest] = a.split("\n\nTASK: ");
    const [bHead] = b.split("\n\nINTENT: ");
    expect(aHead).toBe(bHead);
    expect(aRest).toBeTruthy();
  });
});

describe("readerTask", () => {
  const base = {
    fileMarker: "[attach_file] attachment:/x.txt",
    totalLines: 1486,
    structure: '    1| - heading "标题"',
  };

  test("文件标记、行数、结构视图、交付方式都在；overview 用的任务块", () => {
    const text = readerTask({ ...base, intent: null });
    expect(text).toContain(`PAGE TEXT FILE: ${base.fileMarker}`);
    expect(text).toContain("The file has 1486 lines.");
    expect(text).toContain(`STRUCTURE VIEW:\n${base.structure}`);
    expect(text).toContain("TASK: describe this page for that reader.");
    expect(text).toContain('When done, call deliver once: summary = "done"');
    expect(text).toContain("report = the JSON document only.");
  });

  test("intent 非空时用 intent 的任务块；空串也算通览", () => {
    expect(readerTask({ ...base, intent: "找前三条标题" })).toContain(
      "INTENT: 找前三条标题\n",
    );
    expect(readerTask({ ...base, intent: "" })).toContain(
      "TASK: describe this page for that reader.",
    );
  });
});
