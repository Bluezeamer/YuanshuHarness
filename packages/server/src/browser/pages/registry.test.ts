// 页面模型的关键路径与每条拒绝分支。全部用替身：不装浏览器、不起进程。
import { afterAll, expect, test } from "vitest";
import { cleanupTmpDirs, FakePage, makeRegistry } from "./testkit.js";
import { PageError, type PageView } from "./types.js";

afterAll(cleanupTmpDirs);

const open = (
  h: ReturnType<typeof makeRegistry>,
  actor: string | null,
  url = "https://x.test/",
) => h.registry.open({ workspaceKey: "w1", actor, url });

const err = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(PageError);
  return e as PageError;
};

test("agent 开的页面：agent 操作、usedBy 含根会话、先登记后导航", async () => {
  const h = makeRegistry();
  const { page, status } = await open(h, "s1");
  expect(page.controller).toBe("agent");
  expect(page.userOpened).toBe(false);
  expect(page.usedBy).toEqual(["s1"]);
  expect(page.inUseBy).toBe("s1");
  expect(page.state).toBe("active");
  expect(status).toBe(200);
  expect(h.registry.list("w1").map((p) => p.id)).toEqual([page.id]);
});

test("用户开的页面：controller 是 user、userOpened、不参与引用计数", async () => {
  const h = makeRegistry();
  const { page } = await open(h, null);
  expect(page.controller).toBe("user");
  expect(page.userOpened).toBe(true);
  expect(page.usedBy).toEqual([]);
  expect(page.inUseBy).toBeNull();
});

test("goto 失败：页面仍在列表里，错误抛给调用方", async () => {
  const h = makeRegistry();
  h.onCtx = (c) => {
    c.pageInit = (p) => {
      p.gotoError = new Error("ERR_CONNECTION_REFUSED");
    };
  };
  await expect(open(h, "s1")).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
  expect(h.registry.list("w1")).toHaveLength(1);
  expect(h.registry.list("w1")[0]?.id).toMatch(/^p[a-z0-9]{5}$/);
});

test("操作权：用户在操作时 act 被拒、observe 照常；交还后 epoch 加一", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.registry.control(page.id, "user");
  const denied = await err(h.registry.use(page.id, "s1", "act"));
  expect(denied.code).toBe("user_controlling");
  expect(denied.message).toContain("用户正在操作");
  // 只读不受限
  await expect(h.registry.use(page.id, "s9", "observe")).resolves.toBeDefined();

  const back = h.registry.control(page.id, "agent");
  expect(back.epoch).toBe(1);
  await expect(h.registry.use(page.id, "s1", "act")).resolves.toBeDefined();
  // 再切回 user 又被拒
  h.registry.control(page.id, "user");
  expect((await err(h.registry.use(page.id, "s1", "act"))).code).toBe(
    "user_controlling",
  );
});

test("用户页交给 agent 后才能动手", async () => {
  const h = makeRegistry();
  const { page } = await open(h, null);
  const denied = await err(h.registry.use(page.id, "s1", "act"));
  expect(denied.code).toBe("user_controlling");
  expect(denied.message).toContain("用户自己打开");

  h.registry.control(page.id, "agent");
  await expect(h.registry.use(page.id, "s1", "act")).resolves.toBeDefined();
  expect(h.registry.get(page.id)?.usedBy).toEqual(["s1"]);
});

test("认领：在用的会话忙时拒绝，空闲时自动认领并记进 usedBy", async () => {
  const h = makeRegistry();
  h.labels.set("s1", "登录调试");
  const { page } = await open(h, "s1");

  h.busy.add("s1");
  const busy = await err(h.registry.use(page.id, "s2", "act"));
  expect(busy.code).toBe("busy");
  expect(busy.message).toContain("登录调试");
  // 只读不受限
  await expect(h.registry.use(page.id, "s2", "observe")).resolves.toBeDefined();

  h.busy.delete("s1");
  await h.registry.use(page.id, "s2", "act");
  const view = h.registry.get(page.id);
  expect(view?.inUseBy).toBe("s2");
  expect(view?.usedBy).toEqual(["s1", "s2"]);
  expect(h.store.get(page.id)?.usedBy).toEqual(["s1", "s2"]);
});

test("子代理按根会话算", async () => {
  const h = makeRegistry();
  h.parents.set("child", "root");
  const { page } = await open(h, "child");
  expect(page.usedBy).toEqual(["root"]);
  expect(page.inUseBy).toBe("root");
  // 另一个子代理也算同一个根：不冲突
  h.parents.set("child2", "root");
  await expect(h.registry.use(page.id, "child2", "act")).resolves.toBeDefined();

  h.busy.add("root");
  h.parents.set("other", "root2");
  expect((await err(h.registry.use(page.id, "other", "act"))).code).toBe(
    "busy",
  );
});

test("引用计数：最后一个会话释放时关闭并删记录，用户页不关", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const handle = (h.ctx("w1").pages[0] ?? null) as unknown as {
    calls: string[];
  };
  await h.registry.use(page.id, "s2", "act");

  expect(await h.registry.releaseSession("s1")).toEqual([]);
  expect(h.registry.get(page.id)?.usedBy).toEqual(["s2"]);
  // 库里也要跟着去掉，别只改内存
  expect(h.store.get(page.id)?.usedBy).toEqual(["s2"]);

  expect(await h.registry.releaseSession("s2")).toEqual([page.id]);
  expect(h.registry.get(page.id)).toBeNull();
  expect(h.store.get(page.id)).toBeUndefined();
  expect(handle.calls).toContain("close");

  // 用户页：released 也不关
  const mine = await open(h, null);
  expect(await h.registry.releaseSession("s3")).toEqual([]);
  expect(h.registry.get(mine.page.id)?.state).toBe("active");
});

