// 流式 zip 写入器：只认条目描述，不认识环境原语；deflate-raw 边走边出，内存里只留中央目录记录。
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";

export type ZipEntry =
  | { name: string; dir: true; mtimeMs: number; mode: number }
  | {
      name: string;
      dir?: false;
      size: number;
      mtimeMs: number;
      mode: number;
      open(): Promise<Readable>;
    };

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const ZIP64_EXTRA_ID = 0x0001;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const VERSION = 20;
const VERSION_ZIP64 = 45;
/** version made by 的 host：3 = Unix，外部属性才有意义。 */
const HOST_UNIX = 3;
/** 位 3 = 大小与 CRC 在数据描述符里；位 11 = 文件名是 UTF-8。 */
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const DEFAULT_ZIP64_ABOVE = 0xf0000000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const EMPTY = Buffer.alloc(0);

interface Central {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  mode: number;
  dir: boolean;
  /** 该条目的大小用 zip64 写法（本地头、数据描述符、中央目录一致）。 */
  zip64: boolean;
}

// 本地时区的 DOS 时间；早于 1980 夹到 1980-01-01，超出 DOS 年份上限夹到 2107。
function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  const year = d.getFullYear();
  if (!(year >= 1980)) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((Math.min(year, 2107) - 1980) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
  };
}

// zip64 扩展：值按「未压缩大小、压缩大小、本地头偏移」排序，只放需要的那几个。
function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + values.length * 8);
  b.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  b.writeUInt16LE(values.length * 8, 2);
  for (let i = 0; i < values.length; i++)
    b.writeBigUInt64LE(BigInt(values[i] as number), 4 + i * 8);
  return b;
}

