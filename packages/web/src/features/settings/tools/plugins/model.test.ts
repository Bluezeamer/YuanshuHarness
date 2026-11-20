import { expect, test } from "vitest";
import type { PluginView } from "../../../../api/pluginLibrary";
import {
  checkSource,
  contentText,
  kindOf,
  matchesPlugin,
  nameOf,
  prefixHint,
  statusOf,
  versionText,
} from "./model";

const plugin = (over: Partial<PluginView> = {}): PluginView => ({
  source: "npm:pi-tasks",
  version: "1.2.3",
  enabled: true,
  installed: true,
  extensionCount: 1,
  skillCount: 0,
  ...over,
});

test("名字：去掉协议与版本，scope 保留，git 去掉 .git", () => {
  expect(nameOf("npm:@tintinweb/pi-tasks")).toBe("@tintinweb/pi-tasks");
  expect(nameOf("npm:pi-web-access@1.2.3")).toBe("pi-web-access");
  expect(nameOf("npm:@a/b@2.0.0")).toBe("@a/b");
  expect(nameOf("git:github.com/owner/repo@v1")).toBe("repo");
  expect(nameOf("https://github.com/owner/repo.git")).toBe("repo");
  expect(nameOf("git@github.com:owner/repo.git")).toBe("repo");
  expect(nameOf("../../tmp/pkg")).toBe("pkg");
});

test("来源类型与没写前缀的提示", () => {
  expect(kindOf("npm:pi-tasks")).toBe("npm");
  expect(kindOf("git:github.com/o/r")).toBe("git");
  expect(kindOf("https://github.com/o/r.git")).toBe("git");
  expect(kindOf("./local")).toBe("local");
  expect(prefixHint("pi-tasks")).toContain("本地路径");
  expect(prefixHint("npm:pi-tasks")).toBeNull();
  expect(prefixHint("./local")).toBeNull();
  expect(prefixHint("")).toBeNull();
});

test("行状态：操作中 > 未装上 > 已停用 > 已启用", () => {
  expect(statusOf(plugin(), "卸载中").key).toBe("busy");
  expect(statusOf(plugin({ installed: false }), null).key).toBe("missing");
  expect(statusOf(plugin({ enabled: false }), null).key).toBe("off");
  expect(statusOf(plugin(), null)).toEqual({
    key: "ok",
    text: "已启用",
    tone: "live",
  });
  // 没装上时就算开关是关的，也先说没装上
  expect(statusOf(plugin({ installed: false, enabled: false }), null).key).toBe(
    "missing",
  );
});

test("内容文案：停用时计数是 0，不能说成「没有扩展」", () => {
  expect(contentText(plugin({ extensionCount: 2, skillCount: 1 }))).toBe(
    "2 个扩展 · 1 个技能",
  );
  expect(contentText(plugin({ extensionCount: 0, skillCount: 0 }))).toBe(
    "没有扩展与技能",
  );
  expect(contentText(plugin({ enabled: false, extensionCount: 0 }))).toContain(
    "已停用",
  );
  expect(contentText(plugin({ installed: false }))).toContain("没有就位");
});

test("版本与搜索", () => {
  expect(versionText(plugin())).toBe("v1.2.3");
  expect(versionText(plugin({ version: null }))).toBe("无版本");
  expect(matchesPlugin(plugin(), "TASKS")).toBe(true);
  expect(matchesPlugin(plugin(), "  ")).toBe(true);
  expect(matchesPlugin(plugin(), "web")).toBe(false);
});

test("来源输入：空不报错、含空白报错、其余放行", () => {
  expect(checkSource("   ")).toBeNull();
  expect(checkSource("npm:a b")).toMatchObject({ ok: false });
  expect(checkSource("  npm:pi-tasks ")).toEqual({
    ok: true,
    source: "npm:pi-tasks",
  });
});
