import { randomBytes } from "node:crypto";

// UUIDv7：48 位毫秒时间戳加随机位。客户端当不透明字符串用。
export function uuidv7(): string {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x70, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
