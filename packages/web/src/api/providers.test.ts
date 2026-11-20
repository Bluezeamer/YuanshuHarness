import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "./http";
import {
  createProvider,
  deleteProvider,
  getModelsJson,
  listProviders,
  probeModels,
  testProvider,
  updateProvider,
} from "./providers";

const fetchMock = vi.fn();
const reply = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const lastCall = () => {
  const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    path,
    method: init.method,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    auth: (init.headers as Record<string, string>).Authorization,
  };
};

test("listProviders：GET 并解开 providers 外壳，带 Bearer", async () => {
  fetchMock.mockImplementation(async () =>
    reply(200, { providers: [{ id: "a" }] }),
  );
  expect(await listProviders("tok")).toEqual([{ id: "a" }]);
  expect(lastCall()).toMatchObject({
    path: "/api/v1/providers",
    method: "GET",
    auth: "Bearer tok",
  });
});

test("createProvider / updateProvider / deleteProvider 的方法、路径与 body", async () => {
  fetchMock.mockImplementation(async () => reply(200, {}));
  await createProvider(null, {
    name: "N",
    slug: "n",
    api: "openai-completions",
    baseUrl: "http://x/v1",
  });
  expect(lastCall()).toMatchObject({
    path: "/api/v1/providers",
    method: "POST",
    body: { slug: "n", api: "openai-completions" },
  });

  await updateProvider(null, "a/b", { baseUrl: null, apiKey: null });
  expect(lastCall()).toMatchObject({
    path: "/api/v1/providers/a%2Fb",
    method: "PATCH",
    body: { baseUrl: null, apiKey: null },
  });

  fetchMock.mockImplementation(async () => reply(204));
  await deleteProvider(null, "n");
  expect(lastCall()).toMatchObject({
    path: "/api/v1/providers/n",
    method: "DELETE",
  });
});

test("probeModels / testProvider / getModelsJson", async () => {
  fetchMock.mockImplementation(async () => reply(200, { ids: ["x"] }));
  expect(await probeModels(null, "p")).toEqual({ ids: ["x"] });
  expect(lastCall()).toMatchObject({
    path: "/api/v1/providers/p/models/probe",
    method: "POST",
  });

  fetchMock.mockImplementation(async () => reply(200, { ok: true }));
  await testProvider(null, "p", "m1");
  expect(lastCall()).toMatchObject({
    path: "/api/v1/providers/p/test",
    method: "POST",
    body: { model: "m1" },
  });
  await testProvider(null, "p");
  expect(lastCall().body).toBeUndefined();

  fetchMock.mockImplementation(async () => reply(200, { path: "/m.json" }));
  await getModelsJson(null);
  expect(lastCall()).toMatchObject({
    path: "/api/v1/models-json",
    method: "GET",
  });
});

test("错误响应抛 ApiError，code 取自 {error}", async () => {
  fetchMock.mockImplementation(async () => reply(409, { error: "slug_taken" }));
  const e = await createProvider(null, {
    name: "N",
    slug: "n",
    api: "openai-completions",
    baseUrl: "http://x/v1",
  }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).status).toBe(409);
  expect((e as ApiError).code).toBe("slug_taken");
});
