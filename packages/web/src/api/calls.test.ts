import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getCall, getCompactions, getUsage, listCalls } from "./calls";

const fetchMock = vi.fn();
const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

test("listCalls：路径、分页参数与 Bearer 头；缺省不带查询串", async () => {
  fetchMock.mockResolvedValue(reply(200, { calls: [], nextBefore: 7 }));
  const r = await listCalls("tok", "s/1", { before: 9, limit: 100 });
  expect(r).toEqual({ ok: true, data: { calls: [], nextBefore: 7 } });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/v1/sessions/s%2F1/calls?before=9&limit=100");
  expect((init.headers as Record<string, string>).Authorization).toBe(
    "Bearer tok",
  );
  await listCalls(null, "s1");
  expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/sessions/s1/calls");
});

test("listCalls：nextBefore 缺省补 null；形状不对按服务端错误处理", async () => {
  fetchMock.mockResolvedValueOnce(reply(200, { calls: [] }));
  expect(await listCalls(null, "s1")).toEqual({
    ok: true,
    data: { calls: [], nextBefore: null },
  });
  fetchMock.mockResolvedValueOnce(reply(200, { nope: 1 }));
  expect(await listCalls(null, "s1")).toEqual({ ok: false, kind: "server" });
});

test("getCall：详情路径；404 → not_found；网络失败 → network", async () => {
  fetchMock.mockResolvedValueOnce(reply(200, { id: "c1", request: {} }));
  const r = await getCall(null, "s1", "c1");
  expect(r.ok && r.data.id).toBe("c1");
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions/s1/calls/c1");
  fetchMock.mockResolvedValueOnce(reply(404, { error: "not_found" }));
  expect(await getCall(null, "s1", "x")).toEqual({
    ok: false,
    kind: "not_found",
  });
  fetchMock.mockRejectedValueOnce(new TypeError("offline"));
  expect(await getCall(null, "s1", "x")).toEqual({
    ok: false,
    kind: "network",
  });
});

test("getUsage：原样返回聚合对象", async () => {
  const usage = { turns: 1, steps: 2, context: null };
  fetchMock.mockResolvedValue(reply(200, usage));
  expect(await getUsage(null, "s1")).toEqual({ ok: true, data: usage });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions/s1/usage");
});

test("getCompactions：路径与压缩历史列表；形状不对按服务端错误处理", async () => {
  const compactions = [
    {
      seq: 1,
      createdAt: "2026-10-25T09:00:00.000Z",
      summary: "摘要",
      tokensBefore: 8000,
      callSeqFrom: 1,
      callSeqTo: 4,
      messageCount: 6,
    },
  ];
  fetchMock.mockResolvedValueOnce(reply(200, { compactions }));
  expect(await getCompactions(null, "s1")).toEqual({
    ok: true,
    data: compactions,
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions/s1/compactions");
  fetchMock.mockResolvedValueOnce(reply(200, { nope: 1 }));
  expect(await getCompactions("tok", "s1")).toEqual({
    ok: false,
    kind: "server",
  });
});
