import { expect, test } from "vitest";
import { chatPaneOf } from "../../features/chat/tab/chatPane";
import { createNav } from "../nav/nav";
import { createMobileLayout } from "./mobileLayout";

function setup(url: string) {
  history.replaceState(null, "", url);
  const nav = createNav();
  return { nav, layout: createMobileLayout(nav) };
}

test("对话页：布局里有一个窗格装着这个对话标签，按「承载对话的窗格」找落点的代码照常工作", () => {
  const { layout } = setup("/m/s/s1");
  expect(chatPaneOf(layout, "s1")).toEqual({
    pid: "m",
    tabId: "m-chat",
    host: undefined,
  });
  expect(layout.viewing()).toEqual(["s1"]);
  expect(layout.anchorSession()).toBe("s1");
});

test("列表页没有窗口，也没有在看的会话", () => {
  const { layout } = setup("/m/");
  expect(layout.getState().doc.windows.list).toEqual([]);
  expect(layout.viewing()).toEqual([]);
  expect(layout.anchorSession()).toBeNull();
});

test("openDiff / openTeamDiff：推一页预览标签（diff 形态），带上会话与主机", () => {
  const { nav, layout } = setup("/m/s/s1");
  layout.openDiff("m", "m-chat", 3, "src/a.ts", "s1");
  expect(nav.route()).toMatchObject({
    name: "tab",
    tab: {
      type: "preview",
      host: "server",
      sid: "s1",
      diff: { turn: 3, path: "src/a.ts" },
    },
  });
  layout.openTeamDiff("m", "m-preview", "src/b.ts", "s1");
  expect(nav.route()).toMatchObject({
    name: "tab",
    tab: { diff: { turn: null, path: "src/b.ts", team: true } },
  });
});

test("openFilePreview / openPreview / openInBrowser / openTab 各推一页", () => {
  const { nav, layout } = setup("/m/s/s1");
  layout.openFilePreview("m", "m-chat", "dev1", "/w/x.md");
  expect(nav.route()).toMatchObject({
    tab: { type: "preview", host: "dev1", path: "/w/x.md" },
  });
  layout.openPreview("m", "m-chat", "/w/y.md", true);
  expect(nav.route()).toMatchObject({
    tab: { type: "preview", host: "server", path: "/w/y.md" },
  });
  layout.openInBrowser("m", "p1");
  expect(nav.route()).toMatchObject({ tab: { type: "web", page: "p1" } });
  layout.openTab("m", "sub", { sid: "s1", sub: "e1" });
  expect(nav.route()).toMatchObject({
    tab: { type: "sub", sid: "s1", sub: "e1" },
  });
});

test("从对话页或带会话的标签页打开的标签都带上当前会话（锚点与深链接找回工作区靠它）；自己带了的不覆盖", () => {
  const { nav, layout } = setup("/m/s/s1");
  layout.openInBrowser("m", "p1");
  expect(nav.route()).toMatchObject({ tab: { type: "web", sid: "s1" } });
  layout.openFilePreview("m", "m-web", "server", "/w/a.md");
  expect(nav.route()).toMatchObject({ tab: { type: "preview", sid: "s1" } });
  layout.openTab("m", "sub", { sid: "s9", sub: "e1" });
  expect(nav.route()).toMatchObject({ tab: { sid: "s9" } });
  const list = setup("/m/");
  list.layout.openTab("m", "term", { host: "server" });
  expect(list.nav.route()).toMatchObject({ tab: { type: "term" } });
  expect(
    (list.nav.route() as { tab: { sid?: string } }).tab.sid,
  ).toBeUndefined();
});

test("showSession / pinSession 打开对话页；窗口、窗格这批操作一律不可用", () => {
  const { nav, layout } = setup("/m/");
  expect(layout.showSession("s2")).toBe(true);
  expect(nav.route()).toEqual({ name: "chat", sid: "s2" });
  expect(layout.pinSession("s3")).toBe(true);
  expect(nav.route()).toEqual({ name: "chat", sid: "s3" });
  expect(layout.addWindow()).toBe(false);
  expect(layout.closeTab("m", "m-chat")).toBe(false);
  expect(layout.revealBrowser("p1")).toBe(false);
});

test("状态按路由与工作区缓存：同一路由同一对象，换工作区通知订阅者", async () => {
  const { layout } = setup("/m/s/s1");
  expect(layout.getState()).toBe(layout.getState());
  let n = 0;
  const off = layout.subscribe(() => n++);
  await layout.setWorkspace("w1");
  expect(layout.getState().workspaceId).toBe("w1");
  expect(n).toBe(1);
  off();
});
