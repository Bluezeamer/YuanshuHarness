import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DirEntry, ExecEnv, FileStat } from "../env/types.js";
import { WatchHub } from "./hub.js";

// 假的 fs.watch：记录每次调用，事件/错误由测试手动触发。
type FakeFSWatcher = {
  path: string;
  closed: boolean;
  emit(event: string, filename: string | null): void;
  fail(err: Error): void;
  close(): void;
};

const fake = vi.hoisted(() => ({
  watchers: [] as FakeFSWatcher[],
  /** 这些路径上 fs.watch 同步抛错，模拟路径消失 / 无权限 */
  throwOn: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: (
      path: string,
      listener: (event: string, filename: string | null) => void,
    ) => {
      if (fake.throwOn.has(path)) throw new Error(`EACCES ${path}`);
      const onError: ((err: Error) => void)[] = [];
      const w: FakeFSWatcher = {
        path,
        closed: false,
        emit(event, filename) {
          if (!w.closed) listener(event, filename);
        },
        fail(err) {
          for (const cb of onError) cb(err);
        },
        close() {
          w.closed = true;
        },
        // 只关心 error 监听；hub 只注册这一种
        on(event: string, cb: (err: Error) => void) {
          if (event === "error") onError.push(cb);
          return w;
        },
      } as FakeFSWatcher;
      fake.watchers.push(w);
      return w;
    },
  };
});

const statOf = (kind: "dir" | "file"): FileStat => ({
  isDirectory: kind === "dir",
  isFile: kind === "file",
  isSymlink: false,
  size: 0,
  mtimeMs: 0,
  mode: 0o644,
});

/** 本机环境的假实现：只负责按路径表回答 stat。 */
function localEnv(kinds: Record<string, "dir" | "file">): ExecEnv {
  return {
    id: "local",
    kind: "local",
    os: "posix",
    stat: async (p: string) => {
      const kind = kinds[p];
      return kind ? statOf(kind) : null;
    },
    readdir: async () => [],
  } as unknown as ExecEnv;
}

/** 远程环境的假实现：目录 /d、文件 /f，内容由 state 控制。 */
function remoteEnv() {
  const state = {
    names: ["a.txt"],
    fileMtime: 1,
    reads: 0,
    connected: true,
  };
  const env = {
    id: "srv",
    kind: "ssh",
    os: "posix",
    stat: async (p: string): Promise<FileStat | null> => {
      if (!state.connected) throw new Error("disconnected");
      if (p === "/d") return statOf("dir");
      if (p === "/f") {
        return {
          ...statOf("file"),
          size: state.fileMtime,
          mtimeMs: state.fileMtime,
        };
      }
      if (p.startsWith("/d/")) {
        const name = p.slice("/d/".length);
        if (!state.names.includes(name)) return null;
        return { ...statOf("file"), size: name.length };
      }
      return null;
    },
    readdir: async (p: string): Promise<DirEntry[]> => {
      state.reads++;
      if (!state.connected) throw new Error("disconnected");
      if (p !== "/d") throw new Error(`ENOENT ${p}`);
      return state.names.map((name) => ({
        name,
        isDirectory: false,
        isSymlink: false,
      }));
    },
  } as unknown as ExecEnv;
  return { env, state };
}

const watcherAt = (i: number): FakeFSWatcher => {
  const w = fake.watchers[i];
  if (!w) throw new Error(`没有第 ${i} 个 watcher`);
  return w;
};

