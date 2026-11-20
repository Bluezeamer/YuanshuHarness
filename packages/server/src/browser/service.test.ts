// 浏览器服务的装配：代理令牌随上下文生灭、站点批准按工作区、页面没了清洗层跟着忘、浏览器崩了页面转休眠。
// 全部用替身引擎，代理是真的（只监听本机回环、不出网：DNS 注入成内网地址，请求会被代理拒绝）。

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { BrowserLoginStore } from "../store/browser-logins.js";
import { type Db, openDatabase } from "../store/db.js";
import type { WatchListener } from "../watch/hub.js";
import type { Cleaner } from "./agent/clean/types.js";
import type { ContextOptions } from "./engine/types.js";
import { FakeCtx } from "./pages/testkit.js";
import { PageError } from "./pages/types.js";
import { BrowserService } from "./service.js";

const made: { dir: string; db: Db; service: BrowserService }[] = [];

class FakeEngine {
  readonly opened: ContextOptions[] = [];
  /** 含失败的那次：测试要拿它的令牌去验证已被注销。 */
  readonly attempts: ContextOptions[] = [];
  readonly ctxs: FakeCtx[] = [];
  closed = false;
  contextError: Error | null = null;
  private readonly crashes = new Set<() => void>();

  async context(opts: ContextOptions): Promise<FakeCtx> {
    this.attempts.push(opts);
    if (this.contextError) throw this.contextError;
    this.opened.push(opts);
    const ctx = new FakeCtx();
    this.ctxs.push(ctx);
    return ctx;
  }
  onCrash(cb: () => void): () => void {
    this.crashes.add(cb);
    return () => this.crashes.delete(cb);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  crash(): void {
    for (const cb of this.crashes) cb();
  }
}

function setup(dataDir?: string) {
  const dir =
    dataDir ?? mkdtempSync(path.join(tmpdir(), "yuanshu-browser-service-"));
  const db = openDatabase(dir);
  const masterKey = randomBytes(32);
  const engine = new FakeEngine();
  const forgotten: string[] = [];
  const scoped: string[] = [];
  // 文件变更监听的替身：只记调用，不真去听文件。
  const watched = new Map<string, { envId: string; paths: string[] }>();
  const watcherChanged = new Set<WatchListener>();
  const watch = {
    set: (key: string, envId: string, paths: readonly string[]) =>
      void watched.set(key, { envId, paths: [...paths] }),
    release: (key: string) => void watched.delete(key),
    onChanged: (cb: WatchListener) => {
      watcherChanged.add(cb);
      return () => void watcherChanged.delete(cb);
    },
  };
  // 端口探测用的替身环境：用例按需放进 openTcp。
  const envs = new Map<string, unknown>();
  const cleaner: Cleaner = {
    clean: async () => ({ text: "", stage: "direct" }),
    rebase: () => {},
    forgetPage: (id) => void forgotten.push(id),
  };
  const service = new BrowserService({
    dataDir: dir,
    db,
    masterKey,
    engine: engine as never,
    // 公网名一律解析成内网地址：请求只会得到代理的拒绝，不会真的出网。
    proxy: {
      env: (envId) => (envs.get(envId) as never) ?? null,
      lookup: async () => [{ address: "10.0.0.1", family: 4 }],
    },
    cleaner,
    watch,
    scope: (key) => {
      scoped.push(key);
      return {
        loopbackEnvId: null,
        allowService: () => false,
        allowFile: () => false,
      };
    },
    rootOf: (s) => s,
    isBusy: () => false,
  });
  made.push({ dir, db, service });
  return {
    service,
    engine,
    forgotten,
    scoped,
    db,
    masterKey,
    dir,
    envs,
    watched,
  };
}

afterEach(async () => {
  for (const m of made.splice(0)) {
    await m.service.close().catch(() => {});
    m.db.close();
    rmSync(m.dir, { recursive: true, force: true });
  }
});
/** 等一个异步变化（挂起清单的清理是异步的）。 */
async function until(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 2000) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 经代理发一个请求，返回状态码：令牌有效时拿到 403（目标被拒），无效时拿到 407（认证失败）。 */
function viaProxy(server: string, token: string): Promise<number> {
  const port = Number(new URL(server).port);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "http://blocked.example/",
        headers: {
          Host: "blocked.example",
          "Proxy-Authorization": `Basic ${Buffer.from(`${token}:x`).toString("base64")}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const open = (s: ReturnType<typeof setup>, key = "w1") =>
  s.service.registry.open({
    workspaceKey: key,
    actor: "s1",
    url: "https://x.test/",
  });

test("上下文的代理指向本进程代理，令牌有效；工作区删除后令牌作废", async () => {
  const s = setup();
  await open(s);
  const proxy = s.engine.opened[0]?.proxy;
  expect(proxy?.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(proxy?.username.length).toBeGreaterThan(20);
  expect(s.scoped).toEqual(["w1"]);
  expect(await viaProxy(proxy?.server ?? "", proxy?.username ?? "")).toBe(403);
  expect(await viaProxy(proxy?.server ?? "", "wrong")).toBe(407);

  await s.service.forgetWorkspace("w1");
  expect(await viaProxy(proxy?.server ?? "", proxy?.username ?? "")).toBe(407);
});

test("不同工作区各自一个上下文与令牌", async () => {
  const s = setup();
  await open(s, "w1");
  await open(s, "w2");
  const [a, b] = s.engine.opened.map((o) => o.proxy);
  expect(a?.username).not.toBe(b?.username);
  expect(s.scoped).toEqual(["w1", "w2"]);
});

test("上下文创建失败：令牌不留下，错误是 context_failed", async () => {
  const s = setup();
  s.engine.contextError = new Error("boom");
  const err = await open(s).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PageError);
  expect((err as PageError).code).toBe("context_failed");
  const failed = s.engine.attempts[0]?.proxy;
  expect(failed).toBeDefined();
  expect(await viaProxy(failed?.server ?? "", failed?.username ?? "")).toBe(
    407,
  );
});

test("浏览器崩溃后重建上下文：旧令牌作废、新令牌有效", async () => {
  const s = setup();
  await open(s);
  const first = s.engine.opened[0]?.proxy;
  s.engine.crash();
  expect(s.service.registry.list("w1")[0]?.state).toBe("sleeping");

  await open(s);
  const second = s.engine.opened[1]?.proxy;
  expect(second?.username).not.toBe(first?.username);
  expect(await viaProxy(second?.server ?? "", second?.username ?? "")).toBe(
    403,
  );
  expect(await viaProxy(first?.server ?? "", first?.username ?? "")).toBe(407);
});

test("站点批准按工作区记，工作区删除后清掉", async () => {
  const s = setup();
  const origin = "https://example.com";
  expect(s.service.access.approved("w1", origin)).toBe(false);
  s.service.approve("w1", origin);
  expect(s.service.access.approved("w1", origin)).toBe(true);
  expect(s.service.access.approved("w2", origin)).toBe(false);
  expect(s.service.access.approved("w1", "https://example.com:8443")).toBe(
    false,
  );

  await s.service.forgetWorkspace("w1");
  expect(s.service.access.approved("w1", origin)).toBe(false);
});

test("见过的端口按工作区隔离，forgetWorkspace 之后 known 为 false", async () => {
  const s = setup();
  s.service.ports.note("w1", "local", 3000);
  expect(s.service.access.known("w1", "local", 3000)).toBe(true);
  expect(s.service.access.known("w2", "local", 3000)).toBe(false);
  expect(s.service.access.known("w1", "e2", 3000)).toBe(false);

  await s.service.forgetWorkspace("w1");
  expect(s.service.access.known("w1", "local", 3000)).toBe(false);
});

test("listeningPorts：只留此刻真在监听的，保持记下的先后", async () => {
  const s = setup();
  // 替身环境：只有 3000 与 gpu1 上的 8080 连得上
  s.envs.set("local", {
    openTcp: async (port: number) => {
      if (port !== 3000) throw new Error("ECONNREFUSED");
      return { destroy: () => {} } as never;
    },
  });
  s.envs.set("gpu1", {
    openTcp: async () => ({ destroy: () => {} }) as never,
  });
  s.service.ports.note("w1", "local", 8080);
  s.service.ports.note("w1", "local", 3000);
  s.service.ports.note("w1", "gpu1", 8080);
  expect(await s.service.listeningPorts("w1")).toEqual([
    { envId: "local", port: 3000 },
    { envId: "gpu1", port: 8080 },
  ]);
  // 别的工作区看不到
  expect(await s.service.listeningPorts("w2")).toEqual([]);
});

test("页面被关：清洗层忘掉它的上一份快照", async () => {
  const s = setup();
  const { page } = await open(s);
  await s.service.registry.close(page.id, "user");
  expect(s.forgotten).toEqual([page.id]);
});

test("根会话归档：只有它用过的页面被关", async () => {
  const s = setup();
  const { page } = await open(s);
  await s.service.releaseSession("s1");
  expect(s.service.registry.get(page.id)).toBeNull();
});

test("close：关掉引擎与代理", async () => {
  const s = setup();
  await open(s);
  const server = s.engine.opened[0]?.proxy.server ?? "";
  await s.service.close();
  expect(s.engine.closed).toBe(true);
  await expect(viaProxy(server, "any")).rejects.toThrow();
});

// 用户页上的下载：挂进待处理清单；页面没了清单跟着清；重启时清掉上次的暂存残留。

test("用户页的下载进入挂起清单，页面状态里能看到", async () => {
  const s = setup();
  const { page } = await s.service.registry.open({
    workspaceKey: "w1",
    actor: null,
    url: "https://x.test/",
  });
  const fake = s.engine.ctxs[0]?.pages[0];
  fake?.emitDownload({
    filename: "报告.zip",
    url: "https://x.test/a.zip",
    saveTo: async () => 1,
    cancel: async () => {},
  });
  expect(s.service.registry.get(page.id)?.pendingDownloads).toEqual([
    { id: expect.any(String), filename: "报告.zip" },
  ]);

  // 页面没了，清单跟着清（不用等 10 分钟超时）
  await s.service.registry.close(page.id, "user");
  expect(s.service.pending.list(page.id)).toEqual([]);
  await until(() => s.forgotten.length === 1, "页面移除");
  expect(s.forgotten).toEqual([page.id]);
});
test("每页最多挂 3 个，多的立刻取消", async () => {
  const s = setup();
  await s.service.registry.open({
    workspaceKey: "w1",
    actor: null,
    url: "https://x.test/",
  });
  const fake = s.engine.ctxs[0]?.pages[0];
  const cancelled: string[] = [];
  const make = (name: string) => ({
    filename: name,
    url: `https://x.test/${name}`,
    saveTo: async () => 1,
    cancel: async (reason: string) => void cancelled.push(reason),
  });
  for (const n of ["1", "2", "3", "4"]) fake?.emitDownload(make(`${n}.zip`));
  await until(() => cancelled.length === 1, "第 4 个被取消");
  expect(cancelled).toEqual(["这一页待处理的下载已满，先处理掉前面的"]);
});

