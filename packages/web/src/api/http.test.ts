import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ApiError,
  call,
  clearToken,
  get,
  loadToken,
  request,
  saveToken,
  setUnauthorizedHandler,
  subprotocols,
} from "./http";

const fetchMock = vi.fn();
const reply = (status: number, body: unknown = {}, headers = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers,
  });

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

test("令牌只进 sessionStorage，可读可清", () => {
  expect(loadToken()).toBeNull();
  saveToken("tok");
  expect(loadToken()).toBe("tok");
  expect(localStorage.length).toBe(0);
  clearToken();
  expect(loadToken()).toBeNull();
});

test("get：带 Bearer 头；无令牌不带 Authorization", async () => {
  fetchMock.mockResolvedValue(reply(200, { n: 1 }));
  await get("/x", "tok", (b: { n: number }) => b.n);
  await get("/x", null, (b: { n: number }) => b.n);
  expect(fetchMock.mock.calls[0]?.[1].headers).toEqual({
    Authorization: "Bearer tok",
  });
  expect(fetchMock.mock.calls[1]?.[1].headers).toEqual({});
});

test("get：状态码映射到统一失败类型", async () => {
  fetchMock.mockResolvedValueOnce(reply(401));
  expect(await get("/x", "t", () => 0)).toEqual({
    ok: false,
    kind: "unauthorized",
  });
  fetchMock.mockResolvedValueOnce(reply(403));
  expect(await get("/x", "t", () => 0)).toEqual({
    ok: false,
    kind: "forbidden",
  });
  fetchMock.mockResolvedValueOnce(reply(429, {}, { "Retry-After": "7" }));
  expect(await get("/x", "t", () => 0)).toEqual({
    ok: false,
    kind: "rate_limited",
    retryAfter: 7,
  });
  fetchMock.mockResolvedValueOnce(reply(500));
  expect(await get("/x", "t", () => 0)).toEqual({ ok: false, kind: "server" });
  fetchMock.mockRejectedValueOnce(new Error("down"));
  expect(await get("/x", "t", () => 0)).toEqual({
    ok: false,
    kind: "network",
  });
});

test("get：pick 抛错按 server 处理", async () => {
  fetchMock.mockResolvedValue(reply(200, {}));
  const r = await get("/x", "t", () => {
    throw new Error("shape");
  });
  expect(r).toEqual({ ok: false, kind: "server" });
});

test("call：400/404/409 有各自的失败类，204 成功且无数据", async () => {
  for (const [status, kind] of [
    [400, "bad_request"],
    [404, "not_found"],
    [409, "conflict"],
  ] as const) {
    fetchMock.mockResolvedValueOnce(reply(status));
    expect(await call("POST", "/x", "t", {}, () => 0)).toEqual({
      ok: false,
      kind,
    });
  }
  fetchMock.mockResolvedValueOnce(reply(204));
  expect(await call("DELETE", "/x", "t", undefined, () => 0)).toEqual({
    ok: true,
    data: undefined,
  });
});

test("call：有请求体时发 JSON，无请求体时不带 Content-Type", async () => {
  fetchMock.mockResolvedValue(reply(200, {}));
  await call("PUT", "/x", "t", { a: 1 }, () => 0);
  await call("POST", "/x", "t", undefined, () => 0);
  const withBody = fetchMock.mock.calls[0]?.[1];
  expect(withBody.headers["Content-Type"]).toBe("application/json");
  expect(withBody.body).toBe('{"a":1}');
  expect(fetchMock.mock.calls[1]?.[1].headers["Content-Type"]).toBeUndefined();
});

test("request：失败抛 ApiError，带 status 与服务端错误体，可取错误码", async () => {
  fetchMock.mockResolvedValueOnce(reply(409, { error: "name_taken" }));
  const e = await request("POST", "/x", "t", {}).catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBe(409);
  expect(e.code).toBe("name_taken");

  fetchMock.mockResolvedValueOnce(reply(400, { error: { code: "bad_name" } }));
  const e2 = await request("POST", "/x", "t", {}).catch((x) => x);
  expect(e2.code).toBe("bad_name");
});

test("request：网络失败 status 为 0；非 JSON 错误体为 null", async () => {
  fetchMock.mockRejectedValueOnce(new Error("down"));
  const e = await request("GET", "/x", "t").catch((x) => x);
  expect([e.status, e.body, e.code]).toEqual([0, null, null]);

  fetchMock.mockResolvedValueOnce(new Response("oops", { status: 502 }));
  const e2 = await request("GET", "/x", "t").catch((x) => x);
  expect([e2.status, e2.body]).toEqual([502, null]);
});

test("request：成功返回 JSON，204 返回 undefined", async () => {
  fetchMock.mockResolvedValueOnce(reply(200, { a: 1 }));
  expect(await request("GET", "/x", "t")).toEqual({ a: 1 });
  fetchMock.mockResolvedValueOnce(reply(204));
  expect(await request("DELETE", "/x", "t")).toBeUndefined();
});

test("request：401 触发已注册的未授权回调，且仍抛错", async () => {
  const onUnauthorized = vi.fn();
  setUnauthorizedHandler(onUnauthorized);
  fetchMock.mockResolvedValueOnce(reply(401, { error: "unauthorized" }));
  await expect(request("GET", "/x", "t")).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);

  setUnauthorizedHandler(null);
  fetchMock.mockResolvedValueOnce(reply(401));
  await expect(request("GET", "/x", "t")).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});

test("subprotocols：WebSocket 令牌走第二个子协议", () => {
  expect(subprotocols(null)).toEqual(["yuanshu.v1"]);
  expect(subprotocols("tok")).toEqual(["yuanshu.v1", "bearer.tok"]);
});
