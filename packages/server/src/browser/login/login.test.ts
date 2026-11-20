// 提示保存 / 保存 / 管理 / 注入：真库真加密，浏览器状态用伪造的 stateOf。
import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../../test/support/tmp-registry.js";
import { BrowserLoginStore } from "../../store/browser-logins.js";
import { type Db, openDatabase } from "../../store/db.js";
import type { StorageState } from "../engine/types.js";
import { LoginError, LoginService } from "./login.js";

const SECRET = "COOKIE_VALUE_MUST_NOT_LEAK";

const google: StorageState = {
  cookies: [
    {
      name: "sid",
      value: SECRET,
      domain: ".google.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [
    { origin: "https://google.com", localStorage: [{ name: "k", value: "v" }] },
  ],
};

const otherSite: StorageState["cookies"] = [
  {
    name: "sid",
    value: "OTHER",
    domain: ".example.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  },
];

function setup(initial: StorageState | null = null) {
  const db: Db = openDatabase(makeTmpDir("yuanshu-login-"));
  const store = new BrowserLoginStore(db, randomBytes(32));
  const states = new Map<string, StorageState | null>();
  /** 此刻「开着上下文」的工作区。 */
  const live = new Set<string>(["w1"]);
  /** seed 的调用与收到的状态。 */
  const seeds: Array<{ key: string; state: StorageState }> = [];
  /** 按 key 让 seed 抛错。 */
  const seedError = new Set<string>();
  const audits: Array<{ summary: string; detail: Record<string, unknown> }> =
    [];
  const service = new LoginService({
    store,
    stateOf: async (key) => states.get(key) ?? null,
    liveKeys: () => [...live],
    seed: async (key, state) => {
      if (seedError.has(key)) throw new Error(`seed 失败：${key}`);
      seeds.push({ key, state });
    },
    audit: (e) => void audits.push(e),
  });
  states.set("w1", initial);
  return { db, store, states, live, seeds, seedError, audits, service };
}

test("offer：不是站点的页面（localhost）不给提示", async () => {
  const s = setup(google);
  expect(await s.service.offer("w1", "http://localhost:3000/")).toEqual({
    site: null,
    saved: false,
    offer: false,
  });
});

test("offer：上下文不在 → offer false，saved 如实给", async () => {
  const s = setup(google);
  s.states.delete("w1");
  expect(await s.service.offer("w1", "https://google.com/")).toEqual({
    site: "google.com",
    saved: false,
    offer: false,
  });
  // 存过之后 saved 为 true
  s.store.put("google.com", google);
  expect(await s.service.offer("w1", "https://google.com/")).toEqual({
    site: "google.com",
    saved: true,
    offer: false,
  });
});

test("offer：站点在当前上下文里没有内容 → offer false", async () => {
  const s = setup({ cookies: otherSite, origins: [] });
  expect(await s.service.offer("w1", "https://google.com/")).toEqual({
    site: "google.com",
    saved: false,
    offer: false,
  });
});

test("offer：没存过且确有内容 → offer true", async () => {
  const s = setup(google);
  expect(await s.service.offer("w1", "https://accounts.google.com/")).toEqual({
    site: "google.com",
    saved: false,
    offer: true,
  });
});

test("offer：已存且相同 → offer false", async () => {
  const s = setup(google);
  s.store.put("google.com", google);
  expect(await s.service.offer("w1", "https://google.com/")).toEqual({
    site: "google.com",
    saved: true,
    offer: false,
  });
});

test("offer：已存但 cookie 的值变了 → offer true", async () => {
  const s = setup(google);
  s.store.put("google.com", google);
  s.states.set("w1", {
    ...google,
    cookies: [
      {
        ...(google.cookies[0] as StorageState["cookies"][number]),
        value: "new",
      },
    ],
  });
  const r = await s.service.offer("w1", "https://google.com/");
  expect(r).toMatchObject({ site: "google.com", saved: true, offer: true });
});

test("save：不是站点 → no_site", async () => {
  const s = setup(google);
  const e = await s.service
    .save("w1", "http://127.0.0.1:8080/")
    .catch((x) => x);
  expect(e).toBeInstanceOf(LoginError);
  expect((e as LoginError).code).toBe("no_site");
  expect((e as LoginError).message).toContain("本机地址");
});

test("save：上下文不在 → no_state", async () => {
  const s = setup(google);
  s.states.delete("w1");
  const e = await s.service.save("w1", "https://google.com/").catch((x) => x);
  expect((e as LoginError).code).toBe("no_state");
  expect((e as LoginError).message).toContain("没在运行");
});

test("save：这个站点没有内容 → no_state", async () => {
  const s = setup({ cookies: otherSite, origins: [] });
  const e = await s.service.save("w1", "https://google.com/").catch((x) => x);
  expect((e as LoginError).code).toBe("no_state");
  expect((e as LoginError).message).toContain("先登录再保存");
});

test("save：只存这个站点的条目，别的站点没被带进来", async () => {
  const s = setup({
    cookies: [...google.cookies, ...otherSite],
    origins: google.origins,
  });
  const meta = await s.service.save("w1", "https://accounts.google.com/");
  expect(meta).toMatchObject({
    site: "google.com",
    cookies: 1,
    origins: 1,
    enabled: true,
  });
  const stored = s.store.get("google.com");
  expect(stored?.cookies.map((c) => c.domain)).toEqual([".google.com"]);
  expect(stored?.origins.map((o) => o.origin)).toEqual(["https://google.com"]);
});

test("save：成功后 offer 变 false；重复 save 保留 enabled", async () => {
  const s = setup(google);
  await s.service.save("w1", "https://google.com/");
  expect((await s.service.offer("w1", "https://google.com/")).offer).toBe(
    false,
  );

  s.service.setEnabled("google.com", false);
  await s.service.save("w1", "https://google.com/");
  expect(s.store.list()[0]?.enabled).toBe(false);
});

test("管理：setEnabled / remove / clear 委托给库，审计里有站点但没有状态内容", async () => {
  const s = setup(google);
  await s.service.save("w1", "https://google.com/");
  expect(s.service.list().map((l) => l.site)).toEqual(["google.com"]);
  const disabling = s.service.setEnabled("google.com", false);
  // 启用时要把状态补进已开着的上下文，所以是异步的。
  expect(disabling).toBeInstanceOf(Promise);
  expect(await disabling).toBe(true);
  expect(await s.service.setEnabled("nope.com", false)).toBe(false);
  expect(s.service.remove("nope.com")).toBe(false);
  expect(s.service.injected()).toBeNull();
  expect(await s.service.setEnabled("google.com", true)).toBe(true);
  expect(s.service.injected()?.cookies).toHaveLength(1);
  expect(s.service.remove("google.com")).toBe(true);

  s.store.put("a.test", google);
  s.store.put("b.test", google);
  expect(s.service.clear()).toBe(2);

  expect(s.audits.map((a) => a.summary)).toEqual([
    "browser_login saved: google.com",
    "browser_login disabled: google.com",
    "browser_login enabled: google.com",
    "browser_login removed: google.com",
    "browser_login cleared: 2 sites",
  ]);
  expect(s.audits.map((a) => a.detail)).toEqual([
    { op: "browser_login", target: "google.com", result: "saved" },
    { op: "browser_login", target: "google.com", result: "disabled" },
    { op: "browser_login", target: "google.com", result: "enabled" },
    { op: "browser_login", target: "google.com", result: "removed" },
    { op: "browser_login", target: "all", result: "cleared" },
  ]);
  // 审计里搜不到任何状态内容
  const dumped = JSON.stringify(s.audits);
  expect(dumped).not.toContain(SECRET);
  expect(dumped).not.toContain("https://google.com");
});

test("injected：只含 enabled 的站点，全关返回 null", async () => {
  const s = setup(google);
  s.store.put("google.com", google);
  s.store.put("example.com", { cookies: otherSite, origins: [] });
  s.store.setEnabled("example.com", false);
  const injected = s.service.injected();
  expect(injected?.cookies.map((c) => c.domain)).toEqual([".google.com"]);

  s.store.setEnabled("google.com", false);
  expect(s.service.injected()).toBeNull();
});

// —— 保存 / 启用时补进已开着的上下文 ——

/** 只有别的站点的东西、没有任何 google 条目的状态。 */
const otherSiteState = (): StorageState => ({
  cookies: otherSite,
  origins: [{ origin: "https://example.com", localStorage: [] }],
});

test("save：B 里保存，已开着的 A 被 seed，w2 自己已有不动", async () => {
  const s = setup(otherSiteState());
  s.live.add("w2");
  s.states.set("w2", google);
  await s.service.save("w2", "https://google.com/");
  expect(s.seeds).toEqual([{ key: "w1", state: google }]);
});

test("save：已有该站点 cookie 的上下文不动，只有 localStorage 也算已有", async () => {
  const s = setup({
    cookies: google.cookies,
    origins: [{ origin: "https://example.com", localStorage: [] }],
  });
  s.live.add("w2");
  s.states.set("w2", google);
  s.live.add("w3");
  s.states.set("w3", {
    cookies: [],
    origins: [
      {
        origin: "https://mail.google.com",
        localStorage: [{ name: "另一个账号", value: "x" }],
      },
    ],
  });
  await s.service.save("w2", "https://google.com/");
  expect(s.seeds).toEqual([]);
});

test("save：站点被用户关掉启用时保存，不 seed", async () => {
  const s = setup(otherSiteState());
  s.live.add("w2");
  s.states.set("w2", google);
  s.store.put("google.com", google);
  s.store.setEnabled("google.com", false);
  await s.service.save("w2", "https://google.com/");
  expect(s.seeds).toEqual([]);
});

test("setEnabled(site, true)：seed；改成 false 不 seed", async () => {
  const s = setup(otherSiteState());
  s.store.put("google.com", google);
  s.store.setEnabled("google.com", false);
  expect(await s.service.setEnabled("google.com", false)).toBe(true);
  expect(s.seeds).toEqual([]);
  expect(await s.service.setEnabled("google.com", true)).toBe(true);
  expect(s.seeds).toEqual([{ key: "w1", state: google }]);
});

test("stateOf 返回 null（上下文崩了）的 key 跳过", async () => {
  const s = setup(otherSiteState());
  s.live.add("w2"); // w2 在 liveKeys 里，但状态取不到
  s.states.set("w3", google);
  s.live.add("w3");
  await s.service.save("w3", "https://google.com/");
  expect(s.seeds).toEqual([{ key: "w1", state: google }]);
});

test("一个 key 的 seed 抛错：别的 key 照旧 seed，save 照常返回", async () => {
  const s = setup(otherSiteState());
  s.live.add("w2");
  s.states.set("w2", google);
  s.live.add("w3");
  s.states.set("w3", otherSiteState());
  s.seedError.add("w1");
  const meta = await s.service.save("w2", "https://google.com/");
  expect(meta.site).toBe("google.com");
  expect(s.seeds.map((x) => x.key)).toEqual(["w3"]);
  // setEnabled 同样不受影响
  s.seeds.length = 0;
  expect(await s.service.setEnabled("google.com", true)).toBe(true);
  expect(s.seeds.map((x) => x.key)).toEqual(["w3"]);
});

test("seed 只送这个站点的条目，不夹带别的站点", async () => {
  const s = setup(otherSiteState());
  // 库里这一份混着别的站点的条目（例如旧数据）：补进上下文前要按站点挑出来。
  s.store.put("google.com", {
    cookies: [...google.cookies, ...otherSite],
    origins: [
      ...google.origins,
      {
        origin: "https://example.com",
        localStorage: [{ name: "k", value: "v" }],
      },
    ],
  });
  s.store.setEnabled("google.com", false);
  expect(await s.service.setEnabled("google.com", true)).toBe(true);
  expect(s.seeds).toEqual([
    {
      key: "w1",
      state: {
        cookies: google.cookies,
        origins: [
          {
            origin: "https://google.com",
            localStorage: [{ name: "k", value: "v" }],
          },
        ],
      },
    },
  ]);
});
