// 文件页自动刷新：只有 agent 控制、激活中的文件页才监听所在目录；事件按 key 前缀分发。
import { expect, test } from "vitest";
import { createFileReload } from "./reload.js";
import type { PageView } from "./types.js";

function setup() {
  const sets: Array<{ key: string; envId: string; paths: string[] }> = [];
  const released: string[] = [];
  const reloaded: string[] = [];
  const listeners: Array<(key: string, env: string, paths: string[]) => void> =
    [];
  const reload = createFileReload({
    watch: {
      set: (key, envId, paths) =>
        void sets.push({ key, envId, paths: [...paths] }),
      release: (key) => void released.push(key),
      onChanged: (cb) => {
        listeners.push(cb);
        return () => {};
      },
    },
    reload: async (id) => void reloaded.push(id),
  });
  const changed = (key: string) => {
    for (const cb of listeners) cb(key, "local", ["/a"]);
  };
  return { reload, sets, released, reloaded, changed };
}

const page = (patch: Partial<PageView> = {}): PageView => ({
  id: "p1",
  workspaceKey: "w1",
  url: "http://server.files.localhost/srv/app/index.html",
  title: "",
  state: "active",
  controller: "agent",
  userOpened: false,
  usedBy: ["s1"],
  inUseBy: "s1",
  loading: false,
  hasThumb: false,
  epoch: 0,
  viewers: 0,
  handoffPending: false,
  handoffReason: null,
  pendingDownloads: [],
  pendingUpload: null,
  dialog: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

test("激活的 agent 文件页：监听所在目录，envId 正确", () => {
  const s = setup();
  s.reload.track(page());
  expect(s.sets).toEqual([
    { key: "browser:p1", envId: "local", paths: ["/srv/app"] },
  ]);
  expect(s.released).toEqual([]);
});

test("中文与空格、% 编码的路径：按解码后的绝对路径取目录", () => {
  const s = setup();
  s.reload.track(
    page({
      url: "http://gpu1.files.localhost/srv/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/index.html",
    }),
  );
  expect(s.sets).toEqual([
    { key: "browser:p1", envId: "gpu1", paths: ["/srv/中文 目录"] },
  ]);
});

test("用户控制的页、休眠的页：不监听（退订）", () => {
  const s = setup();
  s.reload.track(page({ controller: "user" }));
  s.reload.track(page({ state: "sleeping" }));
  expect(s.sets).toEqual([]);
  expect(s.released).toEqual(["browser:p1", "browser:p1"]);
});

test("普通 https 页、服务页：不监听（退订）", () => {
  const s = setup();
  s.reload.track(page({ url: "https://example.com/index.html" }));
  s.reload.track(page({ url: "http://server.localhost:3000/index.html" }));
  expect(s.sets).toEqual([]);
  expect(s.released).toEqual(["browser:p1", "browser:p1"]);
});

test("地址解析不了不抛，当作不是文件页", () => {
  const s = setup();
  expect(() => s.reload.track(page({ url: "about:blank" }))).not.toThrow();
  expect(() => s.reload.track(page({ url: "不是地址" }))).not.toThrow();
  expect(s.sets).toEqual([]);
  expect(s.released).toEqual(["browser:p1", "browser:p1"]);
});

test("forget：退订", () => {
  const s = setup();
  s.reload.track(page());
  s.reload.forget("p1");
  expect(s.released).toEqual(["browser:p1"]);
});

test("同一页反复 track 结果不变（幂等）", () => {
  const s = setup();
  const p = page();
  s.reload.track(p);
  s.reload.track(p);
  expect(s.sets).toEqual([
    { key: "browser:p1", envId: "local", paths: ["/srv/app"] },
    { key: "browser:p1", envId: "local", paths: ["/srv/app"] },
  ]);
  expect(s.released).toEqual([]);
});

test("变化事件：browser: 前缀的才刷新，别的 key 不触发", () => {
  const s = setup();
  s.changed("browser:p1");
  s.changed("session-abc");
  s.changed("browser2:p2");
  expect(s.reloaded).toEqual(["p1"]);
});
