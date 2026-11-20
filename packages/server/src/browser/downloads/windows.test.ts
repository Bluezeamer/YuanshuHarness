// 下载窗口：动作期间收、动作外取消、每次最多 3 个、宽限只在没收到时等、动作抛错时取消已收到的。
import { expect, test } from "vitest";
import type { PageDownload } from "../engine/types.js";
import type { PageView } from "../pages/types.js";
import { createDownloadWindows } from "./windows.js";

function fakePage(patch: Partial<PageView> = {}): PageView {
  return {
    id: "p1",
    workspaceKey: "w1",
    url: "https://x.test/",
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
  };
}

function fakeDownload(name = "a.zip") {
  const cancelled: string[] = [];
  const d: PageDownload = {
    filename: name,
    url: `https://x.test/${name}`,
    saveTo: async () => 1,
    cancel: async (reason) => void cancelled.push(reason),
  };
  return { d, cancelled };
}

const windows = (
  parents: Record<string, string> = {},
  userDownloads: Array<{ page: PageView; d: PageDownload }> = [],
) =>
  createDownloadWindows({
    rootOf: (s) => parents[s] ?? s,
    userDownload: (page, d) => void userDownloads.push({ page, d }),
  });

/** 让 dispatch 里 void 出去的 cancel 有机会跑完。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

test("窗口内：动作期间到达的下载被收下", async () => {
  const w = windows();
  const { d } = fakeDownload();
  const got = await w.collect(
    "s1",
    "p1",
    async () => {
      w.dispatch(fakePage(), d);
      return "v";
    },
    0,
  );
  expect(got.value).toBe("v");
  expect(got.downloads).toEqual([d]);
  expect(got.dropped).toBe(0);
});

test("窗口外：取消并写控制台原因；窗口结束后（finally）也不再收", async () => {
  const w = windows();
  const { d, cancelled } = fakeDownload();
  w.dispatch(fakePage(), d);
  await flush();
  expect(cancelled).toEqual(["没有对应的 agent 动作"]);

  const late = fakeDownload();
  await w.collect("s1", "p1", async () => {}, 0);
  w.dispatch(fakePage(), late.d);
  await flush();
  expect(late.cancelled).toEqual(["没有对应的 agent 动作"]);
});

test("pageId 精确匹配优先于 null（新开页面的窗口）", async () => {
  const w = windows();
  const onP1 = fakeDownload("p1.zip");
  const onP2 = fakeDownload("p2.zip");
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // 并行两个窗口：一个不指定页面（新开页面的动作），一个指定 p1。
  const anyPage = w.collect(
    "s1",
    null,
    async () => {
      await gate;
      return "any";
    },
    0,
  );
  const exact = w.collect(
    "s1",
    "p1",
    async () => {
      await gate;
      return "exact";
    },
    0,
  );
  w.dispatch(fakePage({ id: "p1" }), onP1.d);
  w.dispatch(fakePage({ id: "p2" }), onP2.d);
  release();
  const [a, b] = await Promise.all([anyPage, exact]);
  expect(b.downloads).toEqual([onP1.d]);
  expect(a.downloads).toEqual([onP2.d]);
});

test("别的会话的窗口不收（inUseBy 不匹配）", async () => {
  const w = windows();
  const { d, cancelled } = fakeDownload();
  await w.collect(
    "s1",
    "p1",
    async () => {
      // 页面的 inUseBy 是 s2：s1 的窗口不能收
      w.dispatch(fakePage({ inUseBy: "s2" }), d);
    },
    0,
  );
  await flush();
  expect(cancelled).toEqual(["没有对应的 agent 动作"]);
});

test("用户接管的页面：交给 userDownload，不取消", async () => {
  const userDownloads: Array<{ page: PageView; d: PageDownload }> = [];
  const w = windows({}, userDownloads);
  const page = fakePage({ controller: "user" });
  const { d, cancelled } = fakeDownload();
  await w.collect(
    "s1",
    "p1",
    async () => {
      w.dispatch(page, d);
    },
    0,
  );
  await flush();
  expect(userDownloads).toEqual([{ page, d }]);
  expect(cancelled).toEqual([]);
});

test("agent 页：没有窗口就取消，不交给 userDownload", async () => {
  const userDownloads: Array<{ page: PageView; d: PageDownload }> = [];
  const w = windows({}, userDownloads);
  const { d, cancelled } = fakeDownload();
  w.dispatch(fakePage(), d);
  await flush();
  expect(userDownloads).toEqual([]);
  expect(cancelled).toEqual(["没有对应的 agent 动作"]);
});

test("一个窗口最多收 3 个，多出来的取消并记 dropped", async () => {
  const w = windows();
  const list = [1, 2, 3, 4, 5].map((n) => fakeDownload(`${n}.zip`));
  const got = await w.collect(
    "s1",
    "p1",
    async () => {
      for (const { d } of list) w.dispatch(fakePage(), d);
    },
    0,
  );
  expect(got.downloads).toHaveLength(3);
  expect(got.dropped).toBe(2);
  await flush();
  expect(list[3]?.cancelled).toEqual(["一次动作最多收 3 个下载"]);
  expect(list[4]?.cancelled).toEqual(["一次动作最多收 3 个下载"]);
  expect(list[0]?.cancelled).toEqual([]);
});

test("宽限：没收到时等 graceMs，收到了就不等", async () => {
  const w = windows();
  const t0 = Date.now();
  await w.collect("s1", "p1", async () => {}, 60);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(55);

  const { d } = fakeDownload();
  const t1 = Date.now();
  const got = await w.collect(
    "s1",
    "p1",
    async () => {
      w.dispatch(fakePage(), d);
    },
    60,
  );
  expect(Date.now() - t1).toBeLessThan(50);
  expect(got.downloads).toEqual([d]);
});

test("fn 抛错：已收到的下载全部取消，错误原样抛出", async () => {
  const w = windows();
  const { d, cancelled } = fakeDownload();
  const boom = new Error("点击失败");
  const err = await w
    .collect(
      "s1",
      "p1",
      async () => {
        w.dispatch(fakePage(), d);
        throw boom;
      },
      0,
    )
    .catch((e: unknown) => e);
  await flush();
  expect(err).toBe(boom);
  expect(cancelled).toEqual(["动作失败"]);
});

test("子代理会话的窗口按根会话匹配", async () => {
  const w = windows({ sub: "root" });
  const { d } = fakeDownload();
  const got = await w.collect(
    "sub",
    "p1",
    async () => {
      // 页面归根会话在用
      w.dispatch(fakePage({ usedBy: ["root"], inUseBy: "root" }), d);
    },
    0,
  );
  expect(got.downloads).toEqual([d]);
});
