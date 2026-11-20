#!/usr/bin/env node
// 生成文件类型图标：从固定版本的 @iconify-json/catppuccin（MIT）里只取映射表用到的图标，
// 写成 packages/web/src/ui/file-icons/file-icons.generated.ts。
// 图标里的 Macchiato 色值换成 var(--ci-*)，色板在 ui/tokens.css（换色只改那里）。
// 改了 mapping.json 就重新跑：node scripts/gen-file-icons.mjs（需要能访问 npm）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@iconify-json/catppuccin@1.2.17";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/web/src/ui/file-icons");
const mapping = JSON.parse(readFileSync(join(dir, "mapping.json"), "utf8"));

// Macchiato 色值 → 令牌名（令牌值是对应的 Latte 色，见 tokens.css）
const TOKEN = {
  "#cad3f5": "text",
  "#8aadf4": "blue",
  "#eed49f": "yellow",
  "#a6da95": "green",
  "#8087a2": "overlay",
  "#f5a97f": "peach",
  "#ed8796": "red",
  "#c6a0f6": "mauve",
  "#91d7e3": "sky",
  "#7dc4e4": "sapphire",
  "#f5bde6": "pink",
  "#8bd5ca": "teal",
  "#ee99a0": "maroon",
  "#b7bdf8": "lavender",
  "#f4dbd6": "rosewater",
  "#f0c6c6": "flamingo",
  "#3700ff": "indigo",
  "#df8e1d": "yellow",
};

const tmp = mkdtempSync(join(tmpdir(), "ctp-icons-"));
try {
  execFileSync("npm", ["pack", PKG, "--silent"], { cwd: tmp, stdio: "pipe" });
  const tgz = execFileSync("ls", [tmp]).toString().trim().split("\n")[0];
  execFileSync("tar", ["xzf", tgz], { cwd: tmp });
  const set = JSON.parse(readFileSync(join(tmp, "package/icons.json"), "utf8"));

  // 用到的图标：映射里的名字 + 文件夹（含 -open 变体，只收存在的）
  const used = new Set([
    ...Object.values(mapping.files),
    ...mapping.prefixes.map((p) => p[1]),
    ...mapping.suffixes.map((p) => p[1]),
    ...Object.values(mapping.exts),
    mapping.defaults.file,
    mapping.defaults.dir,
    `${mapping.defaults.dir}-open`,
  ]);
  const dirIcons = new Set([
    `${mapping.defaults.dir}`,
    `${mapping.defaults.dir}-open`,
  ]);
  for (const v of new Set(Object.values(mapping.dirs))) {
    for (const n of [`folder-${v}`, `folder-${v}-open`]) {
      if (set.icons[n]) {
        used.add(n);
        dirIcons.add(n);
      } else console.warn(`文件夹图标缺失：${n}`);
    }
  }
  const missing = [...used].filter((n) => !set.icons[n]);
  if (missing.length) throw new Error(`图标不存在：${missing.join(", ")}`);

  // 一个标签上的 fill / stroke 色值合并成一个 style，颜色换成变量
  const recolor = (body) =>
    body.replace(/<([a-zA-Z]+)([^>]*?)(\/?)>/g, (all, tag, attrs, close) => {
      const decl = [];
      const rest = attrs.replace(
        /\s(fill|stroke)="(#[0-9a-fA-F]{6})"/g,
        (_m, k, c) => {
          const t = TOKEN[c.toLowerCase()];
          if (!t) throw new Error(`没有对应令牌的色值 ${c}`);
          decl.push(`${k}:var(--ci-${t})`);
          return "";
        },
      );
      if (!decl.length) return all;
      if (/\sstyle=/.test(rest))
        throw new Error(`标签已有 style：${all.slice(0, 80)}`);
      return `<${tag}${rest} style="${decl.join(";")}"${close}>`;
    });

  const icons = {};
  for (const n of [...used].sort()) {
    const body = recolor(set.icons[n].body);
    if (/#[0-9a-fA-F]{3,8}\b|https?:/.test(body))
      throw new Error(`图标 ${n} 里还有色值或网址`);
    icons[n] = body;
  }
  const dirOnly = [...dirIcons].filter((n) => icons[n]);
  const out = `// 由 scripts/gen-file-icons.mjs 生成，不要手改。改映射请编辑 mapping.json 后重新生成。
// 图标：Catppuccin Icons（MIT，Copyright (c) 2023 Catppuccin、thang-nm），
// 取自 ${PKG}；许可证全文见仓库 licenses/Catppuccin-icons.txt。
// 颜色是 var(--ci-*)，取值在 ui/tokens.css。

export const MAPPING = ${JSON.stringify(
    { ...mapping, dirIcons: dirOnly.sort() },
    null,
    2,
  )} as const;

export const ICONS: Readonly<Record<string, string>> = ${JSON.stringify(icons, null, 2)};
`;
  writeFileSync(join(dir, "file-icons.generated.ts"), out);
  console.log(
    `写入 ${Object.keys(icons).length} 个图标（其中文件夹 ${dirOnly.length}），${(out.length / 1024).toFixed(0)} KB`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
