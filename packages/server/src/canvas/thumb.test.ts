import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { LocalEnv } from "../env/local.js";
import type { ExecEnv } from "../env/types.js";
import { CanvasError } from "./repo.js";
import {
  type ThumbResize,
  ThumbService,
  type ThumbSettings,
  workerResize,
} from "./thumb.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const env = new LocalEnv();

/** 只数源文件读取次数，用来验证缓存命中后不再读源文件。 */
function counting(base: ExecEnv): ExecEnv & { reads: number } {
  let reads = 0;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "reads") return reads;
      if (prop === "readFile")
        return async (p: string) => {
          reads++;
          return target.readFile(p);
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as ExecEnv & { reads: number };
}

const fakeResize = (mime = "image/png") => {
  const calls: Array<{
    bytes: number;
    mime: string;
    maxSide: number;
    quality: number;
  }> = [];
  const resize: ThumbResize = async (bytes, m, opts) => {
    calls.push({ bytes: bytes.length, mime: m, ...opts });
    return { data: new Uint8Array([1, 2, 3]), mime };
  };
  return { resize, calls };
};

const MB = 1024 * 1024;
/** 测试用的设置：GIF 原样上限取 1MB（旧版的值），要改某一项就在 over 里给 */
const settings = (over: Partial<ThumbSettings> = {}): ThumbSettings => ({
  maxSide: 2000,
  quality: 85,
  gifMaxBytes: MB,
  sourceMaxBytes: 20 * MB,
  ...over,
});

const service = (
  cacheDir: string,
  resize: ThumbResize,
  get: () => ThumbSettings = settings,
): ThumbService => new ThumbService({ cacheDir, resize, settings: get });

const write = (dir: string, name: string, bytes: Buffer | string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
};

const code = async (run: Promise<unknown>): Promise<string> => {
  const err = await run.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CanvasError);
  return (err as CanvasError).code;
};

