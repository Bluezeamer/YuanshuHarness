// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// 「用户写点什么交给 agent」的输入框统一用 RichInput（文字 + 附件）：直接用文字框就只有文字，附件会再丢一次。
// 对话区（features/chat）里能直接放文字框的只有这两处：RichInput 自己，和主输入卡（有斜杠菜单与引用，自己持有文字框，
// 附件部分同样用 AttachmentBar / useFilePicker）。新入口要用文字框，先想想它是不是该用 RichInput。
const ALLOWED = ["input/RichInput.tsx", "tab/Composer.tsx"];

const chatDir = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string, prefix = ""): { f: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return walk(full, rel);
    if (!/\.tsx$/.test(name) || /\.test\.tsx$/.test(name)) return [];
    return [{ f: rel, text: readFileSync(full, "utf8") }];
  });
}

// 去掉注释再查：注释里可以讲「为什么不用」。
const strip = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const usesTextarea = (text: string) =>
  /<(?:Textarea|textarea)\b/.test(strip(text));

const sources = walk(chatDir);

test("扫描范围非空，避免守卫形同虚设", () => {
  expect(sources.length).toBeGreaterThan(20);
});

test("对话区里文字框只出现在 RichInput 与主输入卡", () => {
  const found = sources.filter((s) => usesTextarea(s.text)).map((s) => s.f);
  expect(found.sort()).toEqual([...ALLOWED].sort());
});

test("主输入卡的附件部分与 RichInput 用同一套件：AttachmentBar、useFilePicker", () => {
  for (const f of ["input/RichInput.tsx", "tab/Composer.tsx"]) {
    const text = sources.find((s) => s.f === f)?.text ?? "";
    expect(text, f).toMatch(/AttachmentBar/);
    expect(text, f).toMatch(/useFilePicker/);
  }
});
