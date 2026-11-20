import { createHash } from "node:crypto";
import ssh2 from "ssh2";

// ssh2 是 CommonJS：Node 的 ESM 加载器认不出 `utils` 这个命名导出（vitest 的转换宽容，测试里发现不了），
// 所以取默认导出再解构；类型上 @types/ssh2 的 default 与命名导出同形。
const { utils } = ssh2;

// 库内记录的主机密钥指纹是 `算法:sha256 hex`（见 hostKeyFingerprint）。
// 对外一律用 OpenSSH 的 `SHA256:<base64 无填充>`，和 `ssh-keygen -l`、known_hosts 工具能直接比对。

/** 公钥线格式的 OpenSSH 指纹。 */
export const sha256Fingerprint = (blob: Buffer): string =>
  `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

/** 库内格式 → 对外格式；格式不认识时原样返回。 */
export function displayFingerprint(stored: string): {
  fingerprint: string;
  keyType: string;
} {
  const at = stored.indexOf(":");
  const hex = stored.slice(at + 1);
  if (at <= 0 || !/^[0-9a-f]{64}$/.test(hex))
    return { fingerprint: stored, keyType: "" };
  return {
    fingerprint: `SHA256:${Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "")}`,
    keyType: stored.slice(0, at),
  };
}

/** 私钥文本 → 公钥指纹与类型；解析不了（带口令、格式不认识）返回 null。 */
export function keyFingerprint(
  privateKey: string,
): { fingerprint: string; keyType: string } | null {
  const parsed = utils.parseKey(privateKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) return null;
  return {
    fingerprint: sha256Fingerprint(key.getPublicSSH()),
    keyType: key.type,
  };
}
