// 测试用的最小 zip 读取器：EOCD → 中央目录 → 本地头，按本仓库写出的形状解析（deflate-raw / store、
// 数据描述符、zip64 扩展）。zip 编码与接口两处测试共用，避免各写一份。
import { crc32, inflateRawSync } from "node:zlib";

export interface ReadEntry {
  name: string;
  dir: boolean;
  crc: number;
  size: number;
  compressed: number;
  /** 本地头的通用标志位（这里的写入器本地头与中央目录一致）。 */
  flags: number;
  /** DOS 时间（中央目录那一份）：年从 1980 起、月从 1 起。 */
  time: { year: number; month: number; day: number };
  /** 外部属性里的 Unix mode（低 16 位）。 */
  mode: number;
  data: Buffer;
}

export function readZip(buf: Buffer): { entries: ReadEntry[]; zip64: boolean } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("找不到 EOCD");
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const zip64 = count === 0xffff || cdOffset === 0xffffffff;
  if (zip64) {
    const locator = eocd - 20;
    if (buf.readUInt32LE(locator) !== 0x07064b50)
      throw new Error("找不到 zip64 定位器");
    const rec = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(rec) !== 0x06064b50)
      throw new Error("找不到 zip64 EOCD");
    count = Number(buf.readBigUInt64LE(rec + 32));
    cdOffset = Number(buf.readBigUInt64LE(rec + 48));
  }

  const entries: ReadEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录签名不符");
    const method = buf.readUInt16LE(p + 10);
    const dosDate = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    let compressed = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0xffff;
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // zip64 扩展里的值按顺序对应被写成满值的字段
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const take = () => {
          const v = Number(buf.readBigUInt64LE(q));
          q += 8;
          return v;
        };
        if (size === 0xffffffff) size = take();
        if (compressed === 0xffffffff) compressed = take();
        if (offset === 0xffffffff) offset = take();
      }
      e += 4 + len;
    }
    const lp = offset;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error("本地头签名不符");
    const flags = buf.readUInt16LE(lp + 6);
    const lNameLen = buf.readUInt16LE(lp + 26);
    const lExtraLen = buf.readUInt16LE(lp + 28);
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressed);
    const data =
      method === 0
        ? Buffer.from(raw)
        : method === 8
          ? inflateRawSync(raw)
          : (() => {
              throw new Error(`不认识的压缩方法：${method}`);
            })();
    if (name.endsWith("/") && (size !== 0 || compressed !== 0))
      throw new Error(`目录条目带了数据：${name}`);
    if (crc32(data) >>> 0 !== crc) throw new Error(`CRC 不符：${name}`);
    if (data.length !== size) throw new Error(`大小不符：${name}`);
    entries.push({
      name,
      dir: name.endsWith("/"),
      crc,
      size,
      compressed,
      flags,
      time: {
        year: 1980 + (dosDate >> 9),
        month: (dosDate >> 5) & 0xf,
        day: dosDate & 0x1f,
      },
      mode,
      data,
    });
    p += 46 + nameLen + extraLen;
  }
  return { entries, zip64 };
}
