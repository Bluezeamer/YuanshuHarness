// 登录态管理接口：列出、开关、删一个、清空；不存在的站点 404、参数不对 400，响应里没有状态内容。
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { LoginService } from "../browser/login/login.js";
import { BrowserLoginStore } from "../store/browser-logins.js";
import { type Db, openDatabase } from "../store/db.js";
import { browserLoginsApi } from "./browser-logins.js";

const SECRET = "COOKIE_VALUE_MUST_NOT_LEAK";

let app: FastifyInstance;
let store: BrowserLoginStore;

beforeEach(async () => {
  const db: Db = openDatabase(makeTmpDir("yuanshu-logins-api-"));
  store = new BrowserLoginStore(db, randomBytes(32));
  store.put("github.com", {
    cookies: [
      {
        name: "sid",
        value: SECRET,
        domain: ".github.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://github.com",
        localStorage: [{ name: "token", value: SECRET }],
      },
    ],
  });
  const login = new LoginService({
    store,
    stateOf: async () => null,
    liveKeys: () => [],
    seed: async () => {},
  });
  app = Fastify();
  await app.register(browserLoginsApi, { login });
});

const list = () => app.inject({ method: "GET", url: "/api/v1/browser/logins" });
const patch = (site: string, body: unknown) =>
  app.inject({
    method: "PATCH",
    url: `/api/v1/browser/logins/${site}`,
    payload: body as never,
  });
const del = (site: string) =>
  app.inject({ method: "DELETE", url: `/api/v1/browser/logins/${site}` });
const clear = () =>
  app.inject({ method: "DELETE", url: "/api/v1/browser/logins" });

test("列出：只有元信息，没有状态内容", async () => {
  const r = await list();
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({
    logins: [
      {
        site: "github.com",
        enabled: true,
        savedAt: expect.any(String),
        cookies: 1,
        origins: 1,
      },
    ],
  });
  expect(r.body).not.toContain(SECRET);
});

test("开关：200 返回站点与状态；站点不存在 404；enabled 不是布尔 400", async () => {
  const off = await patch("github.com", { enabled: false });
  expect(off.statusCode).toBe(200);
  expect(off.json()).toEqual({ site: "github.com", enabled: false });
  expect(store.list()[0]?.enabled).toBe(false);
  expect((await patch("github.com", { enabled: true })).json()).toEqual({
    site: "github.com",
    enabled: true,
  });

  expect((await patch("nope.com", { enabled: false })).statusCode).toBe(404);
  for (const body of [{}, { enabled: "yes" }, { enabled: 1 }])
    expect((await patch("github.com", body)).statusCode).toBe(400);
  expect((await patch("github.com", { enabled: 1 })).json()).toEqual({
    error: "bad_request",
  });
});

test("删一个：204；再删 404", async () => {
  const r = await del("github.com");
  expect(r.statusCode).toBe(204);
  expect(store.list()).toEqual([]);
  expect((await del("github.com")).statusCode).toBe(404);
});

test("清空：返回删了几个站点", async () => {
  store.put("gitlab.com", { cookies: [], origins: [] });
  const r = await clear();
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ removed: 2 });
  expect(store.list()).toEqual([]);
  expect((await clear()).json()).toEqual({ removed: 0 });
});

test("所有响应体里都搜不到保存过的状态内容", async () => {
  const bodies = [
    await list(),
    await patch("github.com", { enabled: false }),
    await del("github.com"),
    await clear(),
  ];
  for (const r of bodies) expect(r.body).not.toContain(SECRET);
});
