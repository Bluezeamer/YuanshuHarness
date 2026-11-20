// Engine 的失败分类与状态流转：不装浏览器、不下载（AUTO_INSTALL_ENV=0 让安装那一步直接拒绝）。
import { describe, expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { classifyLaunchError, Engine, EngineError } from "./engine.js";
import { AUTO_INSTALL_ENV, BROWSER_ENV } from "./install.js";

const engineWith = (env: NodeJS.ProcessEnv) =>
  new Engine({ dataDir: makeTmpDir("ys-engine-unit-"), env });

describe("Engine", () => {
  test("没装且自动下载被关：报 not_installed，状态 failed", async () => {
    const engine = engineWith({
      [BROWSER_ENV]: "/nonexistent/chrome",
      [AUTO_INSTALL_ENV]: "0",
    });
    const seen: string[] = [];
    engine.subscribe((s) => seen.push(s.status));
    const err = await engine.ensure().catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.problem.code).toBe("not_installed");
    expect(err.problem.message).toContain("自动下载已被环境变量关闭");
    expect(err.problem.fix).toContain("playwright-core install chromium");
    expect(engine.state().status).toBe("failed");
    expect(engine.state().problem?.code).toBe("not_installed");
    // 没有进入 installing
    expect(seen).not.toContain("installing");
    await engine.close();
  });

  test("失败后 context() 也抛同一个 Problem", async () => {
    const engine = engineWith({
      [BROWSER_ENV]: "/nonexistent/chrome",
      [AUTO_INSTALL_ENV]: "0",
    });
    const err = await engine
      .context({
        proxy: { server: "http://127.0.0.1:1", username: "u", password: "p" },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.problem.code).toBe("not_installed");
    expect(engine.contextCount()).toBe(0);
    await engine.close();
  });

  test("订阅能拿到状态变化，退订后不再收到", async () => {
    const engine = engineWith({
      [BROWSER_ENV]: "/nonexistent/chrome",
      [AUTO_INSTALL_ENV]: "0",
    });
    const states: string[] = [];
    const off = engine.subscribe((s) => states.push(s.status));
    await engine.ensure().catch(() => {});
    expect(states).toEqual(["failed"]);
    off();
    await engine.close();
    expect(states).toEqual(["failed"]);
  });

  test("close() 之后 ensure() 拒绝", async () => {
    const engine = engineWith({ [AUTO_INSTALL_ENV]: "0" });
    await engine.close();
    await expect(engine.ensure()).rejects.toThrow(/已关闭/);
  });
});

describe("classifyLaunchError", () => {
  test("缺系统库：保留包名，修法是 install-deps", () => {
    const problem = classifyLaunchError(
      [
        "browserType.launch: Host system is missing dependencies to run browsers.",
        "",
        "Missing libraries:",
        "    libnss3.so",
        "    libatk-1.0.so",
        "",
        "    sudo npx playwright-core install-deps chromium",
        "    sudo apt-get install libnss3 libatk1.0-0",
      ].join("\n"),
    );
    expect(problem.code).toBe("missing_libs");
    expect(problem.message).toContain("libnss3.so");
    expect(problem.message).toContain("libatk-1.0.so");
    expect(problem.fix).toContain("install-deps");
    expect(problem.fix).toContain("root");
  });

  test("可执行文件不在：报 not_installed 并给安装命令", () => {
    const problem = classifyLaunchError(
      "browserType.launch: Executable doesn't exist at /x/chrome",
    );
    expect(problem.code).toBe("not_installed");
    expect(problem.fix).toContain("install chromium");
  });

  test("其它错误：launch_failed，带原文", () => {
    const problem = classifyLaunchError("boom: target closed");
    expect(problem.code).toBe("launch_failed");
    expect(problem.message).toContain("target closed");
  });
});
