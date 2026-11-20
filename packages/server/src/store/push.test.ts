// 推送订阅表：偏好跟着设备走、重订阅不丢偏好、撤销设备级联删订阅、VAPID 只写一次。
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { type Db, openDatabase } from "./db.js";
import { DeviceStore } from "./devices.js";
import { PushStore } from "./push.js";

const setup = (clock = { t: Date.parse("2026-01-01T00:00:00Z") }) => {
  const db: Db = openDatabase(makeTmpDir("yuanshu-push-"));
  const devices = new DeviceStore(db, () => clock.t);
  const store = new PushStore(db, () => clock.t);
  return { db, devices, store, clock };
};

const SUB = { endpoint: "https://push.example/1", p256dh: "p1", auth: "a1" };

const newDevice = (devices: DeviceStore, name = "手机") =>
  devices.create(name).device.id;

test("upsert：新订阅用默认偏好，重订阅只换地址与密钥、偏好保留", () => {
  const { devices, store } = setup();
  const id = newDevice(devices);

  store.upsert(id, SUB);
  expect(store.get(id)).toEqual({
    deviceId: id,
    ...SUB,
    prefs: {
      blocked: true,
      error: true,
      done: false,
      policy: "unwatched",
      delaySec: 30,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  store.setPrefs(id, { done: true, policy: "delay", delaySec: 5 });
  store.upsert(id, {
    endpoint: "https://push.example/2",
    p256dh: "p2",
    auth: "a2",
  });
  expect(store.get(id)).toEqual({
    deviceId: id,
    endpoint: "https://push.example/2",
    p256dh: "p2",
    auth: "a2",
    prefs: {
      blocked: true,
      error: true,
      done: true,
      policy: "delay",
      delaySec: 5,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

test("setPrefs 部分更新：没给订阅返回 null，只改出现的字段", () => {
  const { devices, store } = setup();
  const id = newDevice(devices);
  expect(store.setPrefs(id, { done: true })).toBeNull();

  store.upsert(id, SUB);
  expect(store.setPrefs(id, { blocked: false, delaySec: 600 })).toEqual({
    blocked: false,
    error: true,
    done: false,
    policy: "unwatched",
    delaySec: 600,
  });
  expect(store.setPrefs(id, { policy: "always" })?.policy).toBe("always");
  expect(store.setPrefs(id, {})?.blocked).toBe(false);
});

test("list 按创建顺序；remove 之后 get 为 null，重复删返回 false", () => {
  const { devices, store, clock } = setup();
  const a = newDevice(devices, "先");
  const b = newDevice(devices, "后");
  store.upsert(a, SUB);
  clock.t += 1000;
  store.upsert(b, SUB);
  expect(store.list().map((r) => r.deviceId)).toEqual([a, b]);
  expect(store.get(b)?.createdAt).toBe("2026-01-01T00:00:01.000Z");

  expect(store.remove(a)).toBe(true);
  expect(store.remove(a)).toBe(false);
  expect(store.get(a)).toBeNull();
});

test("撤销设备即删订阅：靠外键级联，不需要别处再删一遍", () => {
  const { db, devices, store } = setup();
  const id = newDevice(devices);
  store.upsert(id, SUB);
  expect(store.get(id)).not.toBeNull();

  devices.remove(id);
  expect(store.get(id)).toBeNull();
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM push_subscriptions WHERE device_id = ?",
      )
      .get(id),
  ).toEqual({ n: 0 });
});

test("saveVapid 只在表为空时写：已有密钥时忽略（不轮换）", () => {
  const { store } = setup();
  expect(store.vapid()).toBeNull();
  store.saveVapid("pub-1", Buffer.from("sealed-1"));
  expect(store.vapid()).toEqual({
    publicKey: "pub-1",
    privateKey: Buffer.from("sealed-1"),
  });
  store.saveVapid("pub-2", Buffer.from("sealed-2"));
  expect(store.vapid()).toEqual({
    publicKey: "pub-1",
    privateKey: Buffer.from("sealed-1"),
  });
});