test("用户正在操作的 agent 页面：会话释放时转成用户页而不是关闭", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.registry.control(page.id, "user");
  expect(await h.registry.releaseSession("s1")).toEqual([]);
  const view = h.registry.get(page.id);
  expect(view?.userOpened).toBe(true);
  expect(view?.state).toBe("active");
  expect(h.store.get(page.id)?.row.userOpened).toBe(true);
});

test("agent 不能关用户页，也不是自己的页面不能关；用户能关任何页面", async () => {
  const h = makeRegistry();
  const mine = await open(h, null);
  const denied = await h.registry
    .close(mine.page.id, { session: "s1" })
    .catch((e) => e);
  expect(denied.code).toBe("user_page");
  expect(denied.message).toContain("只有用户能关闭");

  const other = await open(h, "s1");
  const notMine = await h.registry
    .close(other.page.id, { session: "s3" })
    .catch((e) => e);
  expect(notMine.code).toBe("user_page");
  expect(notMine.message).toContain("不是你用过的页面");

  await h.registry.close(mine.page.id, "user");
  expect(h.registry.get(mine.page.id)).toBeNull();
  await h.registry.close(other.page.id, { session: "s1" });
  expect(h.registry.get(other.page.id)).toBeNull();
});

test("用户操作中的 agent 页面不能被 agent 关", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.registry.control(page.id, "user");
  const e = await h.registry.close(page.id, { session: "s1" }).catch((x) => x);
  expect(e.code).toBe("user_page");
});

test("休眠：达到工作区上限时休眠最久没用的，缩略图与记录保留", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 2 } });
  const a = await open(h, "s1", "https://a.test/");
  const b = await open(h, "s1", "https://b.test/");
  const c = await open(h, "s1", "https://c.test/");

  const sleeping = h.registry.list("w1").filter((p) => p.state === "sleeping");
  expect(sleeping.map((p) => p.id)).toEqual([a.page.id]);
  expect(sleeping[0]?.hasThumb).toBe(true);
  expect(b.page.state).toBe("active");
  expect(c.page.state).toBe("active");
  // 真页面被关掉了
  const firstHandle = h.ctx("w1").pages[0];
  expect(firstHandle?.calls).toContain("screenshot");
  expect(firstHandle?.closed).toBe(true);
});

test("受保护的页面不被休眠：全受保护时抛 limit", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 2 } });
  const a = await open(h, "s1");
  const b = await open(h, "s1");
  h.registry.control(a.page.id, "user");
  const off = h.registry.watch(b.page.id);

  const e = await err(open(h, "s1"));
  expect(e.code).toBe("limit");
  expect(e.message).toContain("2 个页面");
  expect(e.message).toContain("使用中");

  // 取消观看后就能休眠了
  off();
  const { page } = await open(h, "s1");
  expect(h.registry.get(b.page.id)?.state).toBe("sleeping");
  expect(page.state).toBe("active");
});

test("等接管答复的页面不被休眠", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1");
  const wait = h.registry.beginHandoff(a.page.id, "需要登录");
  expect(h.registry.get(a.page.id)?.handoffPending).toBe(true);
  expect(h.registry.get(a.page.id)?.handoffReason).toBe("需要登录");
  expect((await err(open(h, "s1"))).code).toBe("limit");
  wait.end();
  expect(h.registry.get(a.page.id)?.handoffPending).toBe(false);
  expect(h.registry.get(a.page.id)?.handoffReason).toBeNull();
  await expect(open(h, "s1")).resolves.toBeDefined();
});

test("接管等待：用户答复结算 answered；没有人在等返回 false", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  expect(h.registry.answerHandoff(page.id, { kind: "done" })).toBe(false);
  const wait = h.registry.beginHandoff(page.id, "需要登录");
  expect(
    h.registry.answerHandoff(page.id, { kind: "refused", reason: "不行" }),
  ).toBe(true);
  await expect(wait.answered).resolves.toEqual({
    kind: "refused",
    reason: "不行",
  });
  wait.end();
  expect(h.registry.answerHandoff(page.id, { kind: "done" })).toBe(false);
});

test("交还 agent 就是接管完成：等着的请求结算为 done，页面本来在 agent 手里也一样", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const wait = h.registry.beginHandoff(page.id, "需要登录");
  h.registry.control(page.id, "agent");
  await expect(wait.answered).resolves.toEqual({ kind: "done" });
  wait.end();
  // 用户操作后交还：同样结算，并且 epoch 只加一次
  const again = h.registry.beginHandoff(page.id, "需要登录");
  h.registry.control(page.id, "user");
  h.registry.control(page.id, "agent");
  await expect(again.answered).resolves.toEqual({ kind: "done" });
  expect(h.registry.get(page.id)?.epoch).toBe(1);
  again.end();
});

test("先 end 的旧等待不会清掉后来的等待", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const first = h.registry.beginHandoff(page.id, "需要登录");
  const second = h.registry.beginHandoff(page.id, "需要登录");
  first.end();
  expect(h.registry.get(page.id)?.handoffPending).toBe(true);
  expect(h.registry.answerHandoff(page.id, { kind: "done" })).toBe(true);
  await expect(second.answered).resolves.toEqual({ kind: "done" });
  second.end();
});

