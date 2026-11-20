// 启动 Chromium：清洗环境变量、显式开沙箱（起不来降级并记原因）、新无头、UA 去掉 Headless。
// 隔离只是「尽力」：浏览器和 Server 同一个系统用户，沙箱是唯一硬边界。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium } from "playwright-core";
import type { SandboxState } from "./types.js";
import { VIEWPORT } from "./types.js";

// 浏览器能看到的全部环境变量。默认启动时整棵进程树继承 Server 的环境（含模型密钥），
// HOME 必须是可写目录，指向不存在的目录时崩溃上报子进程会崩。
export function scrubbedEnv(
  home: string,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { HOME: home };
  if (from.PATH) env.PATH = from.PATH;
  env.LANG = from.LANG ?? "C.UTF-8";
  return env;
}

export function launchArgs(): string[] {
  return [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-quic",
    // Google 等站在 HTTP/2 连接上发 ALPS 的 Accept-CH：Chromium 会中止并重启这个请求，重启后的请求
    // 在「代理认证」一步卡死（Playwright 的上下文级代理 + 用户名密码），整个站点永远加载不出来。
    "--disable-features=AlpsClientHintParsing",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

export interface LaunchOptions {
  executablePath: string;
  headless: boolean;
  chromiumSandbox: boolean;
  args: string[];
  env: Record<string, string>;
}

export type LaunchFn = (opts: LaunchOptions) => Promise<Browser>;

const defaultLaunch: LaunchFn = (opts) => chromium.launch(opts);

export interface LaunchDeps {
  dataDir: string;
  launch?: LaunchFn; // 测试注入；默认 chromium.launch
  env?: NodeJS.ProcessEnv;
}

export interface LaunchResult {
  browser: Browser;
  sandbox: SandboxState;
  userAgent: string;
  emojiFont: boolean;
}

// 沙箱失败的报错前面常有一堆无关行，取第一行提到 sandbox 的更像原因。
const sandboxLine = (err: unknown): string => {
  const lines = String(err instanceof Error ? err.message : err)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /sandbox/i.test(l)) ?? lines[0] ?? "";
};

const SANDBOX_FIX =
  "常见原因与修法：容器默认的 seccomp 禁用了用户命名空间（用 Playwright 提供的 seccomp 配置）；Ubuntu 24.04 的 AppArmor 限制非特权用户命名空间（见 Playwright 的 apparmor 说明）；内核未启用用户命名空间支持。降级后页面一旦突破渲染进程就会直接以 Server 用户身份运行。";

const UA_FALLBACK =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export async function launchBrowser(
  executable: string,
  opts: LaunchDeps,
): Promise<LaunchResult> {
  const home = path.join(opts.dataDir, "browser", "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const launch = opts.launch ?? defaultLaunch;
  const common = {
    executablePath: executable,
    headless: true,
    args: launchArgs(),
    env: scrubbedEnv(home, opts.env ?? process.env),
  };

  let browser: Browser;
  let sandbox: SandboxState;
  if (process.getuid?.() === 0) {
    // root 下 Chromium 的沙箱根本起不来，直接降级，不去撞一次失败。
    browser = await launch({ ...common, chromiumSandbox: false });
    sandbox = {
      enabled: false,
      reason: `浏览器以 root 运行（容器里常见）：root 下 Chromium 沙箱无法开启，已降级为无沙箱。建议改用非 root 用户运行 Server。${SANDBOX_FIX}`,
    };
  } else {
    try {
      browser = await launch({ ...common, chromiumSandbox: true });
      sandbox = { enabled: true };
    } catch (err) {
      if (!/sandbox/i.test(String(err instanceof Error ? err.message : err)))
        throw err;
      browser = await launch({ ...common, chromiumSandbox: false });
      sandbox = {
        enabled: false,
        reason: `开启 Chromium 沙箱失败（${sandboxLine(err)}），已降级为无沙箱。${SANDBOX_FIX}`,
      };
    }
  }

  const { userAgent, emojiFont } = await probe(browser);
  return { browser, sandbox, userAgent, emojiFont };
}

// 彩色 emoji 字体在不在：把 😀 画到画布上，有彩色像素就是有（缺字体时画出来是黑白的方框或单色字形）。
const EMOJI_PROBE = `(() => {
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const g = c.getContext("2d");
  g.font = "32px sans-serif";
  g.fillText("😀", 4, 36);
  const d = g.getImageData(0, 0, 48, 48).data;
  for (let i = 0; i < d.length; i += 4)
    if (d[i + 3] > 0 && (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2])) return true;
  return false;
})()`;

// 探针页：读真实 UA（把 HeadlessChrome 换成 Chrome，其余不动，不做指纹伪造）并查 emoji 字体。
// 探针失败当作没问题：不能因为探测不了就吓用户。
async function probe(
  browser: Browser,
): Promise<{ userAgent: string; emojiFont: boolean }> {
  const ctx = await browser.newContext({ viewport: { ...VIEWPORT } });
  try {
    const page = await ctx.newPage();
    const ua = await page.evaluate("navigator.userAgent");
    const emoji = await page.evaluate(EMOJI_PROBE);
    return {
      userAgent:
        typeof ua === "string" && ua
          ? ua.replace("HeadlessChrome", "Chrome")
          : UA_FALLBACK,
      emojiFont: emoji !== false,
    };
  } catch {
    return { userAgent: UA_FALLBACK, emojiFont: true };
  } finally {
    await ctx.close().catch(() => {});
  }
}
