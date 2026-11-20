#!/usr/bin/env node
// 把品牌图标的 SVG 渲染成手机端要的 PNG（产物入库）：node scripts/brand/png.mjs
// 手机的安装图标不能只给 SVG：192 / 512 PNG（any）、512 maskable PNG、iOS 的 180 apple-touch-icon。
// maskable 与 apple-touch-icon 用铺满的那版（系统自己裁圆角 / 圆形），标记已在 gen.mjs 里收进安全圆。
// 需要全局的 @playwright/cli（取它自带的 playwright-core）与一个 Chromium。
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = join(root, "packages/web/public");
const OUT = join(PUBLIC, "m");
mkdirSync(OUT, { recursive: true });

const globalRoot = execSync("npm root -g").toString().trim();
const { chromium } = createRequire(
  join(globalRoot, "@playwright/cli/package.json"),
)("playwright-core");

const JOBS = [
  { from: "icon.svg", to: "icon-192.png", size: 192 },
  { from: "icon.svg", to: "icon-512.png", size: 512 },
  { from: "icon-maskable.svg", to: "icon-maskable-512.png", size: 512 },
  { from: "icon-maskable.svg", to: "apple-touch-icon.png", size: 180 },
];

const browser = await chromium.launch({ channel: "chromium" });
try {
  for (const { from, to, size } of JOBS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
    });
    const svg = readFileSync(join(PUBLIC, from), "utf8");
    await page.setContent(
      `<body style="margin:0;background:transparent"><img style="display:block" width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`,
    );
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({
      path: join(OUT, to),
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    await page.close();
    console.log(`${to}  ${size}×${size}`);
  }
} finally {
  await browser.close();
}
