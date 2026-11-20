import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "./http";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  getWorkspaceLayout,
  listWorkspaces,
  patchWorkspace,
  previewDirectories,
  putWorkspaceLayout,
  reorderWorkspaces,
  setDirectories,
  workspaceRemovalPreview,
} from "./workspaces";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const calls = () => fetchMock.mock.calls as [string, RequestInit][];
const bodyOf = (i: number) => JSON.parse(String(calls()[i]?.[1].body));

const ws = { id: "w", name: "w", directories: [] };
const noContent = () => new Response(null, { status: 204 });

test("读取类走 GET：列表取 workspaces，单个与预览按 id 编码路径", async () => {
  fetchMock.mockImplementation(async () => json({ workspaces: [ws] }));
  expect(await listWorkspaces("t")).toEqual([ws]);

  fetchMock.mockImplementation(async () => json(ws));
  await getWorkspace("t", "w 1");
  fetchMock.mockImplementation(async () =>
    json({ running: false, sessions: 0, terminals: 0, directories: [] }),
  );
  await workspaceRemovalPreview("t", "w 1");

  expect(calls()[0]?.[0]).toBe("/api/v1/workspaces");
  expect(calls()[1]?.[0]).toBe("/api/v1/workspaces/w%201");
  expect(calls()[2]?.[0]).toBe("/api/v1/workspaces/w%201/removal-preview");
  expect(calls().every((c) => (c[1].method ?? "GET") === "GET")).toBe(true);
});

test("createWorkspace 对 200 与 201 都返回工作区", async () => {
  const input = { directories: [{ path: "/a" }], name: "A" };
  fetchMock.mockImplementation(async () => json(ws, 201));
  expect(await createWorkspace("t", input)).toEqual(ws);
  fetchMock.mockImplementation(async () => json(ws, 200));
  expect(await createWorkspace("t", input)).toEqual(ws);
  expect(calls()[0]?.[0]).toBe("/api/v1/workspaces");
  expect(calls()[0]?.[1].method).toBe("POST");
  expect(bodyOf(0)).toEqual(input);
});

test("patch / reorder / delete 的方法、路径与请求体", async () => {
  fetchMock.mockImplementation(async () => json(ws));
  await patchWorkspace("t", "w 1", { groupId: null, archived: true });
  fetchMock.mockImplementation(async () => noContent());
  await reorderWorkspaces("t", ["b", "a"]);
  await deleteWorkspace("t", "w 1");

  expect(calls()[0]?.[0]).toBe("/api/v1/workspaces/w%201");
  expect(calls()[0]?.[1].method).toBe("PATCH");
  expect(bodyOf(0)).toEqual({ groupId: null, archived: true });
  expect(calls()[1]?.[0]).toBe("/api/v1/workspaces/reorder");
  expect(calls()[1]?.[1].method).toBe("PUT");
  expect(bodyOf(1)).toEqual({ ids: ["b", "a"] });
  expect(calls()[2]?.[0]).toBe("/api/v1/workspaces/w%201");
  expect(calls()[2]?.[1].method).toBe("DELETE");
});

test("删除运行中有会话的工作区：409 抛 ApiError，code 为 session_running", async () => {
  fetchMock.mockImplementation(async () =>
    json({ error: "session_running" }, 409),
  );
  const err = await deleteWorkspace("t", "w").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("session_running");
});

test("目录预览带 dryRun，写入预览与落盘走同一路径", async () => {
  fetchMock.mockImplementation(async () => json({ added: [], removed: [] }));
  const input = [{ path: "/b" }, { environmentId: "e", path: "/c" }];
  await previewDirectories("t", "w 1", input);
  fetchMock.mockImplementation(async () => json(ws));
  expect(await setDirectories("t", "w 1", input)).toEqual(ws);

  expect(calls()[0]?.[0]).toBe("/api/v1/workspaces/w%201/directories");
  expect(calls()[0]?.[1].method).toBe("PUT");
  expect(bodyOf(0)).toEqual({ directories: input, dryRun: true });
  expect(bodyOf(1)).toEqual({ directories: input });
});

test("布局读取把缺失的 document 归一成 null", async () => {
  fetchMock.mockImplementation(async () => json({ revision: 0 }));
  expect(await getWorkspaceLayout("t", "w 1")).toEqual({
    revision: 0,
    document: null,
  });
  expect(calls()[0]?.[0]).toBe("/api/v1/workspaces/w%201/layout");
});

test("布局写入：成功、409 带回当前值、网络失败、keepalive 透传", async () => {
  fetchMock.mockImplementation(async () => json({ revision: 3 }));
  expect(await putWorkspaceLayout("t", "w 1", 2, { a: 1 })).toEqual({
    ok: true,
    revision: 3,
  });
  expect(calls()[0]?.[0]).toBe("/api/v1/workspaces/w%201/layout");
  expect(bodyOf(0)).toEqual({ baseRevision: 2, document: { a: 1 } });

  fetchMock.mockImplementation(async () =>
    json({ revision: 7, document: null }, 409),
  );
  expect(await putWorkspaceLayout("t", "w 1", 2, { a: 1 })).toEqual({
    ok: false,
    kind: "conflict",
    current: { revision: 7, document: null },
  });

  fetchMock.mockImplementation(async () => {
    throw new Error("offline");
  });
  expect(await putWorkspaceLayout("t", "w 1", 2, { a: 1 })).toEqual({
    ok: false,
    kind: "network",
  });

  fetchMock.mockImplementation(async () => json({ revision: 4 }));
  await putWorkspaceLayout("t", "w 1", 3, { a: 1 }, true);
  expect(calls()[3]?.[1].keepalive).toBe(true);
});
