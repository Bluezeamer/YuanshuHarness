// 画布图片的缩略图（canvas.md §8）：光子 WASM 是同步的，解码 / 缩放 / 编码都在 worker 里跑，
// 否则一次 4k JPEG 就把整个 Server 的事件循环堵上近一秒；缩略图落在 Server 磁盘上，
// 命中缓存时连源文件都不读（远程主机上读原图要过 SFTP）。
import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ExecEnv } from "../env/types.js";
import { CanvasError } from "./repo.js";

/** 缩放参数：每次请求现取（设置里改了下一张就生效）。 */
export interface ThumbOptions {
  maxSide: number;
  quality: number;
}

/** 可替换的缩放实现；测试用它省掉真实 WASM 压缩。 */
export type ThumbResize = (
  bytes: Uint8Array,
  mime: string,
  opts: ThumbOptions,
) => Promise<{ data: Uint8Array; mime: string } | null>;

/** 设置里能调的几项（体积是字节）：缩放参数，加上哪些原样给、多大不显示。 */
export interface ThumbSettings extends ThumbOptions {
  gifMaxBytes: number;
  sourceMaxBytes: number;
}

export interface ThumbResult {
  kind: "thumb" | "raw";
  data: Buffer;
  mime: string;
  etag: string;
}

/** 设置没接上时（测试）的缺省，与 store/defaults.ts 的画布媒体缺省一致。 */
const DEFAULT_SETTINGS: ThumbSettings = {
  maxSide: 2000,
  quality: 85,
  gifMaxBytes: 8 * 1024 * 1024,
  sourceMaxBytes: 20 * 1024 * 1024,
};

const MAX_SVG = 512 * 1024;
const RAW_FALLBACK = 2 * 1024 * 1024;
const CACHE_MAX = 3000;
const CACHE_SWEEP = 500;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_WORKERS = 2;
const IDLE_MS = 60_000;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

