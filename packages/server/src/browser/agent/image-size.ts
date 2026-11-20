// 从图片字节里读尺寸：元素截图是 PNG，尺寸只用来在结果文字里声明原图大小。
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 读 PNG 头里的宽高（IHDR）；不是 PNG 返回 null。 */
export function pngSize(
  bytes: Buffer,
): { width: number; height: number } | null {
  // 签名 8 字节 + 块长度 4 + 块类型 4 + 宽 4 + 高 4
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++)
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  // 第一个块必须是 IHDR，否则不是正常的 PNG 头
  if (bytes.readUInt32BE(12) !== 0x49484452) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
