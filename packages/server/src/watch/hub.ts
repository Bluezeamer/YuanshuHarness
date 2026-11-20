// 文件变更监听中枢：给「文件浏览器 / 文件预览」做有限感知刷新。
// 只监听被订阅的路径：本机走 fs.watch，远程环境（ssh 等）走轮询；
// 变化按 key（会话 id）去抖合并成一批路径推给监听者。

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { ExecEnv } from "../env/types.js";

/** 通知出口：某个订阅者 key（会话 id）的某些绝对路径发生了变化 */
export type WatchListener = (key: string, env: string, paths: string[]) => void;

export interface WatchDeps {
  /** 环境 id → ExecEnv；不存在或未连接返回 null */
  env(envId: string): ExecEnv | null;
  /** 去抖窗口，默认 300ms */
  debounceMs?: number;
  /** 远程环境轮询间隔，默认 2000ms */
  pollMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_POLL_MS = 2000;

/** 一条真正建立的底层监听；同一路径被多个订阅者共享（引用计数）。 */
interface LocalWatch {
  kind: "local";
  envId: string;
  path: string;
  /** 被监听的是目录：事件里的 filename 相对它；是文件时一律报路径本身。 */
  dir: boolean;
  keys: Set<string>;
  watcher: FSWatcher;
}

interface PollWatch {
  kind: "poll";
  envId: string;
  path: string;
  dir: boolean;
  keys: Set<string>;
  /** 上一轮的签名；null 表示还没取到基线（首轮只建基线，不报变化）。 */
  sig: string | null;
}

type Watch = LocalWatch | PollWatch;

/** 某个 key 待推送的一批路径。 */
interface Batch {
  envId: string;
  paths: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface Sub {
  envId: string;
  paths: Set<string>;
}

const resourceKey = (envId: string, path: string) => `${envId}\u0000${path}`;

export class WatchHub {
  private readonly debounceMs: number;
  private readonly pollMs: number;
  /** key（会话 id）→ 当前订阅集合 */
  private readonly subs = new Map<string, Sub>();
  /** envId + 路径 → 底层监听（按引用计数共享） */
  private readonly watches = new Map<string, Watch>();
  /** 正在建立中的底层监听，避免同一路径并发 stat */
  private readonly pending = new Map<string, Promise<void>>();
  private readonly debounced = new Map<string, Batch>();
  private readonly pollTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  /** 正在跑的轮询环境，避免上一轮没结束就叠加上来 */
  private readonly polling = new Set<string>();
  private readonly listeners = new Set<WatchListener>();
  private disposed = false;

  constructor(private readonly deps: WatchDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  }

  /** 用新的订阅集合整体替换某个 key 的订阅（幂等）；空数组 = 退订该 key 的全部路径。 */
  set(key: string, envId: string, paths: readonly string[]): void {
    if (this.disposed) return;
    const next = new Set(paths);
    const prev = this.subs.get(key);
    if (prev) {
      for (const p of prev.paths) {
        // 换环境视同整批退订再订阅
        if (prev.envId !== envId || !next.has(p))
          this.detach(key, prev.envId, p);
      }
    }
    this.subs.set(key, { envId, paths: next });
    for (const p of next) void this.attach(key, envId, p);
  }

  /** 会话关闭 / 连接释放：退订该 key 的全部路径。 */
  release(key: string): void {
    const sub = this.subs.get(key);
    this.subs.delete(key);
    const batch = this.debounced.get(key);
    if (batch) {
      clearTimeout(batch.timer);
      this.debounced.delete(key);
    }
    if (sub) for (const p of sub.paths) this.detach(key, sub.envId, p);
  }

  /** 当前该 key 的订阅路径（排序后），供测试与调试。 */
  pathsOf(key: string): string[] {
    const sub = this.subs.get(key);
    if (!sub) return [];
    return [...sub.paths].sort();
  }