describe("ThumbService：格式与上限", () => {
  test("扩展名白名单外 415；不存在的文件 404", async () => {
    const dir = tmp("yuanshu-thumb-");
    const { resize } = fakeResize();
    const s = service(tmp("yuanshu-thumb-cache-"), resize);
    const avif = write(dir, "a.avif", "x");
    expect(await code(s.get(env, "local", avif))).toBe("unsupported");
    const md = write(dir, "a.md", "x");
    expect(await code(s.get(env, "local", md))).toBe("unsupported");
    expect(await code(s.get(env, "local", path.join(dir, "gone.png")))).toBe(
      "not_found",
    );
  });

  test("源文件 20MB 以上 413，不读不解码", async () => {
    const dir = tmp("yuanshu-thumb-");
    const counted = counting(env);
    const { resize, calls } = fakeResize();
    const s = service(tmp("yuanshu-thumb-cache-"), resize);
    const big = write(dir, "big.png", Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(await code(s.get(counted, "local", big))).toBe("too_large");
    expect(counted.reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("svg 512KB 以内原样返回，超过 413；gif 1MB 以内保留原样", async () => {
    const dir = tmp("yuanshu-thumb-");
    const { resize, calls } = fakeResize();
    const s = service(tmp("yuanshu-thumb-cache-"), resize);
    const svg = write(dir, "a.SVG", Buffer.alloc(512 * 1024, 0x20));
    const raw = await s.get(env, "local", svg);
    expect(raw).toMatchObject({ kind: "raw", mime: "image/svg+xml" });
    expect(raw.data.length).toBe(512 * 1024);
    const bigSvg = write(dir, "big.svg", Buffer.alloc(512 * 1024 + 1, 0x20));
    expect(await code(s.get(env, "local", bigSvg))).toBe("too_large");

    const gif = write(dir, "a.gif", Buffer.alloc(1024 * 1024, 0x41));
    expect(await s.get(env, "local", gif)).toMatchObject({
      kind: "raw",
      mime: "image/gif",
    });
    const bigGif = write(
      dir,
      "big.gif",
      Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(1024 * 1024, 0x41)]),
    );
    expect(await s.get(env, "local", bigGif)).toMatchObject({
      kind: "thumb",
      mime: "image/png",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mime).toBe("image/gif");
  });

  test("设置每次请求现取：改了 GIF 上限、最长边与质量立刻生效，缓存按它们分开", async () => {
    const dir = tmp("yuanshu-thumb-");
    const { resize, calls } = fakeResize();
    let cur = settings();
    const s = service(tmp("yuanshu-thumb-cache-"), resize, () => cur);
    const gif = write(
      dir,
      "m.gif",
      Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(3 * MB, 0x41)]),
    );
    // 上限 1MB：3MB 的 GIF 只给缩略图（第一帧）
    expect((await s.get(env, "local", gif)).kind).toBe("thumb");
    // 调到 8MB：同一个文件原样给出，动画保留，也不用再解码
    cur = settings({ gifMaxBytes: 8 * MB });
    expect(await s.get(env, "local", gif)).toMatchObject({
      kind: "raw",
      mime: "image/gif",
    });
    expect(calls).toHaveLength(1);

    const png = write(dir, "a.png", Buffer.alloc(1024, 1));
    cur = settings();
    await s.get(env, "local", png);
    await s.get(env, "local", png);
    expect(calls).toHaveLength(2);
    cur = settings({ maxSide: 800 });
    await s.get(env, "local", png);
    cur = settings({ maxSide: 800, quality: 60 });
    await s.get(env, "local", png);
    expect(calls.slice(2).map((c) => [c.maxSide, c.quality])).toEqual([
      [800, 85],
      [800, 60],
    ]);
  });

  test("rev：任一影响输出的设置变了指纹就变，没变则不变", () => {
    let cur = settings();
    const s = service(
      tmp("yuanshu-thumb-cache-"),
      fakeResize().resize,
      () => cur,
    );
    const a = s.rev();
    expect(s.rev()).toBe(a);
    for (const over of [
      { maxSide: 800 },
      { quality: 60 },
      { gifMaxBytes: 8 * MB },
      { sourceMaxBytes: 3 * MB },
    ]) {
      cur = settings(over);
      expect(s.rev()).not.toBe(a);
    }
    cur = settings();
    expect(s.rev()).toBe(a);
  });

  test("原图上限可调：超过就 413，调高后放行", async () => {
    const dir = tmp("yuanshu-thumb-");
    const { resize } = fakeResize();
    let cur = settings({ sourceMaxBytes: MB });
    const s = service(tmp("yuanshu-thumb-cache-"), resize, () => cur);
    const png = write(dir, "big.png", Buffer.alloc(2 * MB, 1));
    expect(await code(s.get(env, "local", png))).toBe("too_large");
    cur = settings({ sourceMaxBytes: 3 * MB });
    expect((await s.get(env, "local", png)).kind).toBe("thumb");
  });

  test("resize 返回 null（WASM 不可用或压不下去）时：2MB 以内原样返回，更大 413", async () => {
    const dir = tmp("yuanshu-thumb-");
    const s = service(tmp("yuanshu-thumb-cache-"), async () => null);
    const small = write(dir, "small.png", Buffer.alloc(2 * 1024 * 1024, 1));
    expect(await s.get(env, "local", small)).toMatchObject({
      kind: "raw",
      mime: "image/png",
    });
    const big = write(dir, "big.png", Buffer.alloc(2 * 1024 * 1024 + 1, 1));
    expect(await code(s.get(env, "local", big))).toBe("too_large");
  });
});

describe("ThumbService：缓存", () => {
  test("命中缓存后不再读源文件、也不再调 resize；key 随 mtime 变", async () => {
    const dir = tmp("yuanshu-thumb-");
    const cache = tmp("yuanshu-thumb-cache-");
    const counted = counting(env);
    const { resize, calls } = fakeResize();
    const s = service(cache, resize);
    const png = write(dir, "a.png", Buffer.alloc(1024, 1));
    const first = await s.get(counted, "local", png);
    expect(first.kind).toBe("thumb");
    expect(counted.reads).toBe(1);
    const second = await s.get(counted, "local", png);
    expect(second.etag).toBe(first.etag);
    expect(counted.reads).toBe(1);
    expect(calls).toHaveLength(1);
    expect(readdirSync(cache)).toHaveLength(1);

    // mtime 变了就是另一条缓存
    utimesSync(png, new Date(), new Date(Date.now() + 5000));
    const third = await s.get(counted, "local", png);
    expect(third.etag).not.toBe(first.etag);
    expect(calls).toHaveLength(2);
  });

  test("同一个 key 的并发请求只解码一次", async () => {
    const dir = tmp("yuanshu-thumb-");
    const { resize, calls } = fakeResize();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = service(tmp("yuanshu-thumb-cache-"), async (bytes, mime) => {
      await gate;
      return resize(bytes, mime, { maxSide: 2000, quality: 85 });
    });
    const png = write(dir, "a.png", Buffer.alloc(1024, 1));
    const all = Promise.all([
      s.get(env, "local", png),
      s.get(env, "local", png),
      s.get(env, "local", png),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    (release as unknown as () => void)();
    const results = await all;
    expect(calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.etag)).size).toBe(1);
  });

  test("缓存超过 3000 条时删掉最旧的 500 条", async () => {
    const dir = tmp("yuanshu-thumb-");
    const cache = tmp("yuanshu-thumb-cache-");
    const old = new Date(Date.now() - 10 * 60_000);
    for (let i = 0; i < 3001; i++) {
      const p = path.join(cache, `${i.toString(16).padStart(40, "0")}.png`);
      writeFileSync(p, "x");
      utimesSync(p, old, old);
    }
    const { resize } = fakeResize();
    const s = service(cache, resize);
    const png = write(dir, "a.png", Buffer.alloc(1024, 1));
    await s.get(env, "local", png);
    // 写进去一条，超过 3000 后删掉最旧的 500 条
    expect(readdirSync(cache).length).toBe(3001 + 1 - 500);
  });
});

// ---- 真实 worker ----

/** 现造一张 PNG：每行 RGB，宽度 3 字节/像素，前面带 filter 字节。 */
function pngBytes(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (x * 7 + y) % 256;
      raw[row + 2 + x * 3] = (y * 5) % 256;
      raw[row + 3 + x * 3] = (x + y * 3) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 现造一张纯灰 JPEG（基线、单分量）：Huffman 表只各有一个长度 1 的码，
 * 于是 DC 差 0 与 AC 立即 EOB 全是 0 位，编码器不用实现。
 */
function jpegBytes(width: number, height: number): Buffer {
  const seg = (marker: number, payload: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xff00 | marker, 0);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
  };
  const table = (cls: number, symbol: number): Buffer => {
    const p = Buffer.alloc(18);
    p[0] = cls << 4;
    p[1] = 1;
    p[17] = symbol;
    return seg(0xc4, p);
  };
  const dqt = Buffer.alloc(65);
  for (let i = 0; i < 64; i++) dqt[i + 1] = 16;
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  const sos = Buffer.alloc(6);
  sos[0] = 1;
  sos[1] = 1;
  sos[4] = 63;
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bytes: number[] = [];
  let acc = 0;
  let n = 0;
  const put = (code: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      acc = (acc << 1) | ((code >> i) & 1);
      if (++n === 8) {
        bytes.push(acc);
        acc = 0;
        n = 0;
      }
    }
  };
  for (let i = 0; i < blocks; i++) {
    put(0, 1);
    put(0, 1);
  }
  if (n > 0) bytes.push(acc << (8 - n));
  const out: number[] = [];
  for (const b of bytes) {
    out.push(b);
    // 熵编码段里的 0xff 后面要垫 0x00，否则会被当成标记。
    if (b === 0xff) out.push(0);
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xdb, dqt),
    seg(0xc0, sof),
    table(0, 0),
    table(1, 0x00),
    seg(0xda, sos),
    Buffer.from(out),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** 缩略图可能是 PNG 或 JPEG：只从文件头读尺寸。 */
function sizeOf(buf: Buffer): { w: number; h: number } {
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1] as number;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3)
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new Error("认不出缩略图格式");
}

