import { expect, test } from "vitest";
import { pngSize } from "./image-size.js";

/** 手写一个 PNG 头：签名 + IHDR 块的宽高，后面的内容无关。 */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR 数据长度
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test("真 PNG 头：读出 IHDR 里的宽高", () => {
  expect(pngSize(pngHeader(1280, 800))).toEqual({ width: 1280, height: 800 });
  expect(pngSize(pngHeader(1, 1))).toEqual({ width: 1, height: 1 });
});

test("不是 PNG：签名不对或第一个块不是 IHDR 都返回 null", () => {
  expect(pngSize(Buffer.from("jpeg-bytes"))).toBeNull();
  const wrongChunk = pngHeader(10, 20);
  wrongChunk.write("IDAT", 12, "ascii");
  expect(pngSize(wrongChunk)).toBeNull();
});

test("太短：不足一个头也返回 null", () => {
  expect(pngSize(Buffer.alloc(0))).toBeNull();
  expect(pngSize(pngHeader(10, 20).subarray(0, 20))).toBeNull();
});
