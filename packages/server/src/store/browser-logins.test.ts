// 登录态的落库：加密、覆盖保留开关、排序与条数、清空、注入合并、换密钥读不出。
import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import type { StorageState } from "../browser/engine/types.js";
import { BrowserLoginStore } from "./browser-logins.js";
import { type Db, openDatabase } from "./db.js";

const setup = () => {
  const db: Db = openDatabase(makeTmpDir("yuanshu-logins-"));
  const key = randomBytes(32);
  return { db, key, store: new BrowserLoginStore(db, key) };
};

const ORIGIN = {
  origin: "https://github.com",
  localStorage: [{ name: "k", value: "v" }],
};

const state = (over: Partial<StorageState> = {}): StorageState => ({
  cookies: [
    {
      name: "sid",
      value: "SECRET_COOKIE_VALUE",
      domain: ".github.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [ORIGIN],
  ...over,
});

test("put 之后 get 逐字段相等；list 给条数与时间，不解密", () => {
  const { store } = setup();
  const saved = store.put(
    "github.com",
    state(),
    new Date("2026-02-01T00:00:00.000Z"),
  );
  expect(saved).toEqual({
    site: "github.com",
    enabled: true,
    savedAt: "2026-02-01T00:00:00.000Z",
    cookies: 1,
    origins: 1,
  });
  expect(store.get("github.com")).toEqual(state());
  expect(store.get("nope.com")).toBeNull();
  expect(store.list()).toEqual([saved]);
});

test("库里的 state 列不含明文", () => {
  const { db, store } = setup();
  store.put("github.com", state());
  const row = db
    .prepare("SELECT state FROM browser_logins WHERE site = ?")
    .get("github.com") as { state: Buffer };
  expect(row.state.includes(Buffer.from("SECRET_COOKIE_VALUE"))).toBe(false);
  expect(row.state.includes(Buffer.from("https://github.com"))).toBe(false);
});

test("重复 put 覆盖状态但保留 enabled", () => {
  const { store } = setup();
  store.put("github.com", state());
  expect(store.setEnabled("github.com", false)).toBe(true);
  const again = store.put(
    "github.com",
    { cookies: [], origins: [ORIGIN] },
    new Date("2026-02-02T00:00:00.000Z"),
  );
  expect(again.enabled).toBe(false);
  expect(again).toMatchObject({ cookies: 0, origins: 1 });
  expect(store.get("github.com")).toEqual({ cookies: [], origins: [ORIGIN] });
});

test("list 按 site 升序", () => {
  const { store } = setup();
  store.put("b.test", state());
  store.put("a.test", state());
  store.put("c.test", state());
  expect(store.list().map((l) => l.site)).toEqual([
    "a.test",
    "b.test",
    "c.test",
  ]);
});

test("setEnabled / remove：站点不存在返回 false", () => {
  const { store } = setup();
  expect(store.setEnabled("nope.com", false)).toBe(false);
  expect(store.remove("nope.com")).toBe(false);

  store.put("a.test", state());
  expect(store.setEnabled("a.test", false)).toBe(true);
  expect(store.list()[0]?.enabled).toBe(false);
  expect(store.remove("a.test")).toBe(true);
  expect(store.list()).toEqual([]);
});

test("clear 返回删了几个站点", () => {
  const { store } = setup();
  expect(store.clear()).toBe(0);
  store.put("a.test", state());
  store.put("b.test", state());
  expect(store.clear()).toBe(2);
  expect(store.list()).toEqual([]);
});

test("injected：只合并 enabled 的站点；全关与空库返回 null", () => {
  const { store } = setup();
  expect(store.injected()).toBeNull();

  store.put("a.test", state());
  store.put("b.test", state({ cookies: [], origins: [] }));
  store.setEnabled("a.test", false);
  const injected = store.injected();
  expect(injected?.cookies).toEqual([]);
  expect(injected?.origins).toEqual([]);

  store.setEnabled("b.test", false);
  expect(store.injected()).toBeNull();
});

test("换一把密钥读不出", () => {
  const { db, store } = setup();
  store.put("a.test", state());
  const other = new BrowserLoginStore(db, randomBytes(32));
  expect(() => other.get("a.test")).toThrow();
  // 注入读不出的站点就跳过，不抛：换过主密钥不能让所有工作区都打不开浏览器
  expect(other.injected()).toBeNull();
  // 元信息不解密，换密钥也照样列得出来
  expect(other.list().map((l) => l.site)).toEqual(["a.test"]);
});

test("injected：一个站点的密文坏了只跳过它，别的站点照常注入", () => {
  const { db, store } = setup();
  store.put("good.test", state());
  store.put("bad.test", state());
  // 篡改 bad.test 的密文（GCM 校验会失败）
  db.prepare("UPDATE browser_logins SET state = ? WHERE site = ?").run(
    Buffer.from("not-a-valid-sealed-blob-at-all-xxxxxxxxxxxxxxxx"),
    "bad.test",
  );
  const injected = store.injected();
  expect(injected).not.toBeNull();
  expect(injected?.cookies.length).toBe(state().cookies.length);
});