const extOf = (abs: string): string => {
  const base = abs.slice(
    Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\")) + 1,
  );
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/** 只收 jpeg / png 两种缩略图：缓存按扩展名定 mime，存进别的编码会被认错。 */
const thumbMime = (m: string): "image/jpeg" | "image/png" | null =>
  m === "image/jpeg" ? "image/jpeg" : m === "image/png" ? "image/png" : null;

const tooLarge = (size: number, max: number): CanvasError =>
  new CanvasError("too_large", "文件太大，无法作为图片显示", { size, max });

// ---- worker ----

interface QueueItem {
  id: number;
  bytes: Uint8Array;
  mime: string;
  opts: ThumbOptions;
  resolve: (v: { data: Uint8Array; mime: string } | null) => void;
}

interface Slot {
  worker: Worker;
  /** 手上正在跑的任务；worker 崩溃或退出时用它判失败。 */
  busy: QueueItem | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 最多 2 个 worker、FIFO 排队、空闲 60 秒终止；失败只让当前任务得到 null，worker 随即被换掉。 */
export function workerResize(
  opts: { maxWorkers?: number; idleMs?: number } = {},
): ThumbResize & { close(): void } {
  const maxWorkers = opts.maxWorkers ?? MAX_WORKERS;
  const idleMs = opts.idleMs ?? IDLE_MS;
  // 编译后 worker 脚本是 .js，测试里 vitest 直接跑 .ts；两种后缀 Node 都能加载。
  const script = new URL(
    import.meta.url.endsWith(".ts") ? "./thumb-worker.ts" : "./thumb-worker.js",
    import.meta.url,
  );
  const idle: Slot[] = [];
  const all = new Set<Slot>();
  const queue: QueueItem[] = [];
  let seq = 0;
  let closed = false;

  const drop = (slot: Slot): void => {
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    all.delete(slot);
    const i = idle.indexOf(slot);
    if (i >= 0) idle.splice(i, 1);
    void slot.worker.terminate().catch(() => {});
  };

  const release = (slot: Slot): void => {
    slot.busy = null;
    if (closed) {
      drop(slot);
      return;
    }
    idle.push(slot);
    slot.timer = setTimeout(() => drop(slot), idleMs);
    slot.timer.unref?.();
  };

  const spawn = (): Slot => {
    const worker = new Worker(script);
    const slot: Slot = { worker, busy: null, timer: null };
    worker.unref();
    worker.on(
      "message",
      (msg: { id: number; ok: boolean; data?: Uint8Array; mime?: string }) => {
        const item = slot.busy;
        if (item === null || item.id !== msg.id) return;
        release(slot);
        item.resolve(
          msg.ok && msg.data !== undefined && msg.mime !== undefined
            ? { data: msg.data, mime: msg.mime }
            : null,
        );
        // 排队的任务等这个 worker 空出来，接着派给它。
        pump();
      },
    );
    // 崩溃与正常退出走同一套：当前任务失败、worker 换掉，不重试。
    const fail = () => {
      const item = slot.busy;
      slot.busy = null;
      drop(slot);
      item?.resolve(null);
      pump();
    };
    worker.on("error", fail);
    worker.on("exit", fail);
    all.add(slot);
    return slot;
  };

  function pump(): void {
    while (queue.length > 0) {
      const slot = idle.shift() ?? (all.size < maxWorkers ? spawn() : null);
      if (slot === null) return;
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      const item = queue.shift() as QueueItem;
      slot.busy = item;
      // 复制一份再交出去：transfer 会让原来的 buffer 失效，调用方的字节还要用。
      const copy = new Uint8Array(item.bytes);
      slot.worker.postMessage(
        {
          id: item.id,
          bytes: copy,
          mime: item.mime,
          maxSide: item.opts.maxSide,
          quality: item.opts.quality,
        },
        [copy.buffer],
      );
    }
  }

  return Object.assign(
    (bytes: Uint8Array, mime: string, opts: ThumbOptions) =>
      new Promise<{ data: Uint8Array; mime: string } | null>((resolve) => {
        if (closed) return resolve(null);
        queue.push({ id: ++seq, bytes, mime, opts, resolve });
        pump();
      }),
    {
      close(): void {
        closed = true;
        for (const item of queue.splice(0)) item.resolve(null);
        for (const slot of [...all]) {
          // 手上那个任务在 terminate 之后再也等不到回应，直接判失败。
          slot.busy?.resolve(null);
          slot.busy = null;
          drop(slot);
        }
      },
    },
  );
}

// ---- 缓存与分派 ----

export interface ThumbServiceDeps {
  cacheDir: string;
  resize: ThumbResize;
  /** 每次请求现取；缺省用内置的缺省值 */
  settings?: () => ThumbSettings;
}

export class ThumbService {
  private readonly cacheDir: string;
  private readonly resize: ThumbResize;
  private readonly settings: () => ThumbSettings;
  /** 同一个 key 的并发请求共用一个 Promise，不重复解码。 */
  private readonly inflight = new Map<string, Promise<ThumbResult>>();
  private lastSweep = 0;

  constructor(deps: ThumbServiceDeps) {
    this.cacheDir = deps.cacheDir;
    this.resize = deps.resize;
    this.settings = deps.settings ?? (() => DEFAULT_SETTINGS);
  }

  /** 当前设置的指纹：设置变了它就变；界面把它带进图片地址，浏览器长期缓存的旧缩略图才会作废 */
  rev(): string {
    const c = this.settings();
    return sha1(
      `${c.maxSide}\0${c.quality}\0${c.gifMaxBytes}\0${c.sourceMaxBytes}`,
    ).slice(0, 8);
  }

  async get(env: ExecEnv, envId: string, abs: string): Promise<ThumbResult> {
    const mime = MIME[extOf(abs)];
    if (mime === undefined)
      throw new CanvasError("unsupported", "不支持的图片格式");
    const st = await env.stat(abs).catch(() => null);
    if (st?.isFile !== true) throw new CanvasError("not_found", "文件不存在");
    const cfg = this.settings();
    if (st.size > cfg.sourceMaxBytes)
      throw tooLarge(st.size, cfg.sourceMaxBytes);
    const etag = this.key(envId, abs, st, cfg);
    // svg 是矢量、小 gif 是动画：原样给出，缩了就丢东西。
    if (mime === "image/svg+xml") {
      if (st.size > MAX_SVG) throw tooLarge(st.size, MAX_SVG);
      return { kind: "raw", data: await env.readFile(abs), mime, etag };
    }
    if (mime === "image/gif" && st.size <= cfg.gifMaxBytes)
      return { kind: "raw", data: await env.readFile(abs), mime, etag };

    const cached = await this.readCache(etag);
    if (cached !== null) return cached;
    const running = this.inflight.get(etag);
    if (running !== undefined) return running;
    const job = this.make(env, abs, mime, st.size, etag, cfg).finally(() => {
      this.inflight.delete(etag);
    });
    this.inflight.set(etag, job);
    return job;
  }

  private async make(
    env: ExecEnv,
    abs: string,
    mime: string,
    size: number,
    etag: string,
    cfg: ThumbSettings,
  ): Promise<ThumbResult> {
    const bytes = await env.readFile(abs).catch(() => null);
    if (bytes === null) throw new CanvasError("not_found", "文件不存在");
    const out = await this.resize(new Uint8Array(bytes), mime, {
      maxSide: cfg.maxSide,
      quality: cfg.quality,
    }).catch(() => null);
    const outMime = out === null ? null : thumbMime(out.mime);
    if (out === null || outMime === null) {
      // WASM 不可用或压不到上限：小图原样给出，大图不硬塞。
      if (size > RAW_FALLBACK) throw tooLarge(size, RAW_FALLBACK);
      return { kind: "raw", data: bytes, mime, etag };
    }
    const result: ThumbResult = {
      kind: "thumb",
      data: Buffer.from(out.data),
      mime: outMime,
      etag,
    };
    await this.writeCache(etag, outMime, result.data);
    return result;
  }

  /** 路径、mtime、大小、最长边与质量任一变化就是另一条缓存。 */
  private key(
    envId: string,
    abs: string,
    st: { mtimeMs: number; size: number },
    cfg: ThumbOptions,
  ): string {
    return sha1(
      `${envId}\0${abs}\0${Math.round(st.mtimeMs)}\0${st.size}\0${cfg.maxSide}\0${cfg.quality}`,
    );
  }

  /** 缩略图文件名 = key + 编码后的扩展名；两种都试一次，命中就是完整的一条。 */
  private async readCache(etag: string): Promise<ThumbResult | null> {
    for (const ext of [".jpg", ".png"]) {
      const data = await readFile(path.join(this.cacheDir, etag + ext)).catch(
        () => null,
      );
      if (data !== null)
        return {
          kind: "thumb",
          data,
          mime: ext === ".jpg" ? "image/jpeg" : "image/png",
          etag,
        };
    }
    return null;
  }

  private async writeCache(
    etag: string,
    mime: string,
    data: Buffer,
  ): Promise<void> {
    const name = etag + (mime === "image/jpeg" ? ".jpg" : ".png");
    await mkdir(this.cacheDir, { recursive: true });
    // 同目录临时文件 + rename：并发读到的要么没有、要么是完整的。
    const tmp = path.join(
      this.cacheDir,
      `.${name}.${Math.random().toString(16).slice(2, 10)}.part`,
    );
    await writeFile(tmp, data);
    await rename(tmp, path.join(this.cacheDir, name));
    await this.sweep();
  }

  /** 超过 3000 条就删最旧的 500 条；同一进程里最多每分钟清一次。 */
  private async sweep(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    const names = await readdir(this.cacheDir).catch(() => []);
    const entries = names.filter(
      (n) => n.endsWith(".jpg") || n.endsWith(".png"),
    );
    if (entries.length <= CACHE_MAX) return;
    const dated: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of entries) {
      const st = await stat(path.join(this.cacheDir, name)).catch(() => null);
      if (st !== null) dated.push({ name, mtimeMs: st.mtimeMs });
    }
    dated.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of dated.slice(0, CACHE_SWEEP))
      await unlink(path.join(this.cacheDir, e.name)).catch(() => {});
  }
}
