// 安装逻辑：只测「传给子进程什么」与失败提示，不下载任何东西（run 注入替身）。

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import {
  BROWSER_ENV,
  browsersPath,
  findExecutable,
  InstallError,
  installChromium,
  MIRROR_ENV,
  type RunFn,
  type RunOptions,
} from "./install.js";

interface Call {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const recording = (
  result: { code?: number; stdout?: string; stderr?: string } = {},
) => {
  const calls: Call[] = [];
  const run: RunFn = async (cmd, args, opts: RunOptions) => {
    calls.push({ cmd, args, env: opts.env });
    return {
      code: result.code ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
  return { calls, run };
};

describe("browsersPath", () => {
  test("放在数据目录下的 browser/", () => {
    expect(browsersPath("/data")).toBe(path.join("/data", "browser"));
  });
});

describe("findExecutable", () => {
  test("YUANSHU_BROWSER 优先，文件不存在返回 null", async () => {
    const { calls, run } = recording();
    const dataDir = makeTmpDir("ys-engine-");
    const own = path.join(dataDir, "my-chrome");
    expect(
      await findExecutable({
        dataDir,
        env: { [BROWSER_ENV]: own },
        run,
      }),
    ).toBeNull();
    // 设了就不再问 Playwright
    expect(calls).toHaveLength(0);
  });

  test("没有 YUANSHU_BROWSER 时在子进程里问 Playwright，找不到返回 null", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const { calls, run } = recording({ stdout: "/nonexistent/chromium\n" });
    expect(await findExecutable({ dataDir, env: {}, run })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("-e");
    expect(calls[0]?.env.PLAYWRIGHT_BROWSERS_PATH).toBe(browsersPath(dataDir));
  });

  test("探到真实存在的路径就返回，并缓存", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const exe = path.join(dataDir, "chrome");
    const { calls, run } = recording({ stdout: `${exe}\n` });
    // 用一个真实存在的文件冒充（这里只校验存在性）
    writeFileSync(exe, "");
    expect(await findExecutable({ dataDir, env: {}, run })).toBe(exe);
    expect(await findExecutable({ dataDir, env: {}, run })).toBe(exe);
    expect(calls).toHaveLength(1);
  });
});

describe("installChromium", () => {
  test("跑 playwright-core 的 CLI，环境带数据目录与镜像", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const { calls, run } = recording();
    const lines: string[] = [];
    await installChromium(
      {
        dataDir,
        env: {},
        mirror: () => "https://mirror.test/pw/",
        run: async (cmd, args, opts) => {
          opts.onLine?.("downloading 10%");
          return run(cmd, args, opts);
        },
      },
      (l) => lines.push(l),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.cmd).toBe(process.execPath);
    expect(call?.args[0]?.endsWith("cli.js")).toBe(true);
    expect(call?.args.slice(1)).toEqual(["install", "chromium", "--no-shell"]);
    expect(call?.env.PLAYWRIGHT_BROWSERS_PATH).toBe(browsersPath(dataDir));
    // 尾斜杠去掉，Playwright 自己拼路径
    expect(call?.env[MIRROR_ENV]).toBe("https://mirror.test/pw");
    expect(lines).toEqual(["downloading 10%"]);
    expect(existsSync(browsersPath(dataDir))).toBe(true);
  });

  test("镜像优先取设置值，没有就用环境变量", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const a = recording();
    await installChromium({
      dataDir,
      env: { [MIRROR_ENV]: "https://env.test" },
      run: a.run,
    });
    expect(a.calls[0]?.env[MIRROR_ENV]).toBe("https://env.test");

    const b = recording();
    await installChromium({
      dataDir,
      env: { [MIRROR_ENV]: "https://env.test" },
      mirror: () => "https://setting.test",
      run: b.run,
    });
    expect(b.calls[0]?.env[MIRROR_ENV]).toBe("https://setting.test");
  });

  test("设置里的镜像为空串时回落到环境变量，报错里的下载源也是它", async () => {
    // 子进程会继承环境变量，光看传给它的环境测不出来；失败信息里写的「下载源」才会错
    const { run } = recording({ code: 1, stderr: "Download failed" });
    const err = await installChromium({
      dataDir: makeTmpDir("ys-engine-"),
      env: { [MIRROR_ENV]: "https://env.test" },
      mirror: () => "",
      run,
    }).catch((e) => e);
    expect(err.source).toBe("https://env.test");
  });

  test("没有镜像时不设 PLAYWRIGHT_DOWNLOAD_HOST", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const { calls, run } = recording();
    await installChromium({ dataDir, env: {}, run });
    expect(calls[0]?.env[MIRROR_ENV]).toBeUndefined();
  });

  test("失败时 InstallError 写明下载源、自输出尾部与镜像提示", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const { run } = recording({
      code: 1,
      stderr: "EACCES mkdir\nDownload failed: 502 Bad Gateway",
      stdout: "Installing chromium",
    });
    const err = await installChromium({
      dataDir,
      env: {},
      mirror: () => "https://mirror.test/pw",
      run,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect(err.source).toBe("https://mirror.test/pw");
    expect(err.message).toContain("https://mirror.test/pw");
    expect(err.message).toContain("502 Bad Gateway");
    expect(err.message).toContain(MIRROR_ENV);
    expect(err.message).toContain("镜像");
  });

  test("没有镜像时提示里写 Playwright 默认源", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const { run } = recording({ code: 2, stderr: "boom" });
    const err = await installChromium({ dataDir, env: {}, run }).catch(
      (e) => e,
    );
    expect(err.message).toContain("Playwright 默认源");
  });

  test("子进程起不来也算 InstallError", async () => {
    const dataDir = makeTmpDir("ys-engine-");
    const err = await installChromium({
      dataDir,
      env: {},
      run: async () => {
        throw new Error("找不到 node");
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect(err.message).toContain("找不到 node");
  });
});
