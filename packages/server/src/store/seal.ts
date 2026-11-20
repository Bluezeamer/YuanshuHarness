import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// 与密码库同一套加密：AES-256-GCM，存 iv(12) + authTag(16) + 密文。
// 抽出来给别的敏感落库（浏览器登录态）共用，免得各自实现一遍。

export function seal(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/** 密钥不对或密文被改过都会抛：校验失败不会返回坏数据。 */
export function unseal(key: Buffer, blob: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString(
    "utf8",
  );
}