test("全局上限：跨键也只按最久没用休眠", async () => {
  const h = makeRegistry({ limits: { global: 2 } });
  const a = await h.registry.open({
    workspaceKey: "w1",
    actor: "s1",
    url: "https://a.test/",
  });
  const b = await h.registry.open({
    workspaceKey: "w2",
    actor: "s1",
    url: "https://b.test/",
  });
  await h.registry.open({
    workspaceKey: "w2",
    actor: "s1",
    url: "https://c.test/",
  });
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
  expect(h.registry.get(b.page.id)?.state).toBe("active");
  expect(h.ctx("w1").pages[0]?.closed).toBe(true);
});

test("唤醒休眠页面：重新开真页面并导航，并发唤醒只创建一个", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1", "https://a.test/");
  await open(h, "s1", "https://b.test/");
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
  const created = h.ctx("w1").pages.length;

  const [x, y] = await Promise.all([
    h.registry.use(a.page.id, "s1", "observe"),
    h.registry.use(a.page.id, "s1", "observe"),
  ]);
  expect(x).toBe(y);
  // 并发只创建一个真页面
  expect(h.ctx("w1").pages).toHaveLength(created + 1);
  expect(h.registry.get(a.page.id)?.state).toBe("active");
  expect(h.registry.get(a.page.id)?.url).toBe("https://a.test/");
});

test("休眠页被休眠两次不会重复建真页面（use + 唤醒中又有 open 触发上限）", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1", "https://a.test/");
  await open(h, "s1", "https://b.test/");
  const created = h.ctx("w1").pages.length;
  await h.registry.use(a.page.id, "s1", "act");
  await h.registry.use(a.page.id, "s2", "observe");
  expect(h.ctx("w1").pages).toHaveLength(created + 1);
});

test("休眠记录超出上限时删最久没用的非用户页", async () => {
  const h = makeRegistry({
    limits: { perWorkspace: 1, sleepingPerWorkspace: 1 },
  });
  await open(h, "s1", "https://old.test/");
  await open(h, "s1", "https://mid.test/");
  // 开第三个：最久的 old 休眠，此时休眠记录 2 条，超出 1，删掉更久的 old
  const { page } = await open(h, "s1", "https://new.test/");
  const ids = h.registry.list("w1").map((p) => p.id);
  expect(ids).toContain(page.id);
  expect(
    h.registry.list("w1").filter((p) => p.state === "sleeping"),
  ).toHaveLength(1);
  expect(h.registry.list("w1")).toHaveLength(2);
});

test("用户的休眠记录不自动删", async () => {
  const h = makeRegistry({
    limits: { perWorkspace: 2, sleepingPerWorkspace: 0 },
  });
  const mine = await open(h, null, "https://mine.test/");
  await open(h, "s1", "https://a.test/");
  await open(h, "s1", "https://b.test/");
  expect(h.registry.get(mine.page.id)?.state).toBe("active");

  // 用户把页面交还 agent 后可以休眠，但作为用户页不会被自动删。
  h.registry.control(mine.page.id, "agent");
  await h.registry.sleep(mine.page.id);
  expect(h.registry.get(mine.page.id)?.state).toBe("sleeping");
  await open(h, "s1", "https://c.test/");
  expect(h.registry.get(mine.page.id)).not.toBeNull();
});

test("用户操作中的页面不能休眠", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.registry.control(page.id, "user");
  const e = await h.registry.sleep(page.id).catch((x) => x);
  expect(e.code).toBe("user_controlling");
});

test("休眠幂等：已是休眠页再睡一次不报错也不多事", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1");
  await open(h, "s1");
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
  const seen: string[] = [];
  h.registry.subscribe((e) => {
    if (e.type !== "removed") seen.push(e.type);
  });
  await h.registry.sleep(a.page.id);
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
  expect(seen).toEqual([]);
});

test("watcher 摘除后 viewers 归零；页面已被删时取消观看也不出错", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const { page } = await open(h, "s1");
  const viewers: number[] = [];
  h.registry.subscribe((e) => {
    if (e.type !== "removed" && e.page.id === page.id)
      viewers.push(e.page.viewers);
  });
  const off = h.registry.watch(page.id);
  expect(h.registry.get(page.id)?.viewers).toBe(1);
  expect(viewers).toContain(1);
  off();
  expect(h.registry.get(page.id)?.viewers).toBe(0);
  expect(viewers.at(-1)).toBe(0);
  // 已被删的页面上取消观看不能报错
  const offGone = h.registry.watch(page.id);
  await h.registry.close(page.id, "user");
  expect(() => offGone()).not.toThrow();
  expect(h.registry.get(page.id)).toBeNull();
});

test("唤醒途中浏览器崩溃：这次唤醒报错，不会拿到旧进程的页面", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1");
  await open(h, "s1");
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");

  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started = () => {};
  const reached = new Promise<void>((r) => {
    started = r;
  });
  const ctx = h.ctx("w1");
  ctx.newPage = async () => {
    started();
    await gate;
    const p = new FakePage();
    ctx.pages.push(p);
    return p;
  };
  const waking = h.registry.use(a.page.id, "s1", "observe");
  // 等唤醒真的走到 newPage，再让浏览器崩
  await reached;
  h.registry.onEngineCrash();
  release();
  const e = await err(waking);
  expect(e.code).toBe("context_failed");
  expect(e.message).toContain("浏览器刚重启过");
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
});

