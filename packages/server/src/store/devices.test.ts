// 设备表：只存令牌哈希、最近使用按分钟节流、撤销后立刻查不到。
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { type Db, openDatabase } from "./db.js";
import { DeviceStore } from "./devices.js";

const setup = (clock = { t: Date.now() }) => {
  const db: Db = openDatabase(makeTmpDir("yuanshu-devices-"));
  const store = new DeviceStore(db, () => clock.t);
  return { db, store, clock };
};

const hashOf = (db: Db, id: string) =>
  (
    db.prepare("SELECT token_hash FROM devices WHERE id = ?").get(id) as {
      token_hash: string;
    }
  ).token_hash;

test("库里只有哈希：查得到的是 SHA-256 摘要，不含明文令牌", () => {
  const { db, store } = setup();
  const { device, token } = store.create("我的手机");

  const hash = hashOf(db, device.id);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hash).not.toContain(token);
  expect(
    JSON.stringify(db.prepare("SELECT * FROM devices").all()),
  ).not.toContain(token);
  expect(device).toEqual({
    id: expect.any(String),
    name: "我的手机",
    createdAt: expect.any(String),
    lastUsedAt: null,
  });
});

test("verify：命中返回设备视图，未命中返回 null", () => {
  const { store } = setup();
  const { device, token } = store.create("手机");
  expect(store.verify(token)).toEqual({
    ...device,
    lastUsedAt: device.createdAt,
  });
  expect(store.verify("x".repeat(43))).toBeNull();
});

test("最近使用：同一设备 60 秒内只写一次库，之后才更新", () => {
  const { db, store, clock } = setup({ t: 1_000_000_000_000 });
  const { device, token } = store.create("手机");
  const read = () =>
    (
      db
        .prepare("SELECT last_used_at FROM devices WHERE id = ?")
        .get(device.id) as { last_used_at: string }
    ).last_used_at;

  expect(store.verify(token)?.lastUsedAt).toBe(new Date(clock.t).toISOString());
  expect(read()).toBe(new Date(clock.t).toISOString());

  clock.t += 30_000;
  expect(store.verify(token)?.lastUsedAt).toBe(
    new Date(clock.t - 30_000).toISOString(),
  );
  expect(read()).toBe(new Date(clock.t - 30_000).toISOString());

  clock.t += 30_000;
  store.verify(token);
  expect(read()).toBe(new Date(clock.t).toISOString());
});

test("list 按创建时间排序；remove 之后 get 与 verify 都拿不到", () => {
  const { store, clock } = setup({ t: 1_000_000_000_000 });
  const a = store.create("先");
  clock.t += 1_000;
  const b = store.create("后");
  expect(store.list().map((d) => d.id)).toEqual([a.device.id, b.device.id]);
  expect(store.get(b.device.id)).toEqual(b.device);

  expect(store.remove(a.device.id)).toBe(true);
  expect(store.remove(a.device.id)).toBe(false);
  expect(store.get(a.device.id)).toBeNull();
  expect(store.verify(a.token)).toBeNull();
  expect(store.verify(b.token)).not.toBeNull();
});
