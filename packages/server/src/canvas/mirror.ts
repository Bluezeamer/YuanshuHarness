// 画布副本的后台镜像（canvas.md §10 本地优先）：Server 本机的 `.canvas/` 副本是权威，远端只是镜像。
// 接入：第一次用某个远端项目的画布时，把远端 `.canvas/`（除 .git）拉到本机副本，之后所有读写都在本机。
// 推送：不记操作队列，而是拿「上次推送成功时的清单」与副本现状比对，差异推到远端——所以重启、断线、重复触发都天然幂等。
// 单写者：远端只有这里写；推之前看一眼远端文件有没有被别处改过，改过的先另存成旁边的副本再写，不覆盖。
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import nodePath from "node:path";
import { pipeline } from "node:stream/promises";
import type { ExecEnv } from "../env/types.js";
import { pathOf } from "../permission/paths.js";

interface Stamp {
  size: number;
  mtimeMs: number;
}

type Entry =
  | { kind: "dir" }
  | { kind: "file"; local: Stamp; sha: string; remote: Stamp };

interface Meta {
  version: 1;
  remoteDir: string;
  entries: Record<string, Entry>;
  asides: string[];
}

type Op =
  | { t: "mkdir"; rel: string }
  | { t: "rename"; from: string; to: string; stamp: Stamp; sha: string }
  | { t: "write"; rel: string; stamp: Stamp; sha: string }
  | { t: "del"; rel: string }
  | { t: "rmdir"; rel: string };

export interface MirrorStatus {
  /** synced 已一致；pending 有改动等着推；syncing 正在推；offline 上一次推送失败，会自动重试 */
  state: "synced" | "pending" | "syncing" | "offline";
  /** 上一次比对出的待推送项数 */
  pending: number;
  error?: string;
  /** 远端文件被外部改过、已另存的副本路径（远端路径，最近 10 条，重启后保留） */
  asides: string[];
}

export interface MirrorOptions {
  remote: ExecEnv;
  /** 远端 `<项目>/.canvas` */
  remoteRoot: string;
  /** 本机，要能 exec（副本里的 git 在它上面跑） */
  local: ExecEnv;
  /** 副本的 `.canvas` */
  localRoot: string;
  /** 清单文件，放在 localRoot 之外 */
  metaFile: string;
  /** 首次接入成功后在远端做一次的事（失败忽略） */
  onAdopted?: () => Promise<void>;
  /** 最后一次改动之后等多久再推；默认 800 */
  debounceMs?: number;
  now?: () => Date;
}

const SKIP_TOP = ".git";
const TEMP_SUFFIX = ".part";
const KEEP_ASIDES = 10;
const RETRY_MS = [2000, 5000, 15000, 60000];

/** 最多 limit 个并发；有失败时不再取新的，等在途的收尾后抛出第一个错误。 */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      try {
        await fn(items[next++] as T);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (failure !== null) throw (failure as { err: unknown }).err;
}

const sameStamp = (a: Stamp, b: Stamp): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs;

const depth = (rel: string): number => rel.split("/").length;