test("恢复：重启后全部休眠，多余的缩略图被清掉", async () => {
  const h = makeRegistry();
  const a = await open(h, "s1", "https://a.test/");
  const b = await open(h, "s1", "https://b.test/");
  h.thumbs.save("orphan", Buffer.from("stale"));
  h.thumbs.save(a.page.id, Buffer.from("jpeg"));
  // 模拟进程退出：先停注册表（排队的写库也一起取消），再关库
  await h.registry.dispose();
  h.db.close();

  // 用同一个库与缩略图目录新建一个注册表（模拟重启）
  const { PageRegistry } = await import("./registry.js");
  const { BrowserPageStore } = await import("../../store/browser-pages.js");
  const { openDatabase } = await import("../../store/db.js");
  const reopened = openDatabase(h.dataDir);
  const next = new PageRegistry({
    store: new BrowserPageStore(reopened),
    thumbs: h.thumbs,
    context: async () => {
      const { FakeCtx } = await import("./testkit.js");
      return new FakeCtx();
    },
    rootOf: (s) => s,
    isBusy: () => false,
    onDownload: () => {},
    onFileChooser: () => {},
  });
  next.restore();
  expect(next.list("w1").map((p) => [p.id, p.state])).toEqual([
    [b.page.id, "sleeping"],
    [a.page.id, "sleeping"],
  ]);
  expect(next.get(a.page.id)?.userOpened).toBe(false);
  // 库里的记录都在，有记录的缩略图留着，孤儿文件被清掉
  expect(h.thumbs.has("orphan")).toBe(false);
  expect(h.thumbs.has(a.page.id)).toBe(true);
  expect(next.get(a.page.id)?.hasThumb).toBe(true);
  await next.dispose();
  reopened.close();
});

test("崩溃：激活页面全转休眠，再 use 会重新创建上下文与页面", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const updated: string[] = [];
  h.registry.subscribe((e) => {
    if (e.type !== "removed") updated.push(e.page.id);
  });
  h.registry.onEngineCrash();
  expect(h.registry.get(page.id)?.state).toBe("sleeping");
  expect(h.registry.get(page.id)?.loading).toBe(false);
  expect(updated).toContain(page.id);

  // 已经休眠的页面再撞上一次崩溃不会多出事件
  updated.length = 0;
  h.registry.onEngineCrash();
  expect(updated).toEqual([]);

  const before = h.ctx("w1");
  await h.registry.use(page.id, "s1", "act");
  const after = h.ctx("w1");
  expect(after).not.toBe(before);
  expect(h.registry.get(page.id)?.state).toBe("active");
});

test("弹窗：登记新记录并继承来源的归属", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.registry.control(page.id, "agent");
  const source = h.ctx("w1").pages[0];
  const popup = h.ctx("w1").popup(source ?? null, "https://popup.test/");

  const added = h.registry
    .list("w1")
    .find((p) => p.url === "https://popup.test/");
  expect(added).toBeDefined();
  expect(added?.controller).toBe("agent");
  expect(added?.userOpened).toBe(false);
  expect(added?.usedBy).toEqual(["s1"]);
  expect(added?.inUseBy).toBe("s1");
  expect(popup.closed).toBe(false);

  // 页面自己关了：删记录
  popup.fireClose();
  expect(h.registry.list("w1").map((p) => p.id)).toEqual([page.id]);
});

test("页面自己关掉（非我们关的）→ 删记录", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.ctx("w1").pages[0]?.fireClose();
  expect(h.registry.get(page.id)).toBeNull();
  expect(h.store.get(page.id)).toBeUndefined();
});

test("动手被拒时不去唤醒休眠页面", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1");
  await open(h, "s1");
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
  h.registry.control(a.page.id, "user");
  const created = h.ctx("w1").pages.length;

  const e = await err(h.registry.use(a.page.id, "s1", "act"));
  expect(e.code).toBe("user_controlling");
  expect(h.ctx("w1").pages).toHaveLength(created);
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
});

test("user 操作中的页面不能休眠", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.registry.control(page.id, "user");
  expect((await err(h.registry.sleep(page.id))).code).toBe("user_controlling");
  // 有观众 / 等接管答复时同样不能
  h.registry.control(page.id, "agent");
  const off = h.registry.watch(page.id);
  expect((await err(h.registry.sleep(page.id))).message).toContain("被查看");
  off();
  const wait = h.registry.beginHandoff(page.id, "需要登录");
  expect((await err(h.registry.sleep(page.id))).message).toContain("接管请求");
  wait.end();
});

test("关页面时删掉它的缩略图", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1");
  await open(h, "s1");
  expect(h.thumbs.has(a.page.id)).toBe(true);
  await h.registry.close(a.page.id, "user");
  expect(h.thumbs.has(a.page.id)).toBe(false);
});

test("forgetWorkspace：该键页面与上下文都关掉，别的键不受影响", async () => {
  const h = makeRegistry();
  const own = await open(h, "s1");
  const other = await h.registry.open({
    workspaceKey: "w2",
    actor: "s1",
    url: "https://b.test/",
  });
  const ctx = h.ctx("w1");
  // 先睡一次留一张缩略图，删工作区时要一起清掉
  h.thumbs.save(own.page.id, Buffer.from("jpeg"));
  await h.registry.forgetWorkspace("w1");
  expect(h.registry.list("w1")).toEqual([]);
  expect(h.store.list("w1")).toEqual([]);
  expect(h.thumbs.has(own.page.id)).toBe(false);
  expect(ctx.closed).toBe(true);
  expect(h.registry.get(other.page.id)?.state).toBe("active");
});

