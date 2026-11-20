// 仅测试用：建一批用户来源的夹具卡（分组「测试」、可编辑），供预设相关的测试引用。
import type { PromptCard, PromptCardStore } from "../store/prompt-cards.js";

const card = (
  id: string,
  title: string,
  body: string,
): Omit<PromptCard, "createdAt" | "updatedAt"> => ({
  id,
  group: "测试",
  title,
  body,
  builtin: false,
  origin: "user",
  copyOf: null,
});

export function addFixtureCards(cards: PromptCardStore): void {
  for (const c of [
    card("t-lang", "语言", "所有说明、注释与回复统一使用中文。"),
    card(
      "t-style",
      "代码风格",
      "改动保持最小，匹配现有风格；不顺手重构无关部分；发现死代码只提不改。",
    ),
    card(
      "t-deps",
      "依赖管理",
      "Python 依赖统一走 uv；临时脚本用 PEP 723 内联依赖，不污染宿主机环境。",
    ),
    card(
      "t-report",
      "完成汇报",
      "- 完成后用几句话说清做了什么、验证了什么、还有什么没验证。",
    ),
    card(
      "t-mode-review",
      "审阅要求",
      "只做评审：指出问题与风险，给出修改建议，不直接改代码。",
    ),
  ])
    cards.create(c);
}
