#!/usr/bin/env node
// 离线 golden 检查：用槽位骨架 + 资产 + fixture 渲染，与黄金样本逐字节比对。
//
// 不需要起服务，也不碰真实会话；用于本地改完资产后立刻自检，以及 CI。
// 与 scripts/prompt-baseline.mjs 的分工：
//   - 本脚本：离线、纯函数层（资产/槽位/拼接规则是否还对得上 pi 原生投影）
//   - prompt-baseline.mjs：在线、真实会话（我们的接线是否把内容正确送到模型）
//
// 用法：
//   node scripts/prompt-golden.mjs           检查（有差异退出码 1）
//   node scripts/prompt-golden.mjs --update  重新生成黄金样本（会调用 pi 的构建函数）
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const run = () => {
  // 走服务端的 vitest，复用同一套 TS 模块（槽位/渲染器在 src 下）
  execFileSync(
    "npx",
    ["vitest", "run", "src/prompt/pipeline.test.ts", "--maxWorkers=1"],
    { cwd: path.join(ROOT, "packages/server"), stdio: "inherit" },
  );
};

const main = () => {
  if (process.argv.includes("--update")) {
    // 重新生成黄金样本：调用 pi 自己的构建函数（离线）
    execFileSync("node", [path.join(HERE, "gen-pi-native-golden.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    console.log("\n黄金样本已更新，接着跑一次校验：");
  }
  try {
    run();
    console.log("\n✅ 渲染结果与 pi 原生投影逐字节一致");
  } catch {
    console.error(
      "\n❌ 与黄金样本不一致。若这是有意的内容改动，先跑 --update 再 review diff。",
    );
    process.exit(1);
  }
};

main();