test("storageState：上下文在时返回它的状态，不在时 null，别的工作区读不到", async () => {
  const h = makeRegistry();
  expect(await h.registry.storageState("w1")).toBeNull();

  await open(h, "s1");
  const own = h.ctx("w1");
  own.storageState = async () => ({
    cookies: [],
    origins: [{ origin: "https://x.test", localStorage: [] }],
  });
  expect(await h.registry.storageState("w1")).toEqual({
    cookies: [],
    origins: [{ origin: "https://x.test", localStorage: [] }],
  });
  // 没起过上下文的工作区不会被别人的状态串过来
  expect(await h.registry.storageState("w2")).toBeNull();

  // 浏览器崩过：上下文表清空，再问就是 null
  h.registry.onEngineCrash();
  expect(await h.registry.storageState("w1")).toBeNull();
});

test("事件：added / updated / removed 都发出，订阅者抛错不影响注册表", async () => {
  const h = makeRegistry();
  const seen: string[] = [];
  h.registry.subscribe((e) => seen.push(e.type));
  h.registry.subscribe(() => {
    throw new Error("boom");
  });
  const { page } = await open(h, "s1");
  h.registry.control(page.id, "user");
  await h.registry.close(page.id, "user");
  expect(seen).toContain("added");
  expect(seen).toContain("updated");
  expect(seen).toContain("removed");
  expect(h.registry.list("w1")).toEqual([]);
});

test("onChange 更新地址与标题，写库按 500ms 合并", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const fake = h.ctx("w1").pages[0];
  // 两次变化接得很紧：内存里是最新的，库里还是旧值，到点后一次写入带上两者。
  fake?.setUrl("https://x.test/a", "A");
  await Promise.resolve();
  fake?.setUrl("https://x.test/b", "B");
  await Promise.resolve();
  const view = h.registry.get(page.id);
  expect(view?.url).toBe("https://x.test/b");
  expect(view?.title).toBe("B");
  expect(h.store.get(page.id)?.row.url).not.toBe("https://x.test/b");

  await new Promise((r) => setTimeout(r, 600));
  expect(h.store.get(page.id)?.row.url).toBe("https://x.test/b");
  expect(h.store.get(page.id)?.row.title).toBe("B");
});

test("上下文创建失败包装成 context_failed", async () => {
  const h = makeRegistry({
    context: async () => {
      throw new Error("浏览器没装好");
    },
  });
  const e = await err(open(h, "s1"));
  expect(e.code).toBe("context_failed");
  expect(e.message).toContain("浏览器没装好");
});

test("没有这个页面：not_found", async () => {
  const h = makeRegistry();
  expect((await err(h.registry.use("nope", "s1", "observe"))).code).toBe(
    "not_found",
  );
});

test("dispose 关真页面与上下文，但记录还在", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const ctx = h.ctx("w1");
  await h.registry.dispose();
  expect(ctx.closed).toBe(true);
  expect(h.registry.get(page.id)).not.toBeNull();
});

test("页面正在被关闭的窗口里再触发上限休眠：不会空转挂死", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 2 } });
  const a = await open(h, "s1", "https://a.test/");
  await open(h, "s1", "https://b.test/");
  // 让 a 的真页面关得慢：此时记录还在、handle 已摘掉
  const slow = h.ctx("w1").pages[0] as FakePage;
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const realClose = slow.close.bind(slow);
  slow.close = async () => {
    await gate;
    await realClose();
  };
  const closing = h.registry.close(a.page.id, "user");
  // 关页面进行中，另一个会话在上限边上开页面：不能把正在关的页面当休眠对象反复挑
  const racing = Promise.race([
    open(h, "s2", "https://c.test/"),
    new Promise<string>((r) => setTimeout(() => r("hang"), 1500)),
  ]);
  setTimeout(release, 100);
  const got = await racing;
  await closing;
  expect(got).not.toBe("hang");
}, 10_000);

test("弹窗不受上限约束就会被广告页刷出无数真页面：到上限时直接关掉", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 2 } });
  const { page } = await open(h, "s1");
  const source = h.ctx("w1").pages[0];
  const p1 = h.ctx("w1").popup(source ?? null, "https://p1.test/");
  const p2 = h.ctx("w1").popup(source ?? null, "https://p2.test/");
  const active = () =>
    h.registry.list("w1").filter((p) => p.state === "active");
  expect(active()).toHaveLength(2);
  expect(p1.closed).toBe(false);
  // 第 3 个已经没位置：关掉，不登记
  expect(p2.closed).toBe(true);
  expect(h.registry.list("w1").some((p) => p.url === "https://p2.test/")).toBe(
    false,
  );
  expect(h.registry.get(page.id)).not.toBeNull();
});

test("用户页被 agent 用过、最后一个会话释放后：回到手动状态，页面还在", async () => {
  const h = makeRegistry();
  const { page } = await open(h, null);
  h.registry.control(page.id, "agent");
  await h.registry.use(page.id, "s1", "act");
  expect(h.registry.get(page.id)?.usedBy).toEqual(["s1"]);
  await h.registry.releaseSession("s1");
  const after = h.registry.get(page.id);
  expect(after).not.toBeNull();
  expect(after?.userOpened).toBe(true);
  expect(after?.usedBy).toEqual([]);
  expect(after?.controller).toBe("user");
});

