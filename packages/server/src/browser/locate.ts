// 定位本机 Chromium 系浏览器。只找不装：缺失时返回 null，由调用方给出安装提示，检查流程里不下载任何东西。
import { existsSync } from "node:fs";
import path from "node:path";

const NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "microsoft-edge",
];

const FIXED = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Windows 路径只写不验（无真机）
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

export const BROWSER_ENV = "YUANSHU_BROWSER";

export const INSTALL_HINT = `未找到 Chromium 或 Chrome，侧边浏览器不可用。安装 Chromium（如 apt install chromium），或用环境变量 ${BROWSER_ENV} 指向浏览器可执行文件后重启 Server。`;

export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const given = env[BROWSER_ENV];
  if (given) return exists(given) ? given : null;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs)
    for (const name of NAMES) {
      const p = path.join(dir, name);
      if (exists(p)) return p;
    }
  return FIXED.find(exists) ?? null;
}
