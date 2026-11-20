import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  activateConnection,
  createConnection,
  createCredential,
  deactivateConnection,
  deleteConnection,
  deleteCredential,
  getConnection,
  getConnectionLog,
  listConnections,
  listCredentials,
  trustHostKey,
  updateConnection,
} from "./connections";
import { ApiError } from "./http";

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

test("listConnections / getConnection：GET 路径与 Bearer，id 会被转义", async () => {
  fetchMock.mockImplementation(async () => reply(200, { connections: [] }));
  await listConnections("tok");
  expect(lastCall()).toMatchObject({
    path: "/api/v1/connections",
    method: "GET",
    auth: "Bearer tok",
  });
  await getConnection(null, "a/b");
  expect(lastCall().path).toBe("/api/v1/connections/a%2Fb");
});

test("create / update / delete 的方法、路径与 body", async () => {
  fetchMock.mockImplementation(async () => reply(200, {}));
  await createConnection(null, {
    label: "N",
    host: "h",
    port: 22,
    user: "u",
    auth: { secretId: "s1" },
  });
  expect(lastCall()).toMatchObject({
    path: "/api/v1/connections",
    method: "POST",
    body: { label: "N", auth: { secretId: "s1" } },
  });
  await updateConnection(null, "c1", { jump: ["j1"] });
  expect(lastCall()).toMatchObject({
    path: "/api/v1/connections/c1",
    method: "PATCH",
    body: { jump: ["j1"] },
  });
  fetchMock.mockImplementation(async () => reply(204));
  await deleteConnection(null, "c1");
  expect(lastCall()).toMatchObject({
    path: "/api/v1/connections/c1",
    method: "DELETE",
  });
});

test("activate / deactivate / trust 指向各自的子路径", async () => {
  fetchMock.mockImplementation(async () => reply(202, {}));
  await activateConnection(null, "c1");
  expect(lastCall()).toMatchObject({
    path: "/api/v1/connections/c1/activate",
    method: "POST",
  });
  await deactivateConnection(null, "c1");
  expect(lastCall().path).toBe("/api/v1/connections/c1/deactivate");
  await trustHostKey(null, "c1");
  expect(lastCall().path).toBe("/api/v1/connections/c1/trust");
});

test("getConnectionLog：limit 与 before 进查询串，缺省时不带", async () => {
  fetchMock.mockImplementation(async () =>
    reply(200, { log: [], nextBefore: null }),
  );
  await getConnectionLog(null, "c1");
  expect(lastCall().path).toBe("/api/v1/connections/c1/log");
  await getConnectionLog(null, "c1", { limit: 50, before: 7 });
  expect(lastCall().path).toBe("/api/v1/connections/c1/log?limit=50&before=7");
});

test("激活 409 的 error 与附带字段可从 ApiError 读出", async () => {
  fetchMock.mockImplementation(async () =>
    reply(409, { error: "jump_inactive", jump: { id: "j", label: "跳板" } }),
  );
  const err = await activateConnection(null, "c1").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(409);
  expect(err.code).toBe("jump_inactive");
  expect(err.body.jump.label).toBe("跳板");
});

test("凭据：列表解开 secrets 外壳；新建与删除", async () => {
  fetchMock.mockImplementation(async () =>
    reply(200, { secrets: [{ id: "k1", name: "k", referencedBy: [] }] }),
  );
  expect(await listCredentials(null)).toHaveLength(1);
  expect(lastCall().path).toBe("/api/v1/secrets");
  fetchMock.mockImplementation(async () => reply(201, { id: "k2" }));
  await createCredential(null, { name: "k", kind: "ssh_key", value: "pem" });
  expect(lastCall()).toMatchObject({
    method: "POST",
    body: { name: "k", kind: "ssh_key", value: "pem" },
  });
  fetchMock.mockImplementation(async () => reply(204));
  await deleteCredential(null, "k2");
  expect(lastCall()).toMatchObject({
    path: "/api/v1/secrets/k2",
    method: "DELETE",
  });
});