test("释放子代理会话不会放掉根会话的页面", async () => {
  const h = makeRegistry();
  h.parents.set("child", "root");
  const { page } = await open(h, "root");
  await h.registry.use(page.id, "child", "act");
  expect(await h.registry.releaseSession("child")).toEqual([]);
  expect(h.registry.get(page.id)?.usedBy).toEqual(["root"]);
});

test("peek：激活页面给句柄，休眠页与不存在的页面给 null，且不唤醒", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1", "https://a.test/");
  const handle = await h.registry.use(a.page.id, "s1", "observe");
  expect(h.registry.peek(a.page.id)).toBe(handle);
  await open(h, "s1", "https://b.test/");
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");
  const created = h.ctx("w1").pages.length;
  expect(h.registry.peek(a.page.id)).toBeNull();
  expect(h.registry.peek("nope")).toBeNull();
  expect(h.ctx("w1").pages).toHaveLength(created);
});

test("activate：用户唤醒休眠页，不认领；已激活的原样返回；不存在报 not_found", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 1 } });
  const a = await open(h, "s1", "https://a.test/");
  await open(h, "s1", "https://b.test/");
  expect(h.registry.get(a.page.id)?.state).toBe("sleeping");

  const woke = await h.registry.activate(a.page.id);
  expect(woke.state).toBe("active");
  expect(woke.url).toBe("https://a.test/");
  expect(woke.usedBy).toEqual(["s1"]);
  expect(h.registry.peek(a.page.id)).not.toBeNull();

  const created = h.ctx("w1").pages.length;
  await h.registry.activate(a.page.id);
  expect(h.ctx("w1").pages).toHaveLength(created);
  expect((await err(h.registry.activate("nope"))).code).toBe("not_found");
});

test("noteActivity：用户在页面上操作后，它不再是最久没用的那个", async () => {
  const h = makeRegistry({ limits: { perWorkspace: 2 } });
  const a = await open(h, "s1", "https://a.test/");
  const b = await open(h, "s1", "https://b.test/");
  h.registry.noteActivity(a.page.id);
  h.registry.noteActivity("nope"); // 不存在的页面：什么也不发生
  await open(h, "s1", "https://c.test/");
  expect(h.registry.get(a.page.id)?.state).toBe("active");
  expect(h.registry.get(b.page.id)?.state).toBe("sleeping");
});

test("limitsView：给出生效的上限（覆盖项生效，其余用默认）", () => {
  const h = makeRegistry({ limits: { perWorkspace: 3 } });
  expect(h.registry.limitsView()).toEqual({
    perWorkspace: 3,
    global: 30,
    sleepingPerWorkspace: 100,
  });
});

test("下载：带着当时的 PageView 到达 onDownload（controller、inUseBy、id、url 都是页面的现状）", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1", "https://a.test/");
  const fake = h.ctx("w1").pages[0] as FakePage;
  const d = {
    filename: "a.zip",
    url: "https://a.test/a.zip",
    saveTo: async () => 1,
    cancel: async () => {},
  };
  fake.emitDownload(d);

  expect(h.downloads).toHaveLength(1);
  const got = h.downloads[0];
  expect(got?.download).toBe(d);
  expect(got?.page.id).toBe(page.id);
  expect(got?.page.url).toBe("https://a.test/");
  expect(got?.page.controller).toBe("agent");
  expect(got?.page.inUseBy).toBe("s1");
});

test("下载：弹窗页面走同一个 bind，下载也带着弹窗自己的 PageView 到达", async () => {
  const h = makeRegistry();
  await open(h, "s1");
  const popup = h
    .ctx("w1")
    .popup(h.ctx("w1").pages[0] ?? null, "https://p.test/");
  popup.emitDownload({
    filename: "p.pdf",
    url: "https://p.test/p.pdf",
    saveTo: async () => 1,
    cancel: async () => {},
  });

  expect(h.downloads).toHaveLength(1);
  expect(h.downloads[0]?.page.url).toBe("https://p.test/");
  expect(h.downloads[0]?.page.controller).toBe("agent");
  expect(h.downloads[0]?.page.userOpened).toBe(false);
});

// —— 用户页上挂起的下载 ——

test("setPendingDownloads：写进内存状态并通知订阅者", async () => {
  const h = makeRegistry();
  const seen: PageView[] = [];
  h.registry.subscribe((e) => {
    if (e.type === "updated") seen.push(e.page);
  });
  const { page } = await open(h, null);
  expect(page.pendingDownloads).toEqual([]);
  h.registry.setPendingDownloads(page.id, [
    { id: "abc1234567", filename: "报告.zip" },
  ]);
  expect(h.registry.get(page.id)?.pendingDownloads).toEqual([
    { id: "abc1234567", filename: "报告.zip" },
  ]);
  expect(seen.at(-1)?.pendingDownloads).toEqual([
    { id: "abc1234567", filename: "报告.zip" },
  ]);
});

test("setPendingDownloads：空 → 空不发事件；页面不存在不抛", async () => {
  const h = makeRegistry();
  const { page } = await open(h, null);
  let events = 0;
  h.registry.subscribe(() => {
    events += 1;
  });
  h.registry.setPendingDownloads(page.id, []);
  expect(events).toBe(0);
  h.registry.setPendingDownloads("pnope", [{ id: "x", filename: "a.zip" }]);
  expect(events).toBe(0);
});