describe("workerResize：真跑光子 WASM", () => {
  test("把 2400×1600 的 PNG 与 JPEG 缩到 2000 以内，且主线程没被堵住", async () => {
    const dir = tmp("yuanshu-thumb-real-");
    const cache = tmp("yuanshu-thumb-cache-");
    const resize = workerResize();
    // 主线程的心跳：缩图期间最大间隔超过 200ms 就说明 WASM 跑在了主线程上。
    let last = Date.now();
    let maxGap = 0;
    const beat = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 20);
    try {
      const s = service(cache, resize);
      const png = write(dir, "big.png", pngBytes(2400, 1600));
      const jpg = write(dir, "big.jpg", jpegBytes(2400, 1600));
      const first = await s.get(env, "local", png);
      const second = await s.get(env, "local", jpg);
      expect(first.kind).toBe("thumb");
      expect(second.kind).toBe("thumb");
      expect(
        Math.max(...Object.values(sizeOf(first.data))),
      ).toBeLessThanOrEqual(2000);
      expect(
        Math.max(...Object.values(sizeOf(second.data))),
      ).toBeLessThanOrEqual(2000);
      expect(first.data.length).toBeLessThan(2 * 1024 * 1024);
    } finally {
      clearInterval(beat);
      resize.close();
    }
    console.log(`缩图期间主线程最大心跳间隔 ${maxGap}ms`);
    expect(maxGap).toBeLessThan(200);
  }, 120_000);

  test("设置里调小最长边：真 worker 也按它缩（不是写死的 2000）", async () => {
    const dir = tmp("yuanshu-thumb-real-");
    const resize = workerResize();
    try {
      const s = service(tmp("yuanshu-thumb-cache-"), resize, () =>
        settings({ maxSide: 600 }),
      );
      const png = write(dir, "wide.png", pngBytes(1600, 1000));
      const r = await s.get(env, "local", png);
      expect(r.kind).toBe("thumb");
      const buf = r.data;
      expect(sizeOf(buf).w).toBeLessThanOrEqual(600);
    } finally {
      resize.close();
    }
  }, 60_000);

  test("只有一个 worker 时，排队的任务依次做完", async () => {
    const resize = workerResize({ maxWorkers: 1 });
    try {
      const png = pngBytes(400, 300);
      const all = await Promise.all([
        resize(png, "image/png", { maxSide: 2000, quality: 85 }),
        resize(png, "image/png", { maxSide: 2000, quality: 85 }),
        resize(png, "image/png", { maxSide: 2000, quality: 85 }),
      ]);
      for (const r of all) {
        expect(r).not.toBeNull();
        expect((r as { data: Uint8Array }).data.length).toBeGreaterThan(0);
      }
    } finally {
      resize.close();
    }
  }, 60_000);

  test("close() 之后排队的任务得到 null，不会挂起", async () => {
    const resize = workerResize({ maxWorkers: 1 });
    const png = pngBytes(800, 600);
    const all = [
      resize(png, "image/png", { maxSide: 2000, quality: 85 }),
      resize(png, "image/png", { maxSide: 2000, quality: 85 }),
      resize(png, "image/png", { maxSide: 2000, quality: 85 }),
    ];
    resize.close();
    expect(await Promise.all(all)).toEqual([null, null, null]);
    expect(
      await resize(png, "image/png", { maxSide: 2000, quality: 85 }),
    ).toBeNull();
  }, 60_000);
});
