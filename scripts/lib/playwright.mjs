// 验收脚本共用：用服务端依赖的 playwright-core 驱动 Chromium，不需要另外全局安装 Playwright 的命令行工具。
// 浏览器本体装法：`pnpm --filter yuanshu-harness-server exec playwright-core install chromium`
// （网络受限时先设 PLAYWRIGHT_DOWNLOAD_HOST 指向镜像）。脚本里用 `chromium.launch({ channel: "chromium" })` 启动。
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const { chromium } = createRequire(
  join(root, "packages/server/package.json"),
)("playwright-core");

/** agent 浏览器（Server 里的引擎）要用的 Chromium 可执行文件：环境变量 YUANSHU_BROWSER 优先，其次是上面装好的那份；都没有返回 undefined，引擎会自己下载。 */
export function agentChromePath() {
  if (process.env.YUANSHU_BROWSER) return process.env.YUANSHU_BROWSER;
  const installed = chromium.executablePath();
  return existsSync(installed) ? installed : undefined;
}