test("构造时清掉上次留下的暂存残留", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yuanshu-browser-sweep-"));
  const leftover = path.join(dir, "browser-downloads");
  await mkdir(path.join(leftover, "x"), { recursive: true });
  await writeFile(path.join(leftover, "x", "file"), "x");
  setup(dir);
  await until(() => !existsSync(leftover), "残留被清掉");
});

const cookie = (domain: string) => ({
  name: "sid",
  value: "abc123",
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
});

test("库里有启用的站点：新建上下文注入它的 cookie", async () => {
  const s = setup();
  new BrowserLoginStore(s.db, s.masterKey).put("github.com", {
    cookies: [cookie(".github.com")],
    origins: [],
  });
  await open(s, "w1");
  expect(s.engine.opened[0]?.storageState).toEqual({
    cookies: [cookie(".github.com")],
    origins: [],
  });
});

test("库空或全部 disabled：不传 storageState 字段", async () => {
  const s = setup();
  await open(s, "w1");
  expect(s.engine.opened[0]).not.toHaveProperty("storageState");

  const store = new BrowserLoginStore(s.db, s.masterKey);
  store.put("github.com", { cookies: [cookie(".github.com")], origins: [] });
  store.setEnabled("github.com", false);
  await open(s, "w2");
  expect(s.engine.opened[1]).not.toHaveProperty("storageState");
});