describe("WatchHub", () => {
  beforeEach(() => {
    fake.watchers.length = 0;
    fake.throwOn.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 异步建立 watch 需要刷几轮微任务
  const settle = async () => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
  };

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  test("同一路径两个 key 只建一条底层 watch，事件推给两个 key", async () => {
    const hub = new WatchHub({ env: () => localEnv({ "/d": "dir" }) });
    const seen: { key: string; env: string; paths: string[] }[] = [];
    hub.onChanged((key, env, paths) => seen.push({ key, env, paths }));

    hub.set("s1", "local", ["/d"]);
    hub.set("s2", "local", ["/d"]);
    await settle();

    expect(fake.watchers).toHaveLength(1);
    expect(hub.pathsOf("s1")).toEqual(["/d"]);
    expect(hub.pathsOf("s2")).toEqual(["/d"]);

    watcherAt(0).emit("change", "a.txt");
    await advance(300);

    expect(seen.map((s) => s.key).sort()).toEqual(["s1", "s2"]);
    expect(seen[0]?.paths).toEqual([join("/d", "a.txt")]);
    expect(seen[0]?.env).toBe("local");

    hub.dispose();
  });

  test("文件订阅报路径本身，目录订阅报 path.join(目录, filename)", async () => {
    const hub = new WatchHub({
      env: () => localEnv({ "/d": "dir", "/f": "file" }),
    });
    const seen: string[][] = [];
    hub.onChanged((_key, _env, paths) => seen.push(paths));

    hub.set("k", "local", ["/d", "/f"]);
    await settle();
    expect(fake.watchers).toHaveLength(2);

    const dirWatcher = fake.watchers.find((w) => w.path === "/d");
    const fileWatcher = fake.watchers.find((w) => w.path === "/f");
    dirWatcher?.emit("rename", "x.txt");
    fileWatcher?.emit("change", "f");
    await advance(300);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["/d/x.txt", "/f"].sort());

    hub.dispose();
  });

  test("set 替换语义：旧路径退订并关掉底层 watch", async () => {
    const hub = new WatchHub({
      env: () => localEnv({ "/a": "dir", "/b": "dir" }),
    });
    const seen: string[][] = [];
    hub.onChanged((_key, _env, paths) => seen.push(paths));

    hub.set("k", "local", ["/a", "/b"]);
    await settle();
    expect(fake.watchers).toHaveLength(2);

    hub.set("k", "local", ["/a"]);
    await settle();

    expect(hub.pathsOf("k")).toEqual(["/a"]);
    const dropped = fake.watchers.find((w) => w.path === "/b");
    expect(dropped?.closed).toBe(true);

    dropped?.emit("change", "y");
    await advance(300);
    expect(seen).toHaveLength(0); // 旧路径不再回调

    fake.watchers.find((w) => w.path === "/a")?.emit("change", "z");
    await advance(300);
    expect(seen).toEqual([["/a/z"]]);

    hub.dispose();
  });

  test("去抖合并：窗口内多个路径只回调一次且去重", async () => {
    const hub = new WatchHub({
      env: () => localEnv({ "/d": "dir" }),
      debounceMs: 300,
    });
    const seen: string[][] = [];
    hub.onChanged((_key, _env, paths) => seen.push(paths));

    hub.set("k", "local", ["/d"]);
    await settle();

    const w = watcherAt(0);
    w.emit("rename", "a.txt");
    w.emit("rename", "b.txt");
    w.emit("rename", "c.txt");
    w.emit("change", "a.txt"); // 重复路径
    await advance(299);
    expect(seen).toHaveLength(0); // 窗口还没到

    await advance(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["/d/a.txt", "/d/b.txt", "/d/c.txt"]);

    hub.dispose();
  });

  test("release 后不再回调，最后一个订阅者关掉底层 watch", async () => {
    const hub = new WatchHub({ env: () => localEnv({ "/d": "dir" }) });
    const seen: string[] = [];
    hub.onChanged((key) => seen.push(key));

    hub.set("s1", "local", ["/d"]);
    hub.set("s2", "local", ["/d"]);
    await settle();
    expect(fake.watchers).toHaveLength(1);

    hub.release("s1");
    watcherAt(0).emit("change", "a.txt");
    await advance(300);
    expect(seen).toEqual(["s2"]); // s1 已退订，s2 仍然收到
    expect(watcherAt(0).closed).toBe(false); // 还有订阅者

    hub.release("s2");
    expect(hub.pathsOf("s2")).toEqual([]);
    expect(watcherAt(0).closed).toBe(true);

    seen.length = 0;
    watcherAt(0).emit("change", "b.txt");
    await advance(300);
    expect(seen).toEqual([]);

    hub.dispose();
  });

  test("路径不存在时静默跳过，下次 set 再试", async () => {
    const kinds: Record<string, "dir" | "file"> = {};
    const hub = new WatchHub({ env: () => localEnv(kinds) });
    hub.set("k", "local", ["/later"]);
    await settle();
    expect(fake.watchers).toHaveLength(0);

    kinds["/later"] = "dir";
    hub.set("k", "local", ["/later"]);
    await settle();
    expect(fake.watchers).toHaveLength(1);

    hub.dispose();
  });

  test("fs.watch 抛错或报 error 都不影响其它订阅者", async () => {
    const env = localEnv({ "/bad": "dir", "/good": "dir" });
    fake.throwOn.add("/bad");
    const hub = new WatchHub({ env: () => env });
    const seen: string[][] = [];
    hub.onChanged((_key, _env, paths) => seen.push(paths));

    expect(() => hub.set("k", "local", ["/bad", "/good"])).not.toThrow();
    await settle();
    expect(fake.watchers.map((w) => w.path)).toEqual(["/good"]);

    // 运行中抛错：只退订这一条
    const good = watcherAt(0);
    good.fail(new Error("EPERM"));
    expect(good.closed).toBe(true);

    good.emit("change", "a.txt");
    await advance(300);
    expect(seen).toEqual([]);

    // 重新 set 会重建
    fake.throwOn.clear();
    hub.set("k", "local", ["/good"]);
    await settle();
    expect(fake.watchers).toHaveLength(2);

    hub.dispose();
  });

  test("远程轮询：首轮建基线，内容变化后报路径", async () => {
    const { env, state } = remoteEnv();
    const hub = new WatchHub({ env: () => env, pollMs: 50 });
    const seen: string[][] = [];
    hub.onChanged((_key, _env, paths) => seen.push(paths));

    hub.set("k", "srv", ["/d", "/f"]);
    await settle(); // stat 判定类型

    await advance(50); // 首轮只建基线
    expect(state.reads).toBe(1);
    expect(seen).toEqual([]);

    state.names = ["a.txt", "b.txt"];
    state.fileMtime = 2;
    await advance(50); // 检出变化，但还在去抖窗口内
    expect(seen).toEqual([]);
    await advance(300); // 窗口到
    expect(seen).toEqual([["/d", "/f"]]);

    // 无变化不再重复报
    seen.length = 0;
    await advance(100);
    await advance(300);
    expect(seen).toEqual([]);

    hub.dispose();
  });

  test("远程轮询：无订阅时定时器停掉", async () => {
    const { env, state } = remoteEnv();
    const hub = new WatchHub({ env: () => env, pollMs: 50 });
    hub.set("k", "srv", ["/d"]);
    await settle();
    await advance(50);
    expect(state.reads).toBe(1);

    hub.release("k");
    await advance(200);
    expect(state.reads).toBe(1); // 定时器已停

    hub.dispose();
  });

  test("dispose 之后不再有任何回调", async () => {
    const hub = new WatchHub({ env: () => localEnv({ "/d": "dir" }) });
    const seen: string[] = [];
    hub.onChanged((key) => seen.push(key));

    hub.set("k", "local", ["/d"]);
    await settle();
    const w = watcherAt(0);
    hub.dispose();
    expect(w.closed).toBe(true);

    w.emit("change", "a.txt");
    await advance(1000);
    expect(seen).toEqual([]);
  });
});