function localHeader(
  name: Buffer,
  o: { dir: boolean; zip64: boolean; time: number; date: number },
): Buffer {
  const extra = o.zip64 ? zip64Extra([0, 0]) : EMPTY;
  const b = Buffer.alloc(30);
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(o.zip64 ? VERSION_ZIP64 : VERSION, 4);
  b.writeUInt16LE(o.dir ? FLAG_UTF8 : FLAG_UTF8 | FLAG_DESCRIPTOR, 6);
  b.writeUInt16LE(o.dir ? METHOD_STORE : METHOD_DEFLATE, 8);
  b.writeUInt16LE(o.time, 10);
  b.writeUInt16LE(o.date, 12);
  // CRC 与大小在数据描述符里；zip64 条目把本地头的大小字段写成满值并补扩展字段
  b.writeUInt32LE(o.zip64 ? U32_MAX : 0, 18);
  b.writeUInt32LE(o.zip64 ? U32_MAX : 0, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(extra.length, 28);
  return Buffer.concat([b, name, extra]);
}

function descriptor(
  crc: number,
  compressed: number,
  size: number,
  zip64: boolean,
): Buffer {
  const b = Buffer.alloc(zip64 ? 24 : 16);
  b.writeUInt32LE(SIG_DESCRIPTOR, 0);
  b.writeUInt32LE(crc >>> 0, 4);
  if (zip64) {
    b.writeBigUInt64LE(BigInt(compressed), 8);
    b.writeBigUInt64LE(BigInt(size), 16);
  } else {
    b.writeUInt32LE(compressed, 8);
    b.writeUInt32LE(size, 12);
  }
  return b;
}

function centralRecord(r: Central): Buffer {
  const values: number[] = [];
  if (r.zip64) values.push(r.size, r.compressed);
  if (r.offset > U32_MAX) values.push(r.offset);
  const extra = values.length > 0 ? zip64Extra(values) : EMPTY;
  const version = values.length > 0 ? VERSION_ZIP64 : VERSION;
  const b = Buffer.alloc(46);
  b.writeUInt32LE(SIG_CENTRAL, 0);
  b.writeUInt16LE((HOST_UNIX << 8) | version, 4);
  b.writeUInt16LE(version, 6);
  b.writeUInt16LE(r.flags, 8);
  b.writeUInt16LE(r.method, 10);
  b.writeUInt16LE(r.time, 12);
  b.writeUInt16LE(r.date, 14);
  b.writeUInt32LE(r.crc >>> 0, 16);
  b.writeUInt32LE(r.zip64 ? U32_MAX : r.compressed, 20);
  b.writeUInt32LE(r.zip64 ? U32_MAX : r.size, 24);
  b.writeUInt16LE(r.name.length, 28);
  b.writeUInt16LE(extra.length, 30);
  // 外部属性高 16 位是 Unix mode（带文件类型位，部分解压器据此认目录 / 普通文件），低位的 0x10 是 DOS 的目录标记
  const type = r.dir ? S_IFDIR : S_IFREG;
  b.writeUInt32LE(
    (((type | (r.mode & 0o7777)) << 16) | (r.dir ? 0x10 : 0)) >>> 0,
    38,
  );
  b.writeUInt32LE(r.offset > U32_MAX ? U32_MAX : r.offset, 42);
  return Buffer.concat([b, r.name, extra]);
}

function zip64End(
  count: number,
  cdSize: number,
  cdOffset: number,
  at: number,
): Buffer[] {
  const b = Buffer.alloc(56);
  b.writeUInt32LE(SIG_ZIP64_EOCD, 0);
  b.writeBigUInt64LE(44n, 4);
  b.writeUInt16LE((HOST_UNIX << 8) | VERSION_ZIP64, 12);
  b.writeUInt16LE(VERSION_ZIP64, 14);
  b.writeBigUInt64LE(BigInt(count), 24);
  b.writeBigUInt64LE(BigInt(count), 32);
  b.writeBigUInt64LE(BigInt(cdSize), 40);
  b.writeBigUInt64LE(BigInt(cdOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
  locator.writeBigUInt64LE(BigInt(at), 8);
  locator.writeUInt32LE(1, 16);
  return [b, locator];
}

function eocd(
  count: number,
  cdSize: number,
  cdOffset: number,
  zip64: boolean,
): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(SIG_EOCD, 0);
  b.writeUInt16LE(zip64 ? U16_MAX : count, 8);
  b.writeUInt16LE(zip64 ? U16_MAX : count, 10);
  b.writeUInt32LE(zip64 ? U32_MAX : cdSize, 12);
  b.writeUInt32LE(zip64 ? U32_MAX : cdOffset, 16);
  return b;
}

const asBuffer = (c: unknown): Buffer =>
  Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);

/** 逐个消费 entries（可以是异步生成器，边走目录边出条目），产出 zip 字节流 */
export function createZip(
  entries: AsyncIterable<ZipEntry>,
  opts: { zip64Above?: number } = {},
): Readable {
  const zip64Above = opts.zip64Above ?? DEFAULT_ZIP64_ABOVE;
  // 正在读的文件源；消费方 destroy 时先掐断它，否则生成器要等下一个 chunk 才轮到 return
  let abort: (() => void) | null = null;
  let stopped = false;

  async function* build(): AsyncGenerator<Buffer> {
    let offset = 0;
    const central: Central[] = [];
    let count = 0;
    const emit = (b: Buffer): Buffer => {
      offset += b.length;
      return b;
    };

    for await (const entry of entries) {
      const raw = entry.name.replace(/\\/g, "/");
      const isDir = entry.dir === true;
      const name = Buffer.from(
        isDir && !raw.endsWith("/") ? `${raw}/` : raw,
        "utf8",
      );
      const { time, date } = dosTime(entry.mtimeMs);
      const mode = entry.mode & 0xffff;
      const start = offset;
      const zip64 = !isDir && entry.size >= zip64Above;
      yield emit(localHeader(name, { dir: isDir, zip64, time, date }));

      if (isDir) {
        central.push({
          name,
          crc: 0,
          compressed: 0,
          size: 0,
          offset: start,
          flags: FLAG_UTF8,
          method: METHOD_STORE,
          time,
          date,
          mode,
          dir: true,
          zip64: false,
        });
        count++;
        continue;
      }

      // 边读边算 CRC 与实际大小；文件在打包过程中变了就以实际读到的为准。
      let crc = 0;
      let size = 0;
      let compressed = 0;
      const deflate = createDeflateRaw();
      const src = await entry.open();
      // 打开文件本身就可能是慢活（ssh）：这时已经被 destroy 就别再读了
      if (stopped) {
        src.destroy();
        deflate.destroy();
        return;
      }
      const done = pipeline(
        src,
        async function* (chunks: AsyncIterable<unknown>) {
          for await (const c of chunks) {
            const b = asBuffer(c);
            crc = crc32(b, crc);
            size += b.length;
            yield b;
          }
        },
        deflate,
      );
      abort = () => {
        src.destroy();
        deflate.destroy();
      };
      try {
        for await (const chunk of deflate) {
          const b = asBuffer(chunk);
          compressed += b.length;
          yield emit(b);
        }
        await done;
      } finally {
        // 出错或消费方 destroy：立刻断开源，别在后台继续读盘
        abort();
        abort = null;
        done.catch(() => {});
      }
      yield emit(descriptor(crc, compressed, size, zip64));

      central.push({
        name,
        crc,
        compressed,
        size,
        offset: start,
        flags: FLAG_UTF8 | FLAG_DESCRIPTOR,
        method: METHOD_DEFLATE,
        time,
        date,
        mode,
        dir: false,
        zip64,
      });
      count++;
    }

    const cdOffset = offset;
    for (const rec of central) yield emit(centralRecord(rec));
    const cdSize = offset - cdOffset;
    const big = count > U16_MAX || cdSize > U32_MAX || cdOffset > U32_MAX;
    if (big) {
      for (const b of zip64End(count, cdSize, cdOffset, offset)) yield emit(b);
    }
    yield emit(eocd(count, cdSize, cdOffset, big));
  }

  const stream = Readable.from(build(), { objectMode: false });
  // Readable.from 要等挂起的 next() 落地才 return；destroy 时先把源流掐掉，生成器随即收尾。
  const destroy = stream.destroy.bind(stream);
  stream.destroy = ((err?: Error) => {
    stopped = true;
    abort?.();
    return destroy(err);
  }) as typeof stream.destroy;
  return stream;
}
