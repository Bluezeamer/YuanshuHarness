import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "./http";
import {
  configErrorCode,
  conflictOf,
  patchSessionConfig,
} from "./sessionConfig";
import { listLibrary, sessionAction } from "./sessionLibrary";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("列表：status 逗号拼接，q 进查询串，空条件不带问号", async () => {
  fetchMock.mockImplementation(async () => json({ sessions: [] }));
  await listLibrary("t");
  await listLibrary("t", {
    status: ["running", "blocked"],
    q: "a b",
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions");
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    "/api/v1/sessions?status=running%2Cblocked&q=a+b",
  );
});

test("动作走 POST /:id/<action>", async () => {
  fetchMock.mockImplementation(async () => json({ id: "s" }));
  await sessionAction("t", "s 1", "archive");
  const calls = fetchMock.mock.calls as [string, RequestInit][];
  expect(calls[0]?.[0]).toBe("/api/v1/sessions/s%201/archive");
  expect(calls[0]?.[1].method).toBe("POST");
});

test("归档运行中的会话：抛 ApiError，code 为 session_running", async () => {
  fetchMock.mockImplementation(async () =>
    json({ error: "session_running" }, 409),
  );
  const err = await sessionAction("t", "s", "archive").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("session_running");
});

test("配置 PATCH 带 baseRev 与 patch；409 带回当前值可被取出，400 取出可读码", async () => {
  fetchMock.mockImplementation(async () =>
    json({ config: { rev: 2 }, appliedAt: "now" }),
  );
  const r = await patchSessionConfig("t", "s", 1, { permissionTier: "full" });
  expect(r.appliedAt).toBe("now");
  const body = JSON.parse(
    String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
  );
  expect(body).toEqual({ baseRev: 1, patch: { permissionTier: "full" } });

  fetchMock.mockImplementation(async () =>
    json({ error: "conflict", current: { rev: 5 } }, 409),
  );
  const conflict = await patchSessionConfig("t", "s", 1, {}).catch((e) => e);
  expect(conflictOf(conflict)).toEqual({ rev: 5 });

  fetchMock.mockImplementation(async () =>
    json({ error: "unknown_model" }, 400),
  );
  const bad = await patchSessionConfig("t", "s", 1, {}).catch((e) => e);
  expect(configErrorCode(bad)).toBe("unknown_model");
  expect(conflictOf(bad)).toBeNull();
});