// —— 用户页上等用户选文件的选择器 ——

test("setPendingUpload：写进内存状态并通知订阅者", async () => {
  const h = makeRegistry();
  const seen: PageView[] = [];
  h.registry.subscribe((e) => {
    if (e.type === "updated") seen.push(e.page);
  });
  const { page } = await open(h, null);
  expect(page.pendingUpload).toBeNull();
  h.registry.setPendingUpload(page.id, { id: "abc1234567", multiple: true });
  expect(h.registry.get(page.id)?.pendingUpload).toEqual({
    id: "abc1234567",
    multiple: true,
  });
  expect(seen.at(-1)?.pendingUpload).toEqual({
    id: "abc1234567",
    multiple: true,
  });
});

test("setPendingUpload：null → null 不发事件；页面不存在不抛", async () => {
  const h = makeRegistry();
  const { page } = await open(h, null);
  let events = 0;
  h.registry.subscribe(() => {
    events += 1;
  });
  h.registry.setPendingUpload(page.id, null);
  expect(events).toBe(0);
  // 同一项写两次也只发一次
  h.registry.setPendingUpload(page.id, { id: "u1", multiple: false });
  h.registry.setPendingUpload(page.id, { id: "u1", multiple: false });
  expect(events).toBe(1);
  h.registry.setPendingUpload("pnope", { id: "u1", multiple: false });
  expect(events).toBe(1);
});

test("文件选择：带着当时的 PageView 到达 onFileChooser", async () => {
  const h = makeRegistry();
  const { page } = await open(h, null);
  const fake = h.ctx("w1").pages[0] as FakePage;
  const chooser = { multiple: true, setFiles: async () => {} };
  fake.emitFileChooser(chooser);

  expect(h.choosers).toHaveLength(1);
  expect(h.choosers[0]?.chooser).toBe(chooser);
  expect(h.choosers[0]?.page.id).toBe(page.id);
  expect(h.choosers[0]?.page.controller).toBe("user");
});

test("contextKeys / seedState：状态交给那个工作区的上下文，不存在的 key 静默", async () => {
  const h = makeRegistry();
  expect(h.registry.contextKeys()).toEqual([]);
  await open(h, "s1");
  expect(h.registry.contextKeys()).toEqual(["w1"]);
  const own = h.ctx("w1");
  const state = {
    cookies: [],
    origins: [{ origin: "https://x.test", localStorage: [] }],
  };
  await h.registry.seedState("w1", state);
  expect(own.seeds).toEqual([state]);
  // 上下文不在（没起过 / 崩过）就什么也不做，不抛
  await expect(
    h.registry.seedState("w2", { cookies: [], origins: [] }),
  ).resolves.toBeUndefined();
  h.registry.onEngineCrash();
  expect(h.registry.contextKeys()).toEqual([]);
  await expect(
    h.registry.seedState("w1", { cookies: [], origins: [] }),
  ).resolves.toBeUndefined();
});

test("reloadFile：只有 agent 控制的激活页真刷新", async () => {
  const h = makeRegistry();
  const own = await open(h, "s1");
  const mine = h.ctx("w1").pages[0];
  if (!mine) throw new Error("没有假页面");
  const reloads = () => mine.calls.filter((c) => c === "reload").length;
  await h.registry.reloadFile(own.page.id);
  expect(reloads()).toBe(1);

  // 用户控制的页不刷
  h.registry.control(own.page.id, "user");
  await h.registry.reloadFile(own.page.id);
  expect(reloads()).toBe(1);
  h.registry.control(own.page.id, "agent");

  // 不存在的页不抛
  await expect(h.registry.reloadFile("nope")).resolves.toBeUndefined();

  // 休眠的页不刷
  await h.registry.sleep(own.page.id);
  await h.registry.reloadFile(own.page.id);
  expect(reloads()).toBe(1);
});

// —— 对话框守卫、PageView.dialog、对话框变化的事件 ——

test("对话框挂着：use 抛 dialog_pending，allowDialog 放行，守卫不改变归属", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  h.busy.add("s2");
  const handle = h.registry.peek(page.id) as FakePage;
  handle.emitDialog({
    type: "confirm",
    message: "确定删除吗？",
    defaultValue: "",
  });

  const denied = await err(h.registry.use(page.id, "s9", "act"));
  expect(denied.code).toBe("dialog_pending");
  expect(denied.message).toBe(
    "页面正在等你回答一个 confirm 对话框：「确定删除吗？」。先用 browser_dialog 回答（accept 为 true 是确定，false 是取消），其它操作要等它处理完；不回答的话 120 秒后会自动取消。",
  );
  // 抛在认领之前：别人的归属与 usedBy 都没变
  expect(h.registry.get(page.id)?.inUseBy).toBe("s1");
  expect(h.registry.get(page.id)?.usedBy).toEqual(["s1"]);

  // 只读的 use 同样被拦
  expect((await err(h.registry.use(page.id, "s9", "observe"))).code).toBe(
    "dialog_pending",
  );
  // allowDialog 放行（对话框工具、控制台、接管三条路）
  await expect(
    h.registry.use(page.id, "s1", "act", { allowDialog: true }),
  ).resolves.toBeDefined();
  expect(h.registry.get(page.id)?.inUseBy).toBe("s1");
});

