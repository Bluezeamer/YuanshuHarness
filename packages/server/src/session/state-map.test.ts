import { describe, expect, test } from "vitest";
import {
  lineDiff,
  renderNotice,
  type StateMapping,
  sameState,
  skillsListedIn,
  withListedSkills,
} from "./state-map.js";

const base = (over: Partial<StateMapping> = {}): StateMapping => ({
  tools: ["bash", "call_tool", "read"],
  prompt: { identity: "You are X", rules: "a\nb" },
  mode: null,
  ...over,
});
const def = (name: string) => ({
  name,
  description: `${name} desc`,
  parameters: { type: "object" },
});

describe("状态比较与通知", () => {
  test("没有差异：相同、不通知", () => {
    expect(sameState(base(), base())).toBe(true);
    expect(renderNotice(base(), base(), new Set(), def)).toBeNull();
  });

  test("新增技能：给名字、描述和 SKILL.md 路径；改了描述与移除各一句；旧状态没有这一栏按空算", () => {
    const next = base({
      skills: { "ub-mode": "Follow the reduced principles", other: "d" },
    });
    expect(sameState(base(), next)).toBe(false);
    const text =
      renderNotice(
        base(),
        next,
        new Set(),
        def,
        (n) => `/h/.agents/skills/yuanshu/${n}/SKILL.md`,
      ) ?? "";
    expect(text).toContain("New skills are available");
    expect(text).toContain("- ub-mode: Follow the reduced principles");
    expect(text).toContain(
      "SKILL.md: /h/.agents/skills/yuanshu/ub-mode/SKILL.md",
    );
    // 没有路径（拿不到环境）时只给名字与描述，不编路径
    expect(renderNotice(base(), next, new Set(), def) ?? "").not.toContain(
      "SKILL.md:",
    );
    // 描述变了、技能没了
    const later = base({ skills: { "ub-mode": "Changed", other2: "x" } });
    const t2 = renderNotice(next, later, new Set(), def) ?? "";
    expect(t2).toContain("Skill descriptions changed:");
    expect(t2).toContain("- ub-mode: Changed");
    expect(t2).toContain("Skills no longer available: other.");
    // 同样的技能不通知；没有 skills 栏的旧状态与空技能等价（不会对所有旧会话刷一条空通知）
    expect(renderNotice(next, next, new Set(), def)).toBeNull();
    expect(sameState(base(), base({ skills: {} }))).toBe(true);
    // 长描述截断
    const long = base({ skills: { big: "x".repeat(500) } });
    expect(
      (renderNotice(base(), long, new Set(), def) ?? "").length,
    ).toBeLessThan(600);
  });

  test("旧冻结物没有 skills 栏：按开头消息里 <available_skills> 列过的补上，只对真正新增的技能通知", () => {
    const head = {
      role: "system",
      content: `intro <name>not-a-skill</name>\n<available_skills>\n  <skill>\n    <name>ub-mode</name>\n    <description>d</description>\n  </skill>\n</available_skills>\ntail <name>also-not</name>`,
    };
    const now = { "ub-mode": "d now", fresh: "new one" };
    expect(skillsListedIn(head, now)).toEqual({ "ub-mode": "d now" });
    expect(
      skillsListedIn({ role: "system", content: "no skills" }, now),
    ).toEqual({});
    const next = base({ skills: now });
    const prev = withListedSkills(base(), head, next);
    const text = renderNotice(prev, next, new Set(), def) ?? "";
    expect(text).toContain("- fresh: new one");
    expect(text).not.toContain("- ub-mode");
    // 带 skills 栏的新状态原样用，不再去猜
    const modern = base({ skills: {} });
    expect(withListedSkills(modern, head, next)).toBe(modern);
  });

  test("新增工具：给完整定义并说明走 call_tool；已声明过的只报名字", () => {
    const next = base({
      tools: ["bash", "call_tool", "grep", "read", "write"],
    });
    const text = renderNotice(base(), next, new Set(["write"]), def) ?? "";
    expect(text).toContain("call_tool");
    expect(text).toContain("- grep: grep desc");
    expect(text).toContain('"type":"object"');
    expect(text).toContain("Tools available again: write.");
    expect(text).not.toContain("- write: write desc");
  });

  test("移除工具：给名字", () => {
    const text =
      renderNotice(
        base(),
        base({ tools: ["call_tool", "read"] }),
        new Set(),
        def,
      ) ?? "";
    expect(text).toContain("Tools no longer available: bash.");
  });

  test("提示词段：新增 / 删除 / 修改给行级差异", () => {
    const next = base({
      prompt: { identity: "You are X", rules: "a\nc", env: "linux" },
    });
    const text = renderNotice(base(), next, new Set(), def) ?? "";
    expect(text).toContain("Prompt section <rules> changed:\n- b\n+ c");
    expect(text).toContain("Prompt section <env> was added:\nlinux");
    const gone = base({ prompt: { identity: "You are X" } });
    expect(renderNotice(base(), gone, new Set(), def)).toContain(
      "Prompt section <rules> was removed.",
    );
  });

  test("进入模式：设定与 user 通道文本并入同一条，随带工具变化", () => {
    const mode = {
      id: "m",
      name: "Plan",
      text: "Only plan.",
      userText: "Ask first.",
    };
    const next = base({ mode, tools: ["call_tool", "read"] });
    const text = renderNotice(base(), next, new Set(), def) ?? "";
    expect(text).toContain('You entered mode "Plan".');
    expect(text).toContain("Only plan.");
    expect(text).toContain("Ask first.");
    expect(text).toContain("Tools no longer available: bash.");
  });

  test("退出与切换", () => {
    const a = { id: "a", name: "A", text: "", userText: "" };
    const b = { id: "b", name: "B", text: "B text", userText: "" };
    expect(renderNotice(base({ mode: a }), base(), new Set(), def)).toContain(
      'You left mode "A"',
    );
    const sw = renderNotice(
      base({ mode: a }),
      base({ mode: b }),
      new Set(),
      def,
    );
    expect(sw).toContain('You left mode "A" and entered mode "B".');
    expect(sw).toContain("B text");
  });

  test("模式文本改了也算状态变化", () => {
    const a = { id: "a", name: "A", text: "v1", userText: "" };
    expect(
      sameState(base({ mode: a }), base({ mode: { ...a, text: "v2" } })),
    ).toBe(false);
  });
});

describe("lineDiff", () => {
  test("只列出删与增", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toBe("- b\n+ x");
    expect(lineDiff("a", "a")).toBe("");
  });
});
