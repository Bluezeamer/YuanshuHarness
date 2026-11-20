import { generateVAPIDKeys } from "web-push";
import type { PushStore } from "../store/push.js";
import { seal, unseal } from "../store/seal.js";

// VAPID 密钥生成一次就固定：浏览器按源认公钥，换钥要靠用户手动清权限。
// 私钥与密码库同一套 AES-256-GCM 封存，库里不出现明文。
export function loadVapid(
  store: PushStore,
  masterKey: Buffer,
): { publicKey: string; privateKey: string } {
  const saved = store.vapid();
  if (saved)
    return {
      publicKey: saved.publicKey,
      privateKey: unseal(masterKey, saved.privateKey),
    };
  const keys = generateVAPIDKeys();
  store.saveVapid(keys.publicKey, seal(masterKey, keys.privateKey));
  return keys;
}
