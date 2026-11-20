#!/usr/bin/env node
// pdf.js 在运行时按需 fetch 字体、CMap 与 WASM 解码器（standardFontDataUrl / cMapUrl / wasmUrl / iccUrl）。
// 这些文件只在 node_modules 里，Vite 不会自动带进产物；构建/开发前复制到 public/pdfjs/ 由静态服务提供。
// 缺了它们 pdf.js 会 404 后静默回退内置字体：中文等 CID 文档显示异常（见 todo B44）。
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "packages/web/node_modules/pdfjs-dist");
const DEST = join(ROOT, "packages/web/public/pdfjs");
const DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];

if (!existsSync(SRC)) {
  console.error(`copy-pdfjs-assets: 找不到 ${SRC}，先安装依赖`);
  process.exit(1);
}

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });
for (const dir of DIRS) {
  await cp(join(SRC, dir), join(DEST, dir), { recursive: true });
}
console.log(`copy-pdfjs-assets: ${DIRS.join(" / ")} → ${DEST}`);
