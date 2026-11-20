// 启动相关的纯逻辑：环境清洗、参数、沙箱降级分支。不碰真浏览器（launch 注入替身）。
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import {
  type LaunchOptions,
  launchArgs,
  launchBrowser,
  scrubbedEnv,
} from "./launch.js";

// 替身浏览器：只在探测时被调用；探针脚本里带 canvas 的是 emoji 字体探针，其余读 UA。
const fakeBrowser = (
  ua = "Mozilla/5.0 HeadlessChrome/1 Chrome/1 Safari/537.36",
  emoji: unknown = true,
) =>
  ({
    newContext: async () => ({
      newPage: async () => ({
        evaluate: async (script: string) =>
          script.includes("canvas") ? emoji : ua,
      }),
      close: async () => {},
    }),
  }) as unknown as Browser;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrubbedEnv", () => {
  test("只留 PATH / HOME / LANG，HOME 被替换", () => {
    const env = scrubbedEnv("/tmp/bhome", {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      LANG: "zh_CN.UTF-8",
      OPENAI_API_KEY: "sk-secret",
      YUANSHU_TOKEN: "tok",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/bhome",
      LANG: "zh_CN.UTF-8",
    });
  });

  test("没有 LANG 时用 C.UTF-8", () => {
    expect(scrubbedEnv("/h", { PATH: "/bin" }).LANG).toBe("C.UTF-8");
  });
});

describe("launchArgs", () => {
  test("含必需的隔离参数", () => {
    const args = launchArgs();
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--disable-quic");
    // 没有它，带 ALPS Accept-CH 的站点（Google 全家）经代理永远加载不出来
    expect(args).toContain("--disable-features=AlpsClientHintParsing");
    expect(args).toContain(
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
  });
});

describe("launchBrowser 的沙箱分支", () => {
  const dataDir = () => makeTmpDir("yuanshu-engine-");

  test("非 root：先试开沙箱；HOME 指向数据目录下的 0700 目录", async () => {
    const calls: LaunchOptions[] = [];
    const dir = dataDir();
    const r = await launchBrowser("/fake/chrome", {
      dataDir: dir,
      launch: async (opts) => {
        calls.push(opts);
        return fakeBrowser();
      },
    });
    expect(r.sandbox).toEqual({ enabled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.chromiumSandbox).toBe(true);
    expect(calls[0]?.headless).toBe(true);
    const home = calls[0]?.env.HOME ?? "";
    expect(home).toBe(path.join(dir, "browser", "home"));
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  test("UA 去掉 HeadlessChrome", async () => {
    const r = await launchBrowser("/fake/chrome", {
      dataDir: dataDir(),
      launch: async () => fakeBrowser("Mozilla/5.0 HeadlessChrome/158.0.0.0"),
    });
    expect(r.userAgent).toBe("Mozilla/5.0 Chrome/158.0.0.0");
  });

  test("emoji 字体探针：有彩色字形是 true，画出来是黑白的（缺字体）是 false；探针出错不吓人，当作有", async () => {
    const run = (browser: Browser) =>
      launchBrowser("/fake/chrome", {
        dataDir: dataDir(),
        launch: async () => browser,
      });
    expect((await run(fakeBrowser(undefined, true))).emojiFont).toBe(true);
    expect((await run(fakeBrowser(undefined, false))).emojiFont).toBe(false);
    const broken = {
      newContext: async () => ({
        newPage: async () => ({
          evaluate: async () => {
            throw new Error("boom");
          },
        }),
        close: async () => {},
      }),
    } as unknown as Browser;
    const r = await run(broken);
    expect(r.emojiFont).toBe(true);
    expect(r.userAgent).toContain("Chrome");
  });

  test("root：直接无沙箱，说明原因", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const calls: LaunchOptions[] = [];
    const r = await launchBrowser("/fake/chrome", {
      dataDir: dataDir(),
      launch: async (opts) => {
        calls.push(opts);
        return fakeBrowser();
      },
    });
    expect(calls.map((c) => c.chromiumSandbox)).toEqual([false]);
    expect(r.sandbox.enabled).toBe(false);
    if (!r.sandbox.enabled) {
      expect(r.sandbox.reason).toContain("root");
      expect(r.sandbox.reason).toContain("seccomp");
    }
  });

  test("沙箱类错误：降级重试并返回原因；剩余参数不变", async () => {
    const calls: LaunchOptions[] = [];
    const r = await launchBrowser("/fake/chrome", {
      dataDir: dataDir(),
      launch: async (opts) => {
        calls.push(opts);
        if (opts.chromiumSandbox)
          throw new Error(
            "browserType.launch: Target page, context or browser has been closed\nFailed to launch: sandbox is not available",
          );
        return fakeBrowser();
      },
    });
    expect(calls.map((c) => c.chromiumSandbox)).toEqual([true, false]);
    expect(calls[1]?.args).toEqual(calls[0]?.args);
    expect(r.sandbox.enabled).toBe(false);
    if (!r.sandbox.enabled) {
      expect(r.sandbox.reason).toContain("sandbox");
      expect(r.sandbox.reason).toContain("AppArmor");
      expect(r.sandbox.reason).toContain("seccomp");
    }
  });

  test("其他启动错误不降级，直接抛", async () => {
    const calls: LaunchOptions[] = [];
    await expect(
      launchBrowser("/fake/chrome", {
        dataDir: dataDir(),
        launch: async (opts) => {
          calls.push(opts);
          throw new Error(
            "browserType.launch: Host system is missing dependencies to run browsers.",
          );
        },
      }),
    ).rejects.toThrow(/missing dependencies/);
    expect(calls).toHaveLength(1);
  });

  test("HOME 目录不存在就建出来", async () => {
    const dir = dataDir();
    await launchBrowser("/fake/chrome", {
      dataDir: dir,
      launch: async () => fakeBrowser(),
    });
    expect(existsSync(path.join(dir, "browser", "home"))).toBe(true);
  });
});