  /** 订阅变化通知；返回取消函数。可以有多个监听者。 */
  onChanged(listener: WatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 关掉所有 watcher / 定时器。 */
  dispose(): void {
    this.disposed = true;
    for (const batch of this.debounced.values()) clearTimeout(batch.timer);
    this.debounced.clear();
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    for (const w of this.watches.values()) {
      if (w.kind === "local") this.closeWatcher(w.watcher);
    }
    this.polling.clear();
    this.pending.clear();
    this.watches.clear();
    this.subs.clear();
    this.listeners.clear();
  }

  private desired(key: string, envId: string, path: string): boolean {
    const sub = this.subs.get(key);
    return sub !== undefined && sub.envId === envId && sub.paths.has(path);
  }

  /** 把某个 key 挂到某条路径的底层监听上（已有就复用）。 */
  private async attach(
    key: string,
    envId: string,
    path: string,
  ): Promise<void> {
    try {
      const rkey = resourceKey(envId, path);
      const existing = this.watches.get(rkey);
      if (existing) {
        existing.keys.add(key);
        return;
      }
      const inflight = this.pending.get(rkey);
      if (inflight) {
        // 同一路径正在建立：等它建完再挂，避免重复 stat
        await inflight;
        const w = this.watches.get(rkey);
        if (w && !this.disposed && this.desired(key, envId, path)) {
          w.keys.add(key);
        }
        return;
      }
      const task = this.create(key, envId, path);
      this.pending.set(rkey, task);
      try {
        await task;
      } finally {
        this.pending.delete(rkey);
      }
    } catch {
      // 单条路径的任何失败都不该影响其它订阅者，也不冒泡给调用方
    }
  }

  private async create(
    key: string,
    envId: string,
    path: string,
  ): Promise<void> {
    const env = this.deps.env(envId);
    if (!env) return; // 环境不存在 / 未连接：跳过，下次 set 时再试
    const st = await env.stat(path).catch(() => null);
    // 路径不存在（或无权访问）时静默跳过，不报错也不建 watch：
    // 半截路径的父目录 watch 会带来大量无关事件，收益不抵成本；等前端下次 set 再试。
    if (!st) return;
    if (this.disposed || !this.desired(key, envId, path)) return;
    const rkey = resourceKey(envId, path);
    const existing = this.watches.get(rkey);
    if (existing) {
      existing.keys.add(key);
      return;
    }
    // 目录监听目录本身（非递归，目录项增删改都会报）；文件监听文件本身
    const w =
      env.kind === "local"
        ? this.startLocal(envId, path, st.isDirectory)
        : this.startPollWatch(envId, path, st.isDirectory);
    if (!w) return; // 建不上（刚消失 / 无权限）：静默跳过
    w.keys.add(key);
    this.watches.set(rkey, w);
    if (w.kind === "poll") this.startPoll(envId);
  }

  private detach(key: string, envId: string, path: string): void {
    const w = this.watches.get(resourceKey(envId, path));
    if (!w) return;
    w.keys.delete(key);
    if (w.keys.size > 0) return; // 还有别的订阅者，底层监听留着
    this.drop(w);
  }

  private drop(w: Watch): void {
    this.watches.delete(resourceKey(w.envId, w.path));
    if (w.kind === "local") this.closeWatcher(w.watcher);
    else this.stopPollIfIdle(w.envId);
  }

  private closeWatcher(watcher: FSWatcher): void {
    try {
      watcher.close();
    } catch {
      // 已经失效（路径被删）时 close 可能抛错，忽略
    }
  }

  private startLocal(
    envId: string,
    path: string,
    dir: boolean,
  ): LocalWatch | null {
    let watcher: FSWatcher;
    try {
      watcher = watch(path, (_event, filename) => {
        const w = this.watches.get(resourceKey(envId, path));
        if (!w || this.disposed) return;
        // 目录事件带相对 filename；文件自身的事件一律报路径本身
        const changed =
          dir && filename !== null ? [join(path, String(filename))] : [path];
        for (const key of w.keys) this.notify(key, envId, changed);
      });
    } catch {
      // fs.watch 同步抛错（路径消失、权限不足、inotify 用尽）：放弃该路径
      return null;
    }
    const w: LocalWatch = {
      kind: "local",
      envId,
      path,
      dir,
      keys: new Set(),
      watcher,
    };
    // 运行中抛错（inode 被删、watch 失效）同样只退订这一条，不让异常冒泡
    watcher.on("error", () => this.drop(w));
    return w;
  }

  private startPollWatch(envId: string, path: string, dir: boolean): PollWatch {
    return { kind: "poll", envId, path, dir, keys: new Set(), sig: null };
  }

  private startPoll(envId: string): void {
    if (this.pollTimers.has(envId)) return;
    const timer = setInterval(() => void this.tick(envId), this.pollMs);
    // 定时器不该单独吊住进程；dispose 会显式清掉
    if (typeof timer.unref === "function") timer.unref();
    this.pollTimers.set(envId, timer);
  }

  private stopPollIfIdle(envId: string): void {
    for (const w of this.watches.values()) {
      if (w.kind === "poll" && w.envId === envId) return;
    }
    const timer = this.pollTimers.get(envId);
    if (!timer) return;
    clearInterval(timer);
    this.pollTimers.delete(envId);
  }

  private async tick(envId: string): Promise<void> {
    if (this.disposed || this.polling.has(envId)) return;
    const targets: PollWatch[] = [];
    for (const w of this.watches.values()) {
      if (w.kind === "poll" && w.envId === envId) targets.push(w);
    }
    if (targets.length === 0) {
      this.stopPollIfIdle(envId);
      return;
    }
    const env = this.deps.env(envId);
    if (!env) return; // 未连接：这轮跳过，保留旧签名等重连
    this.polling.add(envId);
    try {
      // 单条路径读失败只丢这一条，不影响其它路径与其它订阅者
      await Promise.all(
        targets.map((w) => this.pollOne(env, w).catch(() => undefined)),
      );
    } finally {
      this.polling.delete(envId);
    }
  }

  private async pollOne(env: ExecEnv, w: PollWatch): Promise<void> {
    const sig = await this.signature(env, w.path, w.dir);
    if (sig === null) return; // 这轮读不到（路径被删 / 断连）：保留基线
    if (w.sig === null) {
      w.sig = sig; // 首轮只建基线，否则订阅瞬间会误报一次
      return;
    }
    if (sig === w.sig) return;
    w.sig = sig;
    if (this.disposed) return;
    // 目录变了报目录路径本身，文件变了报文件路径
    for (const key of w.keys) this.notify(key, w.envId, [w.path]);
  }

  private async signature(
    env: ExecEnv,
    path: string,
    dir: boolean,
  ): Promise<string | null> {
    if (!dir) {
      const st = await env.stat(path);
      return st === null ? null : `f:${st.mtimeMs}:${st.size}`;
    }
    const names = (await env.readdir(path)).map((e) => e.name).sort();
    const parts: string[] = [];
    for (const name of names) {
      const st = await env.stat(join(path, name));
      // 名字 + size + mtimeMs：覆盖增删改名与内容变更
      parts.push(`${name}:${st?.size ?? -1}:${st?.mtimeMs ?? -1}`);
    }
    return parts.join("\n");
  }

  private notify(key: string, envId: string, paths: readonly string[]): void {
    if (this.disposed || paths.length === 0) return;
    const batch = this.debounced.get(key);
    if (batch) {
      for (const p of paths) batch.paths.add(p);
      return;
    }
    this.debounced.set(key, {
      envId,
      paths: new Set(paths),
      timer: setTimeout(() => this.flush(key), this.debounceMs),
    });
  }

  private flush(key: string): void {
    const batch = this.debounced.get(key);
    if (!batch) return;
    this.debounced.delete(key);
    if (this.disposed) return;
    const paths = [...batch.paths].sort();
    for (const listener of [...this.listeners]) {
      try {
        listener(key, batch.envId, paths);
      } catch {
        // 单个监听者抛错不影响其它监听者，也不冒泡
      }
    }
  }
}