test("对话框提示里的页面文字截到 200 字符", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const handle = h.registry.peek(page.id) as FakePage;
  handle.emitDialog({
    type: "alert",
    message: "x".repeat(230),
    defaultValue: "",
  });
  const denied = await err(h.registry.use(page.id, "s1", "observe"));
  expect(denied.message).toContain(`${"x".repeat(200)}…(+30 chars)`);
});

test("PageView.dialog：活着时给挂着的对话框，休眠页是 null", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  expect(h.registry.get(page.id)?.dialog).toBeNull();
  const handle = h.registry.peek(page.id) as FakePage;
  handle.emitDialog({
    type: "prompt",
    message: "名字？",
    defaultValue: "x",
  });
  expect(h.registry.get(page.id)?.dialog).toEqual({
    type: "prompt",
    message: "名字？",
    defaultValue: "x",
  });
  await handle.answerDialog(true);
  expect(h.registry.get(page.id)?.dialog).toBeNull();
  handle.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
  await h.registry.sleep(page.id);
  expect(h.registry.get(page.id)?.dialog).toBeNull();
});

test("对话框出现与消失都发 updated 事件", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const seen: Array<{ type: string; dialog: unknown }> = [];
  h.registry.subscribe((e) => {
    if (e.type === "updated")
      seen.push({ type: e.type, dialog: e.page.dialog });
  });
  const handle = h.registry.peek(page.id) as FakePage;
  handle.emitDialog({ type: "alert", message: "hi", defaultValue: "" });
  await handle.answerDialog(true);
  expect(seen.map((s) => s.dialog)).toEqual([
    { type: "alert", message: "hi", defaultValue: "" },
    null,
  ]);
});

// —— 弹窗日志：popupSeq / popupsSince ——

test("popupSeq / popupsSince：按序返回游标之后的弹窗，带来源页面", async () => {
  const h = makeRegistry();
  const { page } = await open(h, "s1");
  const start = h.registry.popupSeq("w1");
  expect(start).toBe(0);

  const ctx = h.ctx("w1");
  const source = ctx.pages[0] as FakePage;
  const first = ctx.popup(source, "https://p1.test/");
  const second = ctx.popup(source, "https://p2.test/");
  expect(h.registry.popupSeq("w1")).toBe(2);

  const found = h.registry.popupsSince("w1", "s1", start);
  expect(found.map((f) => f.page.url)).toEqual([
    "https://p1.test/",
    "https://p2.test/",
  ]);
  expect(found.map((f) => f.openerId)).toEqual([page.id, page.id]);
  // 游标之后：已经报过的不再返回
  expect(h.registry.popupsSince("w1", "s1", 2)).toEqual([]);

  first.fireClose();
  second.fireClose();
});

test("popupsSince：游标之后的才返回；他人用过的、已关掉的都不返回", async () => {
  const h = makeRegistry();
  // 两个会话各开一页，各自页面里再弹一个：弹窗继承来源的归属。
  await open(h, "s1", "https://mine.test/");
  // 上下文要开过页面之后才拿得到（注册表在这里登记了 onPopup）。
  const ctx = h.ctx("w1");
  const mineSource = ctx.pages[0] as FakePage;
  await open(h, "s2", "https://theirs.test/");
  const theirsSource = ctx.pages[1] as FakePage;
  const idOf = (url: string) =>
    h.registry.list("w1").find((p) => p.url === url)?.id as string;

  const mine = ctx.popup(mineSource, "https://mine.test/child");
  const theirs = ctx.popup(theirsSource, "https://theirs.test/child");
  const mineId = idOf("https://mine.test/child");
  const theirsId = idOf("https://theirs.test/child");

  expect(h.registry.popupsSince("w1", "s1", 0).map((f) => f.page.id)).toEqual([
    mineId,
  ]);
  expect(h.registry.popupsSince("w1", "s2", 0).map((f) => f.page.id)).toEqual([
    theirsId,
  ]);
  // 会话按根会话算：子代理看到的也是根的
  h.parents.set("child", "s1");
  expect(
    h.registry.popupsSince("w1", "child", 0).map((f) => f.page.id),
  ).toEqual([mineId]);

  mine.fireClose();
  theirs.fireClose();
  expect(h.registry.popupsSince("w1", "s1", 0)).toEqual([]);
});

test("弹窗日志每个工作区只留最近 50 条", async () => {
  // 上限调大：弹窗到上限会被直接关掉，那就进不了日志。
  const h = makeRegistry({ limits: { perWorkspace: 200, global: 200 } });
  await open(h, "s1");
  const ctx = h.ctx("w1");
  const source = ctx.pages[0] as FakePage;
  for (let i = 0; i < 60; i++) ctx.popup(source, `https://p${i}.test/`);
  expect(h.registry.popupSeq("w1")).toBe(60);
  const found = h.registry.popupsSince("w1", "s1", 0);
  expect(found).toHaveLength(50);
  expect(found[0]?.page.url).toBe("https://p10.test/");
  // 别的工作区各自一份
  expect(h.registry.popupSeq("w2")).toBe(0);
});

test("popupsSince：休眠页面照常返回（记录还在）", async () => {
  const h = makeRegistry();
  await open(h, "s1");
  const ctx = h.ctx("w1");
  const source = ctx.pages[0] as FakePage;
  ctx.popup(source, "https://p1.test/");
  const id = h.registry.list("w1").find((p) => p.url === "https://p1.test/")
    ?.id as string;
  await h.registry.sleep(id);
  expect(h.registry.popupsSince("w1", "s1", 0).map((f) => f.page.id)).toEqual([
    id,
  ]);
});
