// VAPID 密钥：生成一次、之后解密返回同一对；库里只有封存后的私钥字节。
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { openDatabase } from "../store/db.js";
import { PushStore } from "../store/push.js";
import { loadVapid } from "./vapid.js";

const setup = () => {
  const db = openDatabase(makeTmpDir("yuanshu-vapid-"));
  return { db, store: new PushStore(db), key: Buffer.alloc(32, 7) };
};

test("两次 loadVapid 返回同一对密钥，并落进 build 里", () => {
  const { db, store, key } = setup();
  const first = loadVapid(store, key);
  expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  expect(first.privateKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);

  const db2 = new PushStore(db);
  expect(loadVapid(db2, key)).toEqual(first);
  expect(store.vapid()?.publicKey).toBe(first.publicKey);
});

test("库里不留私钥明文：只有 iv + tag + 密文", () => {
  const { db, store, key } = setup();
  const { publicKey, privateKey } = loadVapid(store, key);
  const row = db
    .prepare("SELECT public_key, private_key FROM push_vapid WHERE id = 1")
    .get() as { public_key: string; private_key: Buffer };

  expect(row.public_key).toBe(publicKey);
  expect(row.private_key.includes(Buffer.from(privateKey, "utf8"))).toBe(false);
  expect(row.private_key.includes(Buffer.from(privateKey, "base64url"))).toBe(
    false,
  );
  expect(row.private_key.length).toBeGreaterThan(28);
});

test("主密钥不对时解不开，不会悄悄换一对新钥", () => {
  const { store, key } = setup();
  loadVapid(store, key);
  expect(() => loadVapid(store, Buffer.alloc(32, 9))).toThrow();
});