test("两个工作区各自新建上下文都拿到同一份注入", async () => {
  const s = setup();
  new BrowserLoginStore(s.db, s.masterKey).put("github.com", {
    cookies: [cookie(".github.com")],
    origins: [],
  });
  await open(s, "w1");
  await open(s, "w2");
  expect(s.engine.opened).toHaveLength(2);
  for (const opts of s.engine.opened)
    expect(opts.storageState?.cookies.map((c) => c.domain)).toEqual([
      ".github.com",
    ]);
});

test("下载：经 registry 派发到 service 的下载窗口；窗口不在时取消", async () => {
  const s = setup();
  const { page } = await open(s);
  const fake = s.engine.ctxs[0]?.pages[0];
  expect(fake).toBeDefined();

  const make = (name: string) => {
    const cancelled: string[] = [];
    return {
      d: {
        filename: name,
        url: `https://x.test/${name}`,
        saveTo: async () => 1,
        cancel: async (reason: string) => void cancelled.push(reason),
      },
      cancelled,
    };
  };

  // 窗口外：没有 agent 动作在等 → 取消
  const outside = make("outside.zip");
  fake?.emitDownload(outside.d);
  await new Promise((r) => setTimeout(r, 0));
  expect(outside.cancelled).toEqual(["没有对应的 agent 动作"]);

  // 窗口内：收下
  const inside = make("inside.zip");
  const got = await s.service.downloads.collect(
    "s1",
    page.id,
    async () => {
      fake?.emitDownload(inside.d);
    },
    0,
  );
  expect(got.downloads).toEqual([inside.d]);
});