export class CanvasMirror {
  private readonly remote: ExecEnv;
  private readonly local: ExecEnv;
  private readonly rp: ReturnType<typeof pathOf>;
  private entries: Record<string, Entry> = {};
  private asides: string[] = [];
  private adoptedFlag: boolean;
  private readyP: Promise<void> | null = null;
  /** 副本被动过的次数；settledEpoch 是已经推完的那一次 */
  private epoch = 0;
  private settledEpoch = 0;
  private failing = false;
  private pendingCount = 0;
  private lastError: string | undefined;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly o: MirrorOptions) {
    this.remote = o.remote;
    this.local = o.local;
    this.rp = pathOf(o.remote);
    // 清单文件只在接入完成时才第一次写出，有它就是接入过
    this.adoptedFlag = existsSync(o.metaFile);
  }

  /** 接入过了（副本已经是权威）：这时不必再为校验目录之类的事去问远端 */
  get adopted(): boolean {
    return this.adoptedFlag;
  }

  /** 副本可用。第一次会从远端拉一遍，之后只读本机清单；失败时下次再试。 */
  ready(): Promise<void> {
    this.readyP ??= (this.adoptedFlag ? this.load() : this.adopt()).catch(
      (err: unknown) => {
        this.readyP = null;
        throw err;
      },
    );
    return this.readyP;
  }

  /** 副本里有改动：稍后推到远端。 */
  touch(): void {
    if (this.closed) return;
    this.epoch++;
    this.arm(this.o.debounceMs ?? 800);
  }

  /** 状态只反映「比对出了要推的东西」：碰了一下副本但内容没变，不算待同步。 */
  status(): MirrorStatus {
    const state = this.failing
      ? "offline"
      : this.pendingCount === 0
        ? "synced"
        : this.running !== null
          ? "syncing"
          : "pending";
    return {
      state,
      pending: this.pendingCount,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
      asides: [...this.asides],
    };
  }

  /** 立刻推一次并等它做完；超时返回 false（远端不通时别让调用方一直等）。 */
  async settle(timeoutMs: number): Promise<boolean> {
    if (!this.adoptedFlag) return true;
    // 重启后清单还在读：读完才知道有没有上次没推完的
    await this.ready().catch(() => {});
    if (this.settledEpoch === this.epoch && !this.failing) return true;
    this.disarm();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.cycle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return this.settledEpoch === this.epoch && !this.failing;
  }

  close(): void {
    this.closed = true;
    this.disarm();
  }

  // ---- 接入：远端 → 本机 ----

  private async adopt(): Promise<void> {
    const { local, remote, localRoot, remoteRoot } = this.o;
    if ((await local.stat(localRoot)) !== null)
      await local.remove(localRoot, true);
    this.entries = {};
    this.asides = [];
    if ((await remote.stat(remoteRoot))?.isDirectory === true) {
      await local.mkdirp(localRoot);
      await this.pullDir("");
    }
    await this.o.onAdopted?.().catch(() => {});
    await this.save();
    this.adoptedFlag = true;
  }

  private async pullDir(rel: string): Promise<void> {
    const list = await this.remote.readdir(this.remotePath(rel));
    const files: Array<{ rel: string; stamp: Stamp | null }> = [];
    for (const e of list) {
      if (e.isSymlink || (rel === "" && e.name === SKIP_TOP)) continue;
      if (e.name.endsWith(TEMP_SUFFIX)) continue;
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory) {
        await this.local.mkdirp(this.localPath(child));
        this.entries[child] = { kind: "dir" };
        await this.pullDir(child);
      } else {
        files.push({
          rel: child,
          stamp:
            e.size !== undefined && e.mtimeMs !== undefined
              ? { size: e.size, mtimeMs: e.mtimeMs }
              : null,
        });
      }
    }
    await mapLimit(files, 8, async (f) => {
      const rpath = this.remotePath(f.rel);
      const lpath = this.localPath(f.rel);
      const tmp = `${lpath}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`;
      const got = await this.transfer(this.remote, rpath, this.local, tmp);
      await this.local.rename(tmp, lpath);
      const remoteStamp = f.stamp ?? (await this.stampOf(this.remote, rpath));
      const localStamp = await this.stampOf(this.local, lpath);
      if (remoteStamp === null || localStamp === null)
        throw new Error(`拉取时文件消失：${f.rel}`);
      this.entries[f.rel] = {
        kind: "file",
        local: localStamp,
        sha: got.sha,
        remote: remoteStamp,
      };
    });
  }

  private async load(): Promise<void> {
    const text = (await this.local.readFile(this.o.metaFile)).toString("utf8");
    let meta: Meta;
    try {
      meta = JSON.parse(text) as Meta;
    } catch {
      throw new Error(`画布副本的清单损坏：${this.o.metaFile}`);
    }
    if (meta.version !== 1)
      throw new Error(`画布副本的清单版本不认识：${meta.version}`);
    this.entries = meta.entries;
    this.asides = meta.asides;
    // 退出前可能有没推完的：登记一次，让后台比对
    this.touch();
  }

  private async save(): Promise<void> {
    const meta: Meta = {
      version: 1,
      remoteDir: this.o.remoteRoot,
      entries: this.entries,
      asides: this.asides,
    };
    const tmp = `${this.o.metaFile}${TEMP_SUFFIX}`;
    await this.local.mkdirp(nodePath.dirname(this.o.metaFile));
    await this.local.writeFile(tmp, JSON.stringify(meta));
    await this.local.rename(tmp, this.o.metaFile);
  }

  // ---- 推送：本机 → 远端 ----

  private arm(ms: number): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.cycle();
    }, ms);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 推到没有新改动为止；失败退避重试。同一时刻只有一轮在跑。 */
  private cycle(): Promise<void> {
    this.running ??= (async () => {
      try {
        for (;;) {
          const seen = this.epoch;
          try {
            await this.ready();
            await this.push();
          } catch (err) {
            this.failures++;
            this.lastError = err instanceof Error ? err.message : String(err);
            this.failing = true;
            if (!this.closed)
              this.arm(
                RETRY_MS[Math.min(this.failures, RETRY_MS.length) - 1] ?? 60000,
              );
            return;
          }
          this.failures = 0;
          this.failing = false;
          this.lastError = undefined;
          this.settledEpoch = seen;
          if (this.epoch === seen) return;
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async push(): Promise<void> {
    let ops = await this.plan();
    this.pendingCount = ops.length;
    if (ops.length === 0) return;
    if ((await this.remote.stat(this.o.remoteRoot)) === null) {
      // 远端的 .canvas 没了：项目目录还在就整份重推（清单里的都当没推过）；项目目录也没了就别替它重建
      const parent = this.rp.dirname(this.o.remoteRoot);
      if ((await this.remote.stat(parent))?.isDirectory !== true)
        throw new Error(`远端项目目录不存在：${parent}`);
      if (Object.keys(this.entries).length > 0) {
        this.entries = {};
        ops = await this.plan();
        this.pendingCount = ops.length;
      }
    }
    const by = (t: Op["t"]) => ops.filter((op) => op.t === t);
    try {
      await this.remote.mkdirp(this.o.remoteRoot);
      for (const op of [...by("mkdir"), ...by("rename")]) await this.apply(op);
      await mapLimit(by("write"), 4, (op) => this.apply(op));
      for (const op of [...by("del"), ...by("rmdir")]) await this.apply(op);
      this.pendingCount = 0;
    } finally {
      // 失败时也把已经推成功的记下来，重试不必重来
      await this.save().catch(() => {});
    }
  }

  /** 副本现状 vs 清单，得出要推的事。内容没变只是时间变了的文件顺手更新清单。 */
  private async plan(): Promise<Op[]> {
    const now = await this.scan();
    const mkdirs: string[] = [];
    const candidates: Array<[string, Stamp]> = [];
    for (const [rel, cur] of now) {
      const base = this.entries[rel];
      if (cur.stamp === null) {
        if (base?.kind !== "dir") mkdirs.push(rel);
      } else if (base?.kind !== "file" || !sameStamp(base.local, cur.stamp))
        candidates.push([rel, cur.stamp]);
    }
    const writes: Array<{ rel: string; stamp: Stamp; sha: string }> = [];
    await mapLimit(candidates, 8, async ([rel, stamp]) => {
      let sha: string;
      try {
        sha = (await this.hashOf(this.local, this.localPath(rel))).sha;
      } catch (err) {
        // 扫描之后文件又被挪走或删了：这一轮不管它，下一轮的扫描会看到
        if ((await this.stampOf(this.local, this.localPath(rel))) === null)
          return;
        throw err;
      }
      const base = this.entries[rel];
      if (base?.kind === "file" && base.sha === sha) base.local = stamp;
      else writes.push({ rel, stamp, sha });
    });
    const dels: string[] = [];
    const rmdirs: string[] = [];
    for (const [rel, base] of Object.entries(this.entries))
      if (!now.has(rel)) (base.kind === "dir" ? rmdirs : dels).push(rel);
    // 删掉的文件与新增的文件内容相同：当作改名，远端 rename 就行，不重传
    const gone = new Map<string, string[]>();
    for (const rel of dels) {
      const base = this.entries[rel];
      if (base?.kind === "file")
        gone.set(base.sha, [...(gone.get(base.sha) ?? []), rel]);
    }
    const ops: Op[] = [];
    const moved = new Set<string>();
    const plainWrites: Op[] = [];
    for (const w of writes) {
      const from =
        this.entries[w.rel] === undefined ? gone.get(w.sha)?.pop() : undefined;
      if (from === undefined) plainWrites.push({ t: "write", ...w });
      else {
        moved.add(from);
        ops.push({ t: "rename", from, to: w.rel, stamp: w.stamp, sha: w.sha });
      }
    }
    return [
      ...mkdirs
        .sort((a, b) => depth(a) - depth(b))
        .map((rel): Op => ({ t: "mkdir", rel })),
      ...ops,
      ...plainWrites,
      ...dels
        .filter((r) => !moved.has(r))
        .map((rel): Op => ({ t: "del", rel })),
      ...rmdirs
        .sort((a, b) => depth(b) - depth(a))
        .map((rel): Op => ({ t: "rmdir", rel })),
    ];
  }

  /** 副本里的全部目录与文件（stamp 为 null 的是目录）；不含 .git 与临时文件。 */
  private async scan(): Promise<Map<string, { stamp: Stamp | null }>> {
    const out = new Map<string, { stamp: Stamp | null }>();
    if ((await this.local.stat(this.o.localRoot))?.isDirectory !== true) {
      if (Object.keys(this.entries).length > 0)
        throw new Error(`本机的画布副本目录不见了：${this.o.localRoot}`);
      return out;
    }
    const walk = async (rel: string): Promise<void> => {
      const list = await this.local.readdir(
        rel === "" ? this.o.localRoot : this.localPath(rel),
      );
      const files: string[] = [];
      for (const e of list) {
        if (e.isSymlink || e.name.endsWith(TEMP_SUFFIX)) continue;
        if (rel === "" && e.name === SKIP_TOP) continue;
        const child = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory) {
          out.set(child, { stamp: null });
          await walk(child);
        } else files.push(child);
      }
      await mapLimit(files, 16, async (child) => {
        const stamp = await this.stampOf(this.local, this.localPath(child));
        if (stamp !== null) out.set(child, { stamp });
      });
    };
    await walk("");
    return out;
  }

  private async apply(op: Op): Promise<void> {
    switch (op.t) {
      case "mkdir":
        await this.remote.mkdirp(this.remotePath(op.rel));
        this.entries[op.rel] = { kind: "dir" };
        return;
      case "rmdir": {
        const at = this.remotePath(op.rel);
        // 那里已经被换成别的东西（文件）就别动；目录里还有文件时删不掉，留着
        if ((await this.remote.lstat(at))?.isDirectory === true)
          await this.remote.remove(at).catch(() => {});
        delete this.entries[op.rel];
        return;
      }
      case "del": {
        const base = this.entries[op.rel];
        if ((await this.guard(op.rel, base)) === "ours")
          await this.remote.remove(this.remotePath(op.rel));
        delete this.entries[op.rel];
        return;
      }
      case "write":
        return this.write(op.rel, op.stamp, op.sha);
      case "rename": {
        const from = this.entries[op.from];
        const free =
          (await this.guard(op.from, from)) === "ours" &&
          (await this.guard(op.to, undefined, op.sha)) === "absent";
        if (!free) {
          await this.write(op.to, op.stamp, op.sha);
          return this.apply({ t: "del", rel: op.from });
        }
        await this.remote.rename(
          this.remotePath(op.from),
          this.remotePath(op.to),
        );
        delete this.entries[op.from];
        await this.record(op.to, op.stamp, op.sha);
        return;
      }
    }
  }

  private async write(rel: string, stamp: Stamp, sha: string): Promise<void> {
    const base = this.entries[rel];
    const seen = await this.guard(rel, base, sha);
    if (seen === "same") return this.record(rel, stamp, sha);
    const rpath = this.remotePath(rel);
    const tmp = `${rpath}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`;
    try {
      const got = await this.transfer(
        this.local,
        this.localPath(rel),
        this.remote,
        tmp,
      );
      await this.remote.rename(tmp, rpath);
      await this.record(rel, stamp, got.sha);
    } catch (err) {
      await this.remote.remove(tmp).catch(() => {});
      // 计划之后文件又被挪走或删了：留给下一轮
      if ((await this.stampOf(this.local, this.localPath(rel))) === null)
        return;
      throw err;
    }
  }

  /** 推完一个文件：清单里记下本机与远端各自的戳，下次比对、下次动手前校验都靠它。 */
  private async record(rel: string, local: Stamp, sha: string): Promise<void> {
    const remote = await this.stampOf(this.remote, this.remotePath(rel));
    if (remote === null) throw new Error(`推送后远端文件不见了：${rel}`);
    this.entries[rel] = { kind: "file", local, sha, remote };
  }

  /**
   * 动手改远端这个路径之前先看一眼：
   * - absent：那里什么都没有；
   * - ours：有，而且就是我们上次推的样子（戳没变，或戳变了但内容一样），可以覆盖或删除；
   * - same：有，内容正好是我们要写的（上次推到一半崩溃的情形），不必再写；
   * - 其余是被外部改过：先改名另存到旁边，再当作 absent。
   */
  private async guard(
    rel: string,
    base: Entry | undefined,
    want?: string,
  ): Promise<"absent" | "ours" | "same"> {
    const rpath = this.remotePath(rel);
    const st = await this.remote.stat(rpath);
    if (st === null || !st.isFile) return "absent";
    if (
      base?.kind === "file" &&
      sameStamp(base.remote, { size: st.size, mtimeMs: st.mtimeMs })
    )
      return "ours";
    const sha = (await this.hashOf(this.remote, rpath)).sha;
    if (base?.kind === "file" && sha === base.sha) return "ours";
    if (sha === want) return "same";
    let aside = this.asideName(rpath, 1);
    for (let n = 2; (await this.remote.lstat(aside)) !== null; n++)
      aside = this.asideName(rpath, n);
    await this.remote.rename(rpath, aside);
    this.asides = [aside, ...this.asides].slice(0, KEEP_ASIDES);
    return "absent";
  }

  private asideName(rpath: string, n: number): string {
    const d = (this.o.now ?? (() => new Date()))();
    const p = (n: number) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const ext = this.rp.extname(rpath);
    return `${rpath.slice(0, rpath.length - ext.length)}.remote-${ts}${n > 1 ? `-${n}` : ""}${ext}`;
  }

  // ---- 小工具 ----

  private remotePath(rel: string): string {
    return rel === ""
      ? this.o.remoteRoot
      : this.rp.join(this.o.remoteRoot, ...rel.split("/"));
  }

  private localPath(rel: string): string {
    return nodePath.join(this.o.localRoot, ...rel.split("/"));
  }

  private async stampOf(env: ExecEnv, p: string): Promise<Stamp | null> {
    const st = await env.stat(p);
    return st === null || !st.isFile
      ? null
      : { size: st.size, mtimeMs: st.mtimeMs };
  }

  private async hashOf(
    env: ExecEnv,
    p: string,
  ): Promise<{ sha: string; size: number }> {
    const h = createHash("sha256");
    let size = 0;
    for await (const c of await env.readStream(p)) {
      h.update(c as Buffer);
      size += (c as Buffer).length;
    }
    return { sha: h.digest("hex"), size };
  }

  /** 流式复制并顺手算内容哈希（大文件不进内存）。 */
  private async transfer(
    from: ExecEnv,
    fromPath: string,
    to: ExecEnv,
    toPath: string,
  ): Promise<{ sha: string; size: number }> {
    const h = createHash("sha256");
    let size = 0;
    const src = await from.readStream(fromPath);
    const dst = await to.writeStream(toPath);
    await pipeline(
      src,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const c of chunks) {
          h.update(c);
          size += c.length;
          yield c;
        }
      },
      dst,
    );
    // sftp 写流在 finish 时句柄可能尚未关闭，等 close 再改名
    if (!dst.closed) await once(dst, "close");
    return { sha: h.digest("hex"), size };
  }
}
