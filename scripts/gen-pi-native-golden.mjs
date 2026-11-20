#!/usr/bin/env node
// 生成 pi 原生的系统提示投影，作为对齐阶段的黄金样本。
//
// 为什么要跑 pi 自己的构建函数：我们的资产是从 pi 的输出里切出来的，如果只用资产
// 互相对比就是循环论证。这里让 pi 用同一份 fixture 现场构建一次，得到"独立产出"的
// 期望文本，我们的渲染器必须与之逐字节一致。
//
// 用法：node scripts/gen-pi-native-golden.mjs
// 产物：packages/server/prompts/golden/pi-native.md
//       packages/server/prompts/golden/fixture.json（同一份输入的快照，供测试复用）
//
// 注意：这里用了 pi 的内部模块路径（buildSystemPromptSections 没有从根导出）。
// 仅限离线生成 golden，生产代码不得依赖它。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROMPTS = path.join(ROOT, "packages/server/prompts");
const GOLDEN = path.join(PROMPTS, "golden");

/** pi 的构建函数没从根导出，按绝对路径引；版本升级时此处可能失效，属预期 */
async function loadPi() {
  const pkg = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent");
  const { readdirSync, existsSync } = await import("node:fs");
  let dir = pkg;
  if (!existsSync(path.join(pkg, "package.json"))) {
    // pnpm 的 .pnpm 布局
    const store = path.join(ROOT, "node_modules/.pnpm");
    const hit = readdirSync(store).find((d) =>
      d.startsWith("@earendil-works+pi-coding-agent@"),
    );
    if (!hit) throw new Error("找不到 pi-coding-agent 包");
    dir = path.join(store, hit, "node_modules/@earendil-works/pi-coding-agent");
  }
  const build = await import(`${dir}/dist/core/system-prompt.js`);
  return { buildSystemPromptSections: build.buildSystemPromptSections };
}

const CWD = "/repo/project";
const GLOBAL_AGENTS =
  "# 全局约定\n\n- GLOBAL-MARK：这份是 agent 目录下的约定\n";
const PROJECT_AGENTS =
  "# 项目约定\n\n- PROJECT-MARK：这份是项目根目录下的约定\n";

/** 从现有基线里取回 pi 的工具摘要与要点（它们本来就是 pi 的产出） */
function toolInputsFromBaseline() {
  const base = readFileSync(
    path.join(PROMPTS, "upstream/baseline/system.md"),
    "utf8",
  );
  const body = (name) => {
    const m = new RegExp(`^<${name}>\\n([\\s\\S]*?)\\n</${name}>`, "m").exec(
      base,
    );
    return m?.[1] ?? "";
  };
  const toolSnippets = {};
  const listPart = body("tools").split("\n\n")[0] ?? "";
  for (const line of listPart.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const text = line.slice(2);
    const at = text.indexOf(": ");
    if (at > 0) toolSnippets[text.slice(0, at)] = text.slice(at + 2);
  }
  const tail = [
    "Be concise in your responses",
    "Show file paths clearly when working with files",
  ];
  const rules = body("rules")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
  const dynamic = rules.slice(0, Math.max(0, rules.length - tail.length));
  return { toolSnippets, dynamicRules: dynamic };
}

const main = async () => {
  const { buildSystemPromptSections } = await loadPi();
  const { toolSnippets, dynamicRules } = toolInputsFromBaseline();
  const selectedTools = Object.keys(toolSnippets);

  // 工具要点按 pi 的规则：逐工具 toolGuidelines + promptGuidelines
  const toolGuidelines = { read: dynamicRules };

  const skills = [
    {
      name: "skill-harness",
      description:
        "Create, test and improve skills. Use when the user asks to create a skill.",
      filePath: "/home/user/.agents/skills/skill-harness/SKILL.md",
    },
  ];
  const contextFiles = [
    { path: "/home/user/.pi/agent/AGENTS.md", content: GLOBAL_AGENTS },
    { path: "/repo/project/AGENTS.md", content: PROJECT_AGENTS },
  ];

  const sections = buildSystemPromptSections({
    cwd: CWD,
    selectedTools,
    hiddenTools: [],
    toolSnippets,
    toolGuidelines,
    promptGuidelines: [],
    appendSystemPrompt: "",
    contextFiles,
    skills,
  });

  // pi 返回的段已经包好 <tag> 了（preamble 除外），直接按插入顺序拼
  const blocks = Object.values(sections).filter((t) => t);
  const golden = `${blocks.join("\n\n")}\n`;

  mkdirSync(GOLDEN, { recursive: true });
  writeFileSync(path.join(GOLDEN, "pi-native.md"), golden);
  writeFileSync(
    path.join(GOLDEN, "fixture.json"),
    `${JSON.stringify(
      {
        note: "生成 pi-native golden 的输入快照，测试用同一份数据跑我们的渲染器",
        cwd: CWD,
        selectedTools,
        toolSnippets,
        toolGuidelines,
        promptGuidelines: [],
        contextFiles,
        skills,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `已生成 ${path.relative(ROOT, path.join(GOLDEN, "pi-native.md"))}`,
  );
  console.log(`段顺序：${Object.keys(sections).join(" → ")}`);
  console.log(`总长：${golden.length} 字`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