// 用户页上的文件选择：挂进待处理清单；agent 页上的不管；页面没了清单跟着清。

test("用户页的文件选择挂起，页面状态里能看到", async () => {
  const s = setup();
  const { page } = await s.service.registry.open({
    workspaceKey: "w1",
    actor: null,
    url: "https://x.test/",
  });
  const fake = s.engine.ctxs[0]?.pages[0];
  const chooser = { multiple: true, setFiles: async () => {} };
  fake?.emitFileChooser(chooser);
  expect(s.service.registry.get(page.id)?.pendingUpload).toEqual({
    id: expect.any(String),
    multiple: true,
  });

  // 页面没了，挂着的选择器跟着清（不用等 10 分钟超时）：再取消就找不到了。
  const id = s.service.registry.get(page.id)?.pendingUpload?.id as string;
  await s.service.registry.close(page.id, "user");
  await until(() => s.forgotten.length === 1, "页面移除");
  expect(s.forgotten).toEqual([page.id]);
  expect(s.service.pendingUploads.cancel(page.id, id)).toBe(false);
});

test("agent 页上的文件选择不挂起（agent 自己用 browser_upload）", async () => {
  const s = setup();
  const { page } = await open(s);
  const fake = s.engine.ctxs[0]?.pages[0];
  fake?.emitFileChooser({ multiple: false, setFiles: async () => {} });
  expect(s.service.registry.get(page.id)?.pendingUpload).toBeNull();
});

// —— 登录态补进已开着的上下文；文件页跟着文件变化刷新 ——

test("B 工作区保存后，已开着的 A 的上下文被补进登录态", async () => {
  const s = setup();
  await open(s, "w1");
  await open(s, "w2");
  // w1 里还没有 github 的任何状态；w2 里刚登录（保存的是它的状态）
  expect(s.engine.ctxs[0]?.seeds).toEqual([]);
  const logged = { cookies: [cookie(".github.com")], origins: [] };
  const b = s.engine.ctxs[1];
  if (!b) throw new Error("没有第二个上下文");
  b.storageState = async () => logged;

  await s.service.login.save("w2", "https://github.com/");
  expect(s.engine.ctxs[0]?.seeds).toEqual([
    { cookies: [cookie(".github.com")], origins: [] },
  ]);
  // 保存的那个上下文里本来就有，不重复补
  expect(s.engine.ctxs[1]?.seeds).toEqual([]);
});

test("agent 控制的文件页被监听所在目录；页面移除后退订", async () => {
  const s = setup();
  const { page } = await s.service.registry.open({
    workspaceKey: "w1",
    actor: "s1",
    url: "http://server.files.localhost/srv/app/index.html",
  });
  expect(s.watched.get(`browser:${page.id}`)).toEqual({
    envId: "local",
    paths: ["/srv/app"],
  });

  await s.service.registry.close(page.id, "user");
  expect(s.watched.has(`browser:${page.id}`)).toBe(false);
});
