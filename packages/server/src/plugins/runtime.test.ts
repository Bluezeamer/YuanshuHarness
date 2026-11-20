import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memorySwitch } from "../../test/support/plugin-switch.js";
import { PluginRuntime } from "./runtime.js";

// 包管理的特征测试：用本地目录当来源（不起 npm / git）。登记写进 pi 的 settings.json，开关只在我们的库里。

let dir: string;
let agentDir: string;
let pkgDir: string;

// 造一个最小 pi 包：一个扩展、一个 skill、一个 postinstall 脚本。
function makePackage(name: string, version: string): string {
  const root = path.join(dir, `${name}-${version}`);
  mkdirSync(path.join(root, "skills", "hello"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name,
      version,
      pi: { extensions: ["./index.ts"], skills: ["./skills"] },
      scripts: { postinstall: "echo hi" },
    }),
  );
  writeFileSync(path.join(root, "index.ts"), "export default () => {};\n");
  writeFileSync(
    path.join(root, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: 示例\n---\n正文\n",
  );
  return root;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuanshu-plugins-"));
  agentDir = path.join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  pkgDir = makePackage("sample-plugin", "1.2.3");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PluginRuntime", () => {
  test("preview 报出来源、版本、扩展数、skill 数与有没有安装脚本，且不改登记", async () => {
    const runtime = new PluginRuntime(memorySwitch(), agentDir);
    const preview = await runtime.preview(pkgDir);
    expect(preview.source).toBe(pkgDir);
    expect(preview.version).toBe("1.2.3");
    expect(preview.extensionCount).toBe(1);
    expect(preview.skillCount).toBe(1);
    expect(preview.hasInstallScript).toBe(true);
    expect(await runtime.list()).toEqual([]);
  });

  test("install 之后 list 里能看到这条，版本与计数都对", async () => {
    const runtime = new PluginRuntime(memorySwitch(), agentDir);
    await runtime.install(pkgDir);
    const [record] = await runtime.list();
    // 本地来源会被 pi 规范化成相对 agentDir 的写法
    expect(record?.source).toBe(path.relative(agentDir, pkgDir));
    expect(record?.version).toBe("1.2.3");
    expect(record?.enabled).toBe(true);
    expect(record?.installed).toBe(true);
    expect(record?.extensionCount).toBe(1);
    expect(record?.skillCount).toBe(1);
  });

  test("toggle 只改我们的开关，pi 的 settings.json 不动，包体计数照旧", async () => {
    const runtime = new PluginRuntime(memorySwitch(), agentDir);
    await runtime.install(pkgDir);
    const [source] = (await runtime.list()).map((r) => r.source);
    const settings = () =>
      JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"))
        .packages;

    await runtime.toggle(source as string, false);
    expect((await runtime.list())[0]?.enabled).toBe(false);
    expect((await runtime.list())[0]?.extensionCount).toBe(1);
    expect(settings()).toEqual([source]);

    await runtime.toggle(source as string, true);
    expect((await runtime.list())[0]?.enabled).toBe(true);
    expect(settings()).toEqual([source]);
  });

  test("pi TUI 装的包（开关里没有记录）默认是关的", async () => {
    const switches = memorySwitch();
    const runtime = new PluginRuntime(switches, agentDir);
    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [pkgDir] }),
    );
    const [record] = await runtime.list();
    expect(record?.enabled).toBe(false);
    expect(switches.enabled().size).toBe(0);
  });

  test("uninstall 之后 list 里消失，开关一并清掉", async () => {
    const switches = memorySwitch();
    const runtime = new PluginRuntime(switches, agentDir);
    await runtime.install(pkgDir);
    const [source] = (await runtime.list()).map((r) => r.source);
    await runtime.uninstall(source as string);
    expect(await runtime.list()).toEqual([]);
    expect(switches.enabled().has(source as string)).toBe(false);
  });

  test("对没登记的来源卸载 / 开关报 404", async () => {
    const runtime = new PluginRuntime(memorySwitch(), agentDir);
    await expect(runtime.uninstall("nope")).rejects.toThrow(/没有登记/);
    await expect(runtime.toggle("nope", false)).rejects.toThrow(/没有登记/);
  });

  test("来源不存在时的预览报 422，不当成「0 个扩展」", async () => {
    const runtime = new PluginRuntime(memorySwitch(), agentDir);
    await expect(
      runtime.preview(path.join(dir, "不存在")),
    ).rejects.toMatchObject({ status: 422 });
  });
});
